import { createHash, randomUUID } from "node:crypto";

import {
  assertTrendRange,
  canonicalIanaTimeZone,
  canonicalRetentionDecimal,
  decimal,
  deriveDiaryLocalCoordinates,
  type IsoWeekday,
  type NutrientCompleteness,
  nextReminderOccurrence,
  type UnknownNutrientReason,
} from "@nutrition-tracker/domain";
import { type Kysely, type QueryResult, type Selectable, sql, type Transaction } from "kysely";

import { PasswordCredentialStaleError } from "./accounts.js";
import type { Database, JsonObject, JsonValue } from "./types.js";

export type RetentionPersistenceErrorCode =
  | "CONSENT_REQUIRED"
  | "EXPORT_IN_PROGRESS"
  | "EXPORT_NOT_READY"
  | "EXPORT_TOO_LARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "IMPORT_CONFLICT"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "VALIDATION";

export class RetentionPersistenceError extends Error {
  constructor(
    readonly code: RetentionPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class RetentionNotFoundError extends RetentionPersistenceError {
  constructor() {
    super("NOT_FOUND", "Resource was not found");
  }
}
export class RetentionValidationError extends RetentionPersistenceError {
  constructor(message = "Retention request is invalid") {
    super("VALIDATION", message);
  }
}
export class RetentionRevisionConflictError extends RetentionPersistenceError {
  constructor() {
    super("REVISION_CONFLICT", "The resource changed since it was read");
  }
}
export class RetentionIdempotencyConflictError extends RetentionPersistenceError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "The operation key was already used for another request");
  }
}
export class RetentionImportConflictError extends RetentionPersistenceError {
  constructor() {
    super("IMPORT_CONFLICT", "Provider revision conflicts with previously imported evidence");
  }
}
export class RetentionConsentRequiredError extends RetentionPersistenceError {
  constructor() {
    super("CONSENT_REQUIRED", "Active reminder consent is required");
  }
}
export class RetentionExportNotReadyError extends RetentionPersistenceError {
  constructor() {
    super("EXPORT_NOT_READY", "Privacy export has not passed reconciliation");
  }
}
export class RetentionExportInProgressError extends RetentionPersistenceError {
  constructor() {
    super("EXPORT_IN_PROGRESS", "A retryable privacy export already exists");
  }
}
export class RetentionExportTooLargeError extends RetentionPersistenceError {
  constructor() {
    super("EXPORT_TOO_LARGE", "Privacy export exceeds the configured snapshot byte ceiling");
  }
}

export const MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES = 10 * 1_024 * 1_024 * 1_024;
export const MAX_ACTIVE_REMINDER_OCCURRENCES = 64;
export const MAX_NON_REVOKED_REMINDER_SCHEDULES = 100;

export interface RetentionOperationInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
}

export interface RetentionRetryDisposition {
  readonly attemptCount: number;
  readonly retryScheduled: boolean;
  readonly deadLettered: boolean;
}

export interface RequeueDeadLetteredRetentionJobInput {
  readonly jobId: string;
  /** Digest of the external operator approval/ticket; the underlying evidence stays out of DB. */
  readonly approvalDigest: string;
  readonly requeuedAt: string;
}
export interface RequeueDeadLetteredRetentionCleanupInput {
  readonly artifactId: string;
  /** Digest of the external operator approval/ticket; the underlying evidence stays out of DB. */
  readonly approvalDigest: string;
  readonly requeuedAt: string;
}
export interface RetentionRecoveryRecord {
  readonly targetId: string;
  readonly recoveryKind:
    | "account_erasure"
    | "artifact_deletion"
    | "privacy_export"
    | "staged_artifact_deletion";
  readonly requeuedAt: string;
}
export interface RetentionDeadLetterRecord {
  readonly id: string;
  readonly recoveryKind: RetentionRecoveryRecord["recoveryKind"];
  readonly targetId: string;
  readonly attemptCount: 20;
  readonly occurredAt: string;
}
export type RetentionWorkLeaseKind =
  | "account_erasure"
  | "artifact_deletion"
  | "privacy_export"
  | "staged_artifact_deletion";
export interface RenewRetentionWorkLeaseInput {
  readonly kind: RetentionWorkLeaseKind;
  readonly targetId: string;
  readonly workerId: string;
  readonly renewedAt: string;
}

export interface TrendNutrientRecord {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: NutrientCompleteness;
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: Readonly<Partial<Record<UnknownNutrientReason, number>>>;
}
export interface NutrientTrendDayRecord {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly diaryId: string | null;
  readonly diaryRevision: string | null;
  readonly totalEntries: number;
  readonly timeZones: readonly string[];
  readonly nutrients: readonly TrendNutrientRecord[];
}
export interface NutrientTrendPointRecord {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly aggregate: TrendNutrientRecord | null;
}
export interface NutrientTrendSeriesRecord {
  readonly nutrient: Pick<TrendNutrientRecord, "nutrientId" | "code" | "name" | "unit">;
  readonly timeZone: string;
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
  readonly watermarkRevision: string;
  readonly points: readonly NutrientTrendPointRecord[];
}
export interface NutrientTrendRecord {
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
  readonly profileTimeZone: string;
  readonly watermarkRevision: string;
  readonly definitions: readonly Pick<
    TrendNutrientRecord,
    "nutrientId" | "code" | "name" | "unit"
  >[];
  readonly days: readonly NutrientTrendDayRecord[];
}
export interface GetNutrientTrendsInput {
  readonly userId: string;
  readonly nutrientIds: readonly string[];
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
}
export interface GetNutrientTrendInput {
  readonly userId: string;
  readonly nutrientId: string;
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
}

export type CustomFoodValueStatus = "calculated" | "estimated" | "label" | "measured" | "trace";
export interface CustomFoodDraft {
  readonly name: string;
  readonly brandName: string | null;
  readonly serving: {
    readonly label: string;
    readonly grams: string;
  } | null;
  readonly nutrients: readonly (
    | {
        readonly nutrientId: string;
        readonly state: "quantified";
        readonly amountPer100Grams: string;
      }
    | { readonly nutrientId: string; readonly state: "trace"; readonly amountPer100Grams: null }
    | {
        readonly nutrientId: string;
        readonly state: "unknown";
        readonly amountPer100Grams: null;
        readonly reason: UnknownNutrientReason;
      }
  )[];
  readonly notes: string | null;
}
export interface CustomFoodRecord {
  readonly id: string;
  readonly foodId: string;
  readonly currentRevision: string;
  readonly status: "active" | "archived";
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: string;
    readonly name: string;
    readonly brandName: string | null;
    readonly notes: string | null;
    readonly serving: {
      readonly id: string;
      readonly label: string;
      readonly grams: string;
    } | null;
    readonly nutrients: readonly {
      readonly nutrient: {
        readonly id: string;
        readonly code: string;
        readonly name: string;
        readonly unit: string;
      };
      readonly state: "quantified" | "trace" | "unknown";
      readonly amountPer100Grams: string | null;
      readonly reason: UnknownNutrientReason | null;
      readonly provenance: string;
    }[];
    readonly createdAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CreateCustomFoodInput extends RetentionOperationInput {
  readonly food: CustomFoodDraft;
}
export interface ReviseCustomFoodInput extends RetentionOperationInput {
  readonly customFoodId: string;
  readonly expectedRevision: bigint | number | string;
  readonly food: CustomFoodDraft;
}
export interface ArchiveCustomFoodInput extends RetentionOperationInput {
  readonly customFoodId: string;
  readonly expectedRevision: bigint | number | string;
}
export interface CustomFoodMutationResult {
  readonly food: CustomFoodRecord;
  readonly replayed: boolean;
}
export interface CustomFoodListRecord {
  readonly records: readonly CustomFoodRecord[];
  readonly nextCursor: string | null;
}

export type BiometricDimension = "count" | "duration" | "length" | "mass" | "other" | "temperature";
export interface BiometricDefinitionDraft {
  readonly name: string;
  readonly canonicalUnit: string;
  readonly dimension: BiometricDimension;
  readonly notes: string | null;
}
export interface BiometricDefinitionRevisionDraft {
  readonly name: string;
  readonly notes: string | null;
}
export interface BiometricDefinitionRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly status: "active" | "archived";
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: string;
    readonly code: string;
    readonly name: string;
    readonly canonicalUnit: string;
    readonly dimension: BiometricDimension;
    readonly minimumValue: string | null;
    readonly maximumValue: string | null;
    readonly notes: string | null;
    readonly metadata: JsonObject;
    readonly createdAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CreateBiometricDefinitionInput extends RetentionOperationInput {
  readonly definition: BiometricDefinitionDraft;
}
export interface ReviseBiometricDefinitionInput extends RetentionOperationInput {
  readonly definitionId: string;
  readonly expectedRevision: bigint | number | string;
  readonly definition: BiometricDefinitionRevisionDraft;
}
export interface ArchiveBiometricDefinitionInput extends RetentionOperationInput {
  readonly definitionId: string;
  readonly expectedRevision: bigint | number | string;
}
export interface BiometricDefinitionMutationResult {
  readonly definition: BiometricDefinitionRecord;
  readonly replayed: boolean;
}

export interface BiometricEventRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly operation: "create" | "delete" | "update";
  readonly definitionVersionId: string;
  readonly definition: { readonly id: string; readonly code: string; readonly name: string };
  readonly value: string;
  readonly unit: string;
  readonly measuredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly source: {
    readonly kind: "device" | "manual" | "platform";
    readonly deviceId: string | null;
    readonly provider: string | null;
    readonly externalSourceId: string | null;
    readonly externalRevision: string | null;
    readonly rawDigest: string | null;
    readonly provenance: JsonObject;
  };
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}
export interface RecordBiometricEventInput extends RetentionOperationInput {
  readonly definitionId: string;
  readonly value: string;
  readonly measuredAt: string;
  readonly note?: string | null;
  readonly provenance?: JsonObject;
}
export interface ReviseBiometricEventInput extends RetentionOperationInput {
  readonly eventId: string;
  readonly expectedRevision: bigint | number | string;
  readonly value?: string;
  readonly measuredAt?: string;
  readonly note?: string | null;
}
export interface DeleteBiometricEventInput extends RetentionOperationInput {
  readonly eventId: string;
  readonly expectedRevision: bigint | number | string;
}
export interface BiometricEventMutationResult {
  readonly event: BiometricEventRecord | null;
  readonly replayed: boolean;
}
export interface BiometricEventListRecord {
  readonly records: readonly BiometricEventRecord[];
  readonly nextCursor: string | null;
}
export interface BiometricTrendPointRecord {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly count: number;
  readonly first: string;
  readonly last: string;
  readonly minimum: string;
  readonly maximum: string;
}
export interface BiometricTrendRecord {
  readonly definition: BiometricDefinitionRecord;
  readonly timeZone: string;
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
  readonly points: readonly BiometricTrendPointRecord[];
}

export interface ReminderConsentRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly status: "granted" | "revoked";
  readonly policyVersion: string;
  readonly reason: string | null;
  readonly occurredAt: string;
}
export interface ChangeReminderConsentInput extends RetentionOperationInput {
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly reason?: string | null;
}
export interface ReminderScheduleDraft {
  readonly label: string;
  readonly channel: "local";
  readonly timeZone: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  /** Test/worker clock override; public callers omit it and use the DB clock. */
  readonly after?: string;
  readonly consentGranted?: true;
  readonly status?: "active" | "paused";
}
export interface ReminderScheduleRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly status: "active" | "paused" | "revoked";
  readonly currentVersionId: string;
  readonly label: string;
  readonly channel: "local";
  readonly timeZone: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly dstPolicy: "earliest_offset_skip_gap";
  readonly consent: {
    readonly policyVersion: "local-reminders-v1";
    readonly grantedAt: string;
    readonly revokedAt: string | null;
  };
  readonly deliveryPolicy: {
    readonly title: "Nutrition Tracker";
    readonly lockScreenText: "Time to check in.";
    readonly includesHealthDetails: false;
  };
  readonly nextDeliveryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}
export interface CreateReminderScheduleInput extends RetentionOperationInput {
  readonly schedule: ReminderScheduleDraft;
}
export interface ReviseReminderScheduleInput extends RetentionOperationInput {
  readonly scheduleId: string;
  readonly expectedRevision: bigint | number | string;
  readonly schedule: ReminderScheduleDraft;
}
export interface RevokeReminderScheduleInput extends RetentionOperationInput {
  readonly scheduleId: string;
  readonly expectedRevision: bigint | number | string;
  readonly occurredAt?: string;
}
export interface ReminderScheduleMutationResult {
  readonly schedule: ReminderScheduleRecord;
  readonly replayed: boolean;
}
export interface ClaimedReminderDeliveryRecord {
  readonly id: string;
  readonly scheduleId: string;
  readonly deviceId: string | null;
  readonly scheduledFor: string;
  readonly notificationTitle: "Nutrition Tracker";
  readonly notificationBody: "Time to check in.";
  readonly attemptCount: number;
}

export interface DeviceRegistrationRecord {
  readonly id: string;
  readonly revision: string;
  readonly platform: HealthPlatform;
  readonly displayName: string;
  readonly publicKeySpkiBase64: string;
  readonly keyFingerprint: string;
  readonly keyAlgorithm: "ES256";
  readonly status: "active" | "revoked";
  readonly attestationStatus: "not_provided" | "unverified" | "verified";
  readonly attestationMetadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}
export interface RegisterDeviceInput extends RetentionOperationInput {
  readonly challengeId: string;
  readonly nonceHash: string;
  readonly platform: HealthPlatform;
  readonly displayName: string;
  readonly publicKeySpkiBase64: string;
  readonly keyFingerprint: string;
  readonly proofSignatureDigest: string;
  readonly attestationStatus: "not_provided" | "unverified";
  readonly attestationMetadata?: JsonObject;
}
export interface RevokeDeviceInput extends RetentionOperationInput {
  readonly deviceId: string;
  readonly expectedRevision: bigint | number | string;
  readonly occurredAt?: string;
}
export interface DeviceMutationResult {
  readonly device: DeviceRegistrationRecord;
  readonly replayed: boolean;
}
export interface CreateDeviceChallengeInput extends RetentionOperationInput {
  readonly platform: HealthPlatform;
  readonly nonceHash: string;
  readonly expiresAt: string;
}
export interface DeviceChallengeRecord {
  readonly id: string;
  readonly deviceId: string | null;
  readonly platform: HealthPlatform;
  readonly purpose: "device_registration";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}
export interface DeviceChallengeMutationResult {
  readonly challenge: DeviceChallengeRecord;
  readonly replayed: boolean;
}
export type ReauthenticationPurpose = "account_export" | "account_erasure";
export interface ReauthenticationProofRecord {
  readonly id: string;
  readonly purpose: ReauthenticationPurpose;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}
export interface CreateReauthenticationProofInput {
  readonly userId: string;
  readonly sessionTokenHash: string;
  readonly purpose: ReauthenticationPurpose;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly expectedPasswordHash: string;
}
export interface ConsumeReauthenticationProofInput {
  readonly userId: string;
  readonly sessionTokenHash: string;
  readonly purpose: ReauthenticationPurpose;
  readonly tokenHash: string;
  readonly clientOperationId: string;
  readonly consumedAt?: string;
}

export type HealthPlatform = "apple_healthkit" | "android_health_connect";
export interface PlatformIntegrationRecord {
  readonly id: string;
  readonly platform: HealthPlatform;
  readonly deviceId: string;
  readonly currentRevision: string;
  readonly status: "connected" | "disconnected";
  readonly dataTypeCodes: readonly ["body_weight"];
  readonly cursorEpoch: string;
  readonly currentSourceCursor: string | null;
  readonly consentGrantedAt: string;
  readonly disconnectedAt: string | null;
  readonly lastImportAt: string | null;
  readonly consentHistory: readonly {
    readonly id: string;
    readonly status: "granted" | "revoked";
    readonly dataTypeCodes: readonly ["body_weight"];
    readonly recordedAt: string;
  }[];
}
export interface ConsentPlatformIntegrationInput extends RetentionOperationInput {
  readonly platform: HealthPlatform;
  readonly dataTypeCodes: readonly ["body_weight"];
  readonly consentGranted: true;
  readonly occurredAt?: string;
}
export interface DisconnectPlatformIntegrationInput extends RetentionOperationInput {
  readonly platform: HealthPlatform;
  readonly expectedRevision: bigint | number | string;
  readonly importedDataDisposition: "retain" | "delete";
  readonly occurredAt?: string;
}
export interface RebindPlatformIntegrationInput extends RetentionOperationInput {
  readonly platform: HealthPlatform;
  readonly deviceId: string;
  readonly expectedRevision: bigint | number | string;
  readonly occurredAt?: string;
}
export interface PlatformIntegrationMutationResult {
  readonly integration: PlatformIntegrationRecord;
  readonly replayed: boolean;
}
export type PlatformImportRecordInput =
  | {
      readonly operation: "upsert";
      readonly externalId: string;
      readonly externalRevision: string;
      readonly definitionCode: "body_weight";
      readonly measuredAt: string;
      readonly recordedTimeZone: string;
      readonly value: string;
      readonly unit: "kg";
    }
  | {
      readonly operation: "delete";
      readonly externalId: string;
      readonly externalRevision: string;
    };
export interface ApplyPlatformHealthImportBatchInput extends RetentionOperationInput {
  readonly deviceId: string;
  readonly batchId: string;
  readonly platform: HealthPlatform;
  readonly cursorEpoch: bigint | number | string;
  readonly sourceCursor: string | null;
  readonly nextSourceCursor: string;
  readonly records: readonly PlatformImportRecordInput[];
  readonly signedAt: string;
  readonly nonceHash: string;
  readonly batchDigest: string;
  readonly signatureDigest: string;
  /** Verified by the API clock policy; exact stored replays bypass this gate. */
  readonly isTimestampFresh: boolean;
}
export interface PlatformHealthImportBatchResult {
  readonly replayed: boolean;
  readonly accepted: number;
  readonly deleted: number;
  readonly duplicates: number;
  readonly conflicts: readonly {
    readonly externalId: string;
    readonly submittedRevision: string;
    readonly currentRevision: string;
    readonly code: "SOURCE_ID_REUSED" | "STALE_SOURCE_REVISION";
  }[];
}

export interface PlatformHealthImportInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly externalSourceId: string;
  readonly operation: "delete" | "upsert";
  readonly providerRevision: string;
  readonly providerModifiedAt: string;
  readonly rawDigest: string;
  readonly definitionVersionId?: string;
  readonly measuredAt?: string;
  readonly canonicalValue?: string;
  readonly canonicalUnit?: string;
  readonly provenance: JsonObject;
}
export interface PlatformHealthImportRecord {
  readonly id: string;
  readonly provider: string;
  readonly externalSourceId: string;
  readonly revision: string;
  readonly operation: "delete" | "upsert";
  readonly providerRevision: string;
  readonly providerModifiedAt: string;
  readonly rawDigest: string;
  readonly state: "active" | "conflict" | "deleted";
  readonly eventId: string | null;
  readonly conflictId: string | null;
  readonly duplicate: boolean;
}

export interface PrivacyExportJobRecord {
  readonly id: string;
  /** Worker-only ownership key. Public API mappers must not expose it. */
  readonly userId: string;
  readonly status: "completed" | "failed" | "queued" | "running";
  readonly requestedFormats: readonly ("csv" | "json")[];
  readonly watermarkRevision: string | null;
  readonly snapshotId: string | null;
  readonly manifestDigest: string | null;
  readonly entityCount: string | null;
  readonly reconciliation: JsonObject | null;
  readonly artifacts: readonly PrivacyExportArtifactRecord[];
  readonly failureCode: "EXPORT_FAILED" | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}
export interface PrivacyExportArtifactRecord {
  readonly id: string;
  readonly format: "csv" | "json";
  readonly fileName: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly objectKey: string;
  readonly plaintextBytes: string;
  readonly plaintextSha256: string;
  readonly ciphertextBytes: string;
  readonly encryptionKeyId: string;
  readonly expiresAt: string;
}
export interface ClaimedPrivacyExportArtifactDeletionRecord {
  readonly artifactId: string;
  readonly jobId: string;
  readonly format: "csv" | "json";
  readonly objectKey: string;
  readonly attemptCount: number;
}
export interface AccountPrivacyExportArtifactRecord {
  readonly artifactId: string;
  readonly exportJobId: string;
  readonly format: "csv" | "json";
  readonly objectKey: string;
  readonly source: "completed" | "staged";
}
export interface StagedPrivacyExportArtifactRecord {
  readonly id: string;
  readonly jobId: string;
  readonly snapshotId: string;
  readonly format: "csv" | "json";
  readonly objectKey: string;
  readonly status: "cancelled" | "deleted" | "promoted" | "staged" | "uploaded" | "uploading";
}
export interface ClaimedStagedPrivacyExportArtifactDeletionRecord {
  readonly artifactId: string;
  readonly jobId: string;
  readonly snapshotId: string;
  readonly format: "csv" | "json";
  readonly objectKey: string;
  readonly attemptCount: number;
}
export interface PrivacyExportRecord {
  readonly ordinal: string;
  readonly entityType: PrivacyExportEntity;
  readonly entityId: string;
  readonly revision: string | null;
  readonly deleted: boolean;
  readonly watermark: string;
  readonly payload: JsonObject;
  readonly payloadSha256: string;
}
export type PrivacyExportEntity =
  | "account"
  | "audit_event"
  | "biometric_definition"
  | "biometric_definition_operation"
  | "biometric_definition_version"
  | "biometric_event"
  | "biometric_event_operation"
  | "biometric_event_revision"
  | "custom_food"
  | "custom_food_catalogue_food"
  | "custom_food_catalogue_barcode"
  | "custom_food_catalogue_nutrient"
  | "custom_food_catalogue_serving"
  | "custom_food_catalogue_version"
  | "custom_food_nutrient"
  | "custom_food_operation"
  | "custom_food_version"
  | "device"
  | "diary_day"
  | "diary_entry"
  | "diary_entry_legacy_nutrient"
  | "diary_entry_nutrient"
  | "diary_entry_revision"
  | "diary_entry_source"
  | "diary_operation"
  | "nutrition_goal"
  | "nutrition_goal_operation"
  | "nutrition_goal_target"
  | "nutrition_goal_version"
  | "platform_health_import"
  | "platform_health_import_conflict"
  | "platform_health_import_revision"
  | "platform_import_batch"
  | "platform_integration"
  | "platform_integration_version"
  | "privacy_export_artifact"
  | "privacy_export_artifact_deletion"
  | "privacy_export_artifact_tombstone"
  | "privacy_export_download_audit"
  | "privacy_export_job"
  | "profile"
  | "reauthentication_proof"
  | "recipe"
  | "recipe_ingredient"
  | "recipe_nutrient"
  | "recipe_operation"
  | "recipe_source"
  | "recipe_version"
  | "reminder_consent"
  | "reminder_consent_version"
  | "reminder_delivery"
  | "reminder_schedule"
  | "reminder_schedule_version"
  | "retention_operation"
  | "security_challenge"
  | "session"
  | "user_watermark";
export interface PrivacyExportEntitySnapshotRecord {
  readonly entity: PrivacyExportEntity;
  readonly sourceCount: string;
  readonly watermarkRevision: string;
  /** SHA-256 over the exact ordered canonical export-record NDJSON bytes for this entity. */
  readonly sourceRecordSetSha256: string;
}
export interface PrivacyExportPage {
  readonly entity: string;
  readonly records: readonly PrivacyExportRecord[];
  readonly nextCursor: string | null;
  readonly sourceCount: string;
  readonly entityWatermark: string;
}
export interface PrivacyExportSnapshotContext {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly snapshotWatermark: string;
  readonly entities: readonly PrivacyExportEntitySnapshotRecord[];
  readonly semanticEvidence: PrivacyExportSemanticEvidenceRecord;
  page(input: {
    readonly entity: PrivacyExportEntity;
    readonly cursor?: string | null;
    readonly limit?: number;
  }): Promise<PrivacyExportPage>;
}
export interface PrivacyExportSemanticEvidenceRecord {
  readonly version: "retention-export-semantic-v1";
  readonly diaryDailyNutrientGroupCount: string;
  readonly diaryDailyTotalsSha256: string;
  readonly biometricEventCount: string;
  readonly biometricRevisionCount: string;
  readonly platformImportCount: string;
  readonly platformImportRevisionCount: string;
  readonly digest: string;
}
export interface CreatePrivacyExportJobInput extends RetentionOperationInput {
  readonly sessionTokenHash: string;
  readonly proofTokenHash: string;
  readonly requestedFormats: readonly ("csv" | "json")[];
}
export interface PrivacyExportReconciliationInput {
  readonly snapshotWatermark: string;
  readonly entities: readonly {
    readonly entity: string;
    readonly sourceCount: bigint | number | string;
    readonly exportedCount: bigint | number | string;
    readonly watermarkRevision: bigint | number | string;
    readonly sourceRecordSetSha256: string;
    readonly exportedRecordSetSha256: string;
  }[];
  readonly reconciled: true;
  readonly sourceSemanticDigest: string;
  readonly exportedSemanticDigest: string;
}
export interface PrivacyExportArtifactInput {
  readonly format: "csv" | "json";
  readonly objectKey: string;
  readonly fileName: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly plaintextBytes: bigint | number | string;
  readonly plaintextSha256: string;
  readonly ciphertextBytes: bigint | number | string;
  readonly encryptionKeyId: string;
  readonly expiresAt: string;
}
export interface RecordPrivacyExportArtifactDownloadAuditInput {
  readonly userId: string;
  readonly jobId: string;
  readonly format: "csv" | "json";
  readonly outcome: "failed" | "not_found" | "opened";
  readonly occurredAt: string;
}
export interface CompletePrivacyExportJobInput {
  readonly userId: string;
  readonly jobId: string;
  /** Fences completion to the exact durable snapshot attempt returned to the worker. */
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly artifacts: readonly PrivacyExportArtifactInput[];
  readonly reconciliation: PrivacyExportReconciliationInput;
}

export interface AccountErasureJobRecord {
  readonly id: string;
  readonly status: "completed" | "failed" | "queued" | "running";
  readonly requestedAt: string;
  readonly executeAfter: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly statusCapabilityExpiresAt: string;
}
export interface AccountErasureMutationResult {
  readonly job: AccountErasureJobRecord;
  readonly replayed: boolean;
}
export interface AccountErasureClaimRecord extends AccountErasureJobRecord {
  readonly userId: string;
  readonly restoreLocator: string;
}
export interface AccountErasureReceiptRecord {
  readonly id: string;
  readonly jobId: string;
  readonly completedAt: string;
  readonly policyVersion: string;
  readonly deletedCounts: JsonObject;
  readonly backupCaveat: string;
}
export interface RequestAccountErasureInput extends RetentionOperationInput {
  readonly sessionTokenHash: string;
  readonly proofTokenHash: string;
  readonly statusCapabilityHash: string;
  readonly statusCapabilityExpiresAt: string;
  readonly restoreLocator: string;
  readonly requestedAt?: string;
  readonly executeAfter?: string;
}
export interface AccountErasureExecutionEvidence {
  readonly restoreLedgerReference: string;
  readonly restoreLedgerDigest: string;
  readonly restoreLedgerAcknowledgedAt: string;
  readonly objectDeletionEvidence: {
    readonly artifacts: readonly {
      readonly artifactId: string;
      readonly objectKey: string;
      readonly deletionEvidenceDigest: string;
    }[];
  };
}
export interface ExternalErasureLedgerEntry {
  readonly subjectUserId: string;
  readonly ledgerEntryId: string;
  readonly ackDigest: string;
  readonly recordedAt: string;
}
export interface AccountErasureReconciliationRecord {
  readonly userId: string;
  readonly remainingRows: Readonly<Record<string, string>>;
  readonly reconciled: boolean;
}

const MAX_NUTRIENTS = 256;

export async function getNutrientTrend(
  database: Kysely<Database>,
  input: GetNutrientTrendInput,
): Promise<NutrientTrendSeriesRecord> {
  const record = await getNutrientTrends(database, {
    fromLocalDate: input.fromLocalDate,
    nutrientIds: [input.nutrientId],
    toLocalDate: input.toLocalDate,
    userId: input.userId,
  });
  const first = record.days.flatMap((day) => day.nutrients)[0];
  const nutrient = first ?? record.definitions[0];
  if (!nutrient) throw new RetentionNotFoundError();
  return {
    fromLocalDate: record.fromLocalDate,
    nutrient: {
      code: nutrient.code,
      name: nutrient.name,
      nutrientId: nutrient.nutrientId,
      unit: nutrient.unit,
    },
    points: record.days.map((day) => ({
      aggregate: day.nutrients[0] ?? null,
      endsAt: day.endsAt,
      localDate: day.localDate,
      startsAt: day.startsAt,
    })),
    timeZone: record.profileTimeZone,
    toLocalDate: record.toLocalDate,
    watermarkRevision: record.watermarkRevision,
  };
}

/**
 * Holds the retention writer key on one reserved PostgreSQL session across bounded external I/O.
 * Workers must pass the provided connection to all nested DB repository calls. The lock is
 * re-entrant with transaction-scoped retention locks on that same reserved session.
 */
export async function withUserRetentionSerialization<T>(
  database: Kysely<Database>,
  input: { readonly userId: string },
  callback: (connection: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return database.connection().execute(async (connection) => {
    const key = `nutrition-tracker:retention:${input.userId}`;
    await sql`select pg_advisory_lock(hashtextextended(${key},0))`.execute(connection);
    try {
      return await callback(connection);
    } finally {
      await sql<{
        unlocked: boolean;
      }>`select pg_advisory_unlock(hashtextextended(${key},0)) unlocked`.execute(connection);
    }
  });
}

export async function getNutrientTrends(
  database: Kysely<Database>,
  input: GetNutrientTrendsInput,
): Promise<NutrientTrendRecord> {
  assertTrendRangeSafe(input.fromLocalDate, input.toLocalDate);
  if (input.nutrientIds.length < 1 || input.nutrientIds.length > MAX_NUTRIENTS) {
    throw new RetentionValidationError("nutrientIds must contain 1 to 256 identifiers");
  }
  const nutrientIds = [...new Set(input.nutrientIds.map(canonicalPositiveId))];
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const profile = await requireActiveProfile(transaction, input.userId, false);
      const definitions = await transaction
        .selectFrom("nutrient")
        .select(["id", "code", "name", "canonical_unit"])
        .where("id", "in", nutrientIds)
        .orderBy("id")
        .execute();
      if (definitions.length !== nutrientIds.length) throw new RetentionNotFoundError();
      const days = await sql<{
        local_date: string;
        starts_at: Date;
        ends_at: Date;
        diary_id: string | null;
        diary_revision: string | null;
        total_entries: string;
        time_zones: string[];
        nutrient_id: string;
        known_amount: string | null;
        contributor_count: string | null;
        quantified_count: string | null;
        trace_count: string | null;
        unknown_count: string | null;
        unknown_reasons: JsonObject | null;
      }>`
        with requested_days as (
          select day::date local_date,
                 day::timestamp at time zone ${profile.timeZone} starts_at,
                 (day::date + 1)::timestamp at time zone ${profile.timeZone} ends_at
          from generate_series(${input.fromLocalDate}::date, ${input.toLocalDate}::date, interval '1 day') day
        ), heads as (
          select requested.local_date, diary.id diary_id, diary.revision diary_revision,
                 revision.id revision_id, revision.time_zone
          from diary_entry entry
          join diary_entry_revision revision on revision.id = entry.current_revision_id
          join diary on diary.id = entry.diary_id and diary.user_id = entry.user_id
          join requested_days requested
            on revision.occurred_at >= requested.starts_at
           and revision.occurred_at < requested.ends_at
          where entry.user_id = ${input.userId}
            and revision.operation <> 'delete'
        ), day_meta as (
          select local_date,
                 case when count(distinct diary_id) = 1 then min(diary_id::text)::uuid else null end diary_id,
                 max(diary_revision) diary_revision,
                 count(*) total_entries, array_agg(distinct time_zone order by time_zone) time_zones
          from heads group by local_date
        ), totals as (
          select heads.local_date, snapshot.nutrient_id,
                 sum(snapshot.known_amount) known_amount,
                 sum(snapshot.contributor_count) contributor_count,
                 sum(snapshot.quantified_count) quantified_count,
                 sum(snapshot.trace_count) trace_count,
                 sum(snapshot.unknown_count) unknown_count,
                 jsonb_build_object(
                   'not_reported', sum(coalesce((snapshot.unknown_reasons->>'not_reported')::integer,0)),
                   'not_analyzed', sum(coalesce((snapshot.unknown_reasons->>'not_analyzed')::integer,0)),
                   'not_applicable', sum(coalesce((snapshot.unknown_reasons->>'not_applicable')::integer,0)),
                   'withheld', sum(coalesce((snapshot.unknown_reasons->>'withheld')::integer,0))
                 ) unknown_reasons
          from heads
          join diary_entry_revision_nutrient snapshot on snapshot.diary_entry_revision_id = heads.revision_id
          where snapshot.nutrient_id = any(${sql.val(nutrientIds)}::bigint[])
          group by heads.local_date, snapshot.nutrient_id
        )
        select requested.local_date::text, requested.starts_at, requested.ends_at,
               meta.diary_id, meta.diary_revision,
               coalesce(meta.total_entries,0)::text total_entries,
               coalesce(meta.time_zones,array[]::text[]) time_zones,
               definition.id::text nutrient_id,
               totals.known_amount::text known_amount,
               totals.contributor_count::text contributor_count,
               totals.quantified_count::text quantified_count,
               totals.trace_count::text trace_count,
               totals.unknown_count::text unknown_count,
               totals.unknown_reasons
        from requested_days requested
        cross join nutrient definition
        left join day_meta meta on meta.local_date = requested.local_date
        left join totals on totals.local_date = requested.local_date and totals.nutrient_id = definition.id
        where definition.id = any(${sql.val(nutrientIds)}::bigint[])
        order by requested.local_date, definition.id
      `.execute(transaction);
      const definitionById = new Map(definitions.map((row) => [row.id, row]));
      const byDate = new Map<string, NutrientTrendDayRecord>();
      for (const row of days.rows) {
        const definition = definitionById.get(row.nutrient_id);
        if (!definition)
          throw new RetentionValidationError("Trend definition mapping is incomplete");
        const nutrients: TrendNutrientRecord[] = [];
        if (row.contributor_count !== null && row.known_amount !== null) {
          const contributorCount = safeCount(row.contributor_count);
          const unknownCount = safeCount(row.unknown_count ?? "0");
          const traceCount = safeCount(row.trace_count ?? "0");
          nutrients.push({
            code: definition.code,
            completeness:
              contributorCount === 0 || unknownCount === contributorCount
                ? "unknown"
                : unknownCount === 0
                  ? "complete"
                  : "partial",
            contributorCount,
            isExact: contributorCount > 0 && unknownCount === 0 && traceCount === 0,
            knownAmount: canonicalNonNegative(row.known_amount, "trend known amount"),
            name: definition.name,
            nutrientId: definition.id,
            quantifiedCount: safeCount(row.quantified_count ?? "0"),
            traceCount,
            unit: definition.canonical_unit,
            unknownCount,
            unknownReasons: cleanUnknownReasons(row.unknown_reasons ?? {}),
          });
        }
        const current = byDate.get(row.local_date);
        if (current) {
          (current.nutrients as TrendNutrientRecord[]).push(...nutrients);
        } else {
          byDate.set(row.local_date, {
            diaryId: row.diary_id,
            diaryRevision: row.diary_revision,
            endsAt: row.ends_at.toISOString(),
            localDate: row.local_date,
            nutrients,
            startsAt: row.starts_at.toISOString(),
            timeZones: row.time_zones,
            totalEntries: safeCount(row.total_entries),
          });
        }
      }
      return {
        definitions: definitions.map((definition) => ({
          code: definition.code,
          name: definition.name,
          nutrientId: definition.id,
          unit: definition.canonical_unit,
        })),
        days: [...byDate.values()],
        fromLocalDate: input.fromLocalDate,
        profileTimeZone: profile.timeZone,
        toLocalDate: input.toLocalDate,
        watermarkRevision: profile.watermarkRevision,
      };
    });
}

export async function createCustomFood(
  database: Kysely<Database>,
  input: CreateCustomFoodInput,
): Promise<CustomFoodMutationResult> {
  validateOperation(input);
  const draft = validateCustomFoodDraft(input.food);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<CustomFoodMutationResult>(
      transaction,
      input,
      "custom_food",
      "create",
    );
    if (replay) return replay;
    await sql`lock table nutrient in share mode`.execute(transaction);
    const definitions = await loadCustomFoodNutrients(transaction, draft);
    const customFoodId = randomUUID();
    const food = await transaction
      .insertInto("food")
      .values({
        archived_at: null,
        current_version_id: null,
        food_source_id: null,
        kind: "custom",
        owner_user_id: input.userId,
        source_food_key: null,
        visibility: "private",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await insertCustomFoodVersion(transaction, {
      customFoodId,
      draft,
      foodId: food.id,
      nutrientDefinitions: definitions,
      userId: input.userId,
      versionNumber: 1,
    });
    await transaction
      .updateTable("food")
      .set({ current_version_id: version.id })
      .where("id", "=", food.id)
      .execute();
    await transaction
      .insertInto("custom_food")
      .values({
        current_food_version_id: version.id,
        current_revision: "1",
        food_id: food.id,
        id: customFoodId,
        user_id: input.userId,
      })
      .execute();
    await publishCustomVersionEvidence(transaction, customFoodId, version, 1);
    const result = {
      food: await loadCustomFood(transaction, input.userId, customFoodId),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "custom_food", "create", customFoodId, result);
    return result;
  });
}

export async function reviseCustomFood(
  database: Kysely<Database>,
  input: ReviseCustomFoodInput,
): Promise<CustomFoodMutationResult> {
  validateOperation(input);
  const expected = canonicalRevision(input.expectedRevision);
  const draft = validateCustomFoodDraft(input.food);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<CustomFoodMutationResult>(
      transaction,
      input,
      "custom_food",
      "revise",
    );
    if (replay) return replay;
    const root = await transaction
      .selectFrom("custom_food")
      .selectAll()
      .where("id", "=", input.customFoodId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionNotFoundError();
    if (root.current_revision !== expected) throw new RetentionRevisionConflictError();
    await sql`lock table nutrient in share mode`.execute(transaction);
    const definitions = await loadCustomFoodNutrients(transaction, draft);
    const next = (BigInt(root.current_revision) + 1n).toString();
    const version = await insertCustomFoodVersion(transaction, {
      customFoodId: root.id,
      draft,
      foodId: root.food_id,
      nutrientDefinitions: definitions,
      userId: input.userId,
      versionNumber: Number(next),
    });
    await transaction
      .updateTable("food")
      .set({ current_version_id: version.id })
      .where("id", "=", root.food_id)
      .execute();
    await transaction
      .updateTable("custom_food")
      .set({ current_food_version_id: version.id, current_revision: next })
      .where("id", "=", root.id)
      .execute();
    await publishCustomVersionEvidence(transaction, root.id, version, Number(next));
    const result = {
      food: await loadCustomFood(transaction, input.userId, root.id),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "custom_food", "revise", root.id, result);
    return result;
  });
}

export async function getCustomFood(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly customFoodId: string },
): Promise<CustomFoodRecord> {
  await requireActiveProfile(database, input.userId, false);
  return loadCustomFood(database, input.userId, input.customFoodId);
}

export async function listCustomFoods(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly includeArchived?: boolean;
    readonly limit?: number;
    readonly cursor?: string | null;
  },
): Promise<CustomFoodListRecord> {
  const limit = boundedLimit(input.limit, 50);
  const binding = sha256(`custom_food:${input.userId}:${input.includeArchived === true}`);
  const cursor = decodeRetentionCursor(input.cursor, "custom_food", binding);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireActiveProfile(transaction, input.userId, false);
      const rows = await sql<{ id: string; cursor_time: string }>`
        select id::text,
          to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time
        from custom_food
        where user_id=${input.userId}::uuid
          and (${input.includeArchived === true} or status='active')
          and (${cursor?.time ?? null}::text is null
            or (updated_at,id) < ((${cursor?.time ?? null})::timestamptz,${cursor?.id ?? null}::uuid))
        order by updated_at desc,id desc
        limit ${limit + 1}
      `.execute(transaction);
      const visible = rows.rows.slice(0, limit);
      const records = await Promise.all(
        visible.map((row) => loadCustomFood(transaction, input.userId, row.id)),
      );
      const tail = visible.at(-1);
      return {
        nextCursor:
          rows.rows.length > limit && tail
            ? encodeRetentionCursor("custom_food", binding, tail.cursor_time, tail.id)
            : null,
        records,
      };
    });
}

export async function archiveCustomFood(
  database: Kysely<Database>,
  input: ArchiveCustomFoodInput,
): Promise<CustomFoodMutationResult> {
  validateOperation(input);
  const expected = canonicalRevision(input.expectedRevision);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<CustomFoodMutationResult>(
      transaction,
      input,
      "custom_food",
      "archive",
    );
    if (replay) return replay;
    const root = await transaction
      .selectFrom("custom_food")
      .selectAll()
      .where("id", "=", input.customFoodId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionNotFoundError();
    if (root.current_revision !== expected) throw new RetentionRevisionConflictError();
    await transaction
      .updateTable("food")
      .set({ archived_at: new Date() })
      .where("id", "=", root.food_id)
      .execute();
    await transaction
      .updateTable("custom_food")
      .set({
        archived_at: new Date(),
        current_revision: (BigInt(root.current_revision) + 1n).toString(),
        status: "archived",
      })
      .where("id", "=", root.id)
      .execute();
    const result = {
      food: await loadCustomFood(transaction, input.userId, root.id),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "custom_food", "archive", root.id, result);
    return result;
  });
}

// Biometrics, reminders, devices/imports, and privacy functions follow below;
// they share the same account gate, user advisory lock, and immutable replay helpers.

export async function createBiometricDefinition(
  database: Kysely<Database>,
  input: CreateBiometricDefinitionInput,
): Promise<BiometricDefinitionMutationResult> {
  return writeBiometricDefinition(database, input, null);
}
export async function reviseBiometricDefinition(
  database: Kysely<Database>,
  input: ReviseBiometricDefinitionInput,
): Promise<BiometricDefinitionMutationResult> {
  return writeBiometricDefinition(database, input, input.definitionId);
}
export async function archiveBiometricDefinition(
  database: Kysely<Database>,
  input: ArchiveBiometricDefinitionInput,
): Promise<BiometricDefinitionMutationResult> {
  validateOperation(input);
  const expected = canonicalRevision(input.expectedRevision);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<BiometricDefinitionMutationResult>(
      transaction,
      input,
      "biometric",
      "archive_definition",
    );
    if (replay) return replay;
    const root = await transaction
      .selectFrom("biometric_definition")
      .selectAll()
      .where("id", "=", input.definitionId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionNotFoundError();
    if (root.current_revision !== expected) throw new RetentionRevisionConflictError();
    const next = (BigInt(root.current_revision) + 1n).toString();
    await transaction
      .updateTable("biometric_definition")
      .set({ archived_at: new Date(), current_revision: next, status: "archived" })
      .where("id", "=", root.id)
      .execute();
    const result = {
      definition: await loadBiometricDefinition(transaction, input.userId, root.id),
      replayed: false,
    };
    await recordFeatureOperation(
      transaction,
      input,
      "biometric",
      "archive_definition",
      root.id,
      result,
    );
    return result;
  });
}
export async function listBiometricDefinitions(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly includeArchived?: boolean },
): Promise<readonly BiometricDefinitionRecord[]> {
  await requireActiveProfile(database, input.userId, false);
  let query = database
    .selectFrom("biometric_definition")
    .select("id")
    .where("user_id", "=", input.userId)
    .orderBy("updated_at", "desc")
    .limit(100);
  if (!input.includeArchived) query = query.where("status", "=", "active");
  const rows = await query.execute();
  return Promise.all(rows.map((row) => loadBiometricDefinition(database, input.userId, row.id)));
}

export async function recordBiometricEvent(
  database: Kysely<Database>,
  input: RecordBiometricEventInput,
): Promise<BiometricEventMutationResult> {
  return createManualBiometricEvent(database, input);
}
export async function reviseBiometricEvent(
  database: Kysely<Database>,
  input: ReviseBiometricEventInput,
): Promise<BiometricEventMutationResult> {
  return mutateManualBiometricEvent(database, input, "update");
}
export async function deleteBiometricEvent(
  database: Kysely<Database>,
  input: DeleteBiometricEventInput,
): Promise<BiometricEventMutationResult> {
  return mutateManualBiometricEvent(database, input, "delete");
}
export async function listBiometricEvents(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly definitionId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    readonly cursor?: string | null;
  },
): Promise<BiometricEventListRecord> {
  const from = input.from ? canonicalInstant(input.from) : null;
  const to = input.to ? canonicalInstant(input.to) : null;
  const limit = boundedLimit(input.limit, 200);
  const binding = sha256(
    `biometric_event:${input.userId}:${input.definitionId ?? ""}:${from ?? ""}:${to ?? ""}`,
  );
  const cursor = decodeRetentionCursor(input.cursor, "biometric_event", binding);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireActiveProfile(transaction, input.userId, false);
      const rows = await sql<{ id: string; cursor_time: string }>`
        select event.id::text,
          to_char(revision.measured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time
        from biometric_event event
        join biometric_event_revision revision on revision.id=event.current_revision_id
        join biometric_definition_version definition on definition.id=revision.definition_version_id
        where event.user_id=${input.userId}::uuid and revision.operation <> 'delete'
          and (${input.definitionId ?? null}::uuid is null
            or definition.definition_id=${input.definitionId ?? null}::uuid)
          and (${from}::timestamptz is null or revision.measured_at >= ${from}::timestamptz)
          and (${to}::timestamptz is null or revision.measured_at <= ${to}::timestamptz)
          and (${cursor?.time ?? null}::text is null
            or (revision.measured_at,event.id) < ((${cursor?.time ?? null})::timestamptz,${cursor?.id ?? null}::uuid))
        order by revision.measured_at desc,event.id desc
        limit ${limit + 1}
      `.execute(transaction);
      const visible = rows.rows.slice(0, limit);
      const records = await Promise.all(
        visible.map((row) => loadBiometricEvent(transaction, input.userId, row.id)),
      );
      const tail = visible.at(-1);
      return {
        nextCursor:
          rows.rows.length > limit && tail
            ? encodeRetentionCursor("biometric_event", binding, tail.cursor_time, tail.id)
            : null,
        records,
      };
    });
}

export async function getBiometricTrends(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly definitionId: string;
    readonly fromLocalDate: string;
    readonly toLocalDate: string;
  },
): Promise<BiometricTrendRecord> {
  assertTrendRangeSafe(input.fromLocalDate, input.toLocalDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const profile = await requireActiveProfile(transaction, input.userId, false);
      const definition = await loadBiometricDefinition(
        transaction,
        input.userId,
        input.definitionId,
      );
      const rows = await sql<{
        local_date: string;
        starts_at: Date;
        ends_at: Date;
        sample_count: string;
        first_value: string;
        last_value: string;
        minimum_value: string;
        maximum_value: string;
      }>`
        with requested_days as (
          select day::date local_date,
                 day::timestamp at time zone ${profile.timeZone} starts_at,
                 (day::date + 1)::timestamp at time zone ${profile.timeZone} ends_at
          from generate_series(${input.fromLocalDate}::date, ${input.toLocalDate}::date, interval '1 day') day
        ), samples as (
          select requested.local_date, requested.starts_at, requested.ends_at,
                 revision.value, revision.measured_at, revision.id
          from biometric_event event
          join biometric_event_revision revision on revision.id = event.current_revision_id
          join biometric_definition_version definition
            on definition.id = revision.definition_version_id
          join requested_days requested
            on revision.measured_at >= requested.starts_at
           and revision.measured_at < requested.ends_at
          where event.user_id = ${input.userId}
            and definition.definition_id = ${input.definitionId}
            and revision.operation <> 'delete'
        )
        select local_date::text, min(starts_at) starts_at, min(ends_at) ends_at,
               count(*)::text sample_count,
               (array_agg(value order by measured_at, id))[1]::text first_value,
               (array_agg(value order by measured_at desc, id desc))[1]::text last_value,
               min(value)::text minimum_value, max(value)::text maximum_value
        from samples
        group by local_date
        order by local_date
      `.execute(transaction);
      return {
        definition,
        fromLocalDate: input.fromLocalDate,
        points: rows.rows.map((row) => ({
          count: safeCount(row.sample_count),
          endsAt: row.ends_at.toISOString(),
          first: canonicalSigned(row.first_value, "first"),
          last: canonicalSigned(row.last_value, "last"),
          localDate: row.local_date,
          maximum: canonicalSigned(row.maximum_value, "maximum"),
          minimum: canonicalSigned(row.minimum_value, "minimum"),
          startsAt: row.starts_at.toISOString(),
        })),
        timeZone: profile.timeZone,
        toLocalDate: input.toLocalDate,
      };
    });
}

export async function createReminderSchedule(
  database: Kysely<Database>,
  input: CreateReminderScheduleInput,
): Promise<ReminderScheduleMutationResult> {
  return writeReminderSchedule(database, input, null);
}
export async function reviseReminderSchedule(
  database: Kysely<Database>,
  input: ReviseReminderScheduleInput,
): Promise<ReminderScheduleMutationResult> {
  return writeReminderSchedule(database, input, input.scheduleId);
}
export async function revokeReminderSchedule(
  database: Kysely<Database>,
  input: RevokeReminderScheduleInput,
): Promise<ReminderScheduleMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<ReminderScheduleMutationResult>(
      transaction,
      input,
      "reminder",
      "revoke",
    );
    if (replay) return replay;
    const root = await transaction
      .selectFrom("reminder_schedule")
      .selectAll()
      .where("id", "=", input.scheduleId)
      .where("user_id", "=", input.userId)
      .where("status", "in", ["active", "paused"])
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionNotFoundError();
    if (root.current_revision !== canonicalRevision(input.expectedRevision))
      throw new RetentionRevisionConflictError();
    const current = await transaction
      .selectFrom("reminder_schedule_version as schedule_version")
      .innerJoin(
        "reminder_consent_version as consent_version",
        "consent_version.id",
        "schedule_version.consent_version_id",
      )
      .innerJoin("reminder_consent as consent", "consent.id", "consent_version.consent_id")
      .select([
        "schedule_version.label",
        "schedule_version.channel",
        "schedule_version.time_zone",
        "schedule_version.local_time",
        "schedule_version.days_of_week",
        "schedule_version.dst_policy",
        "schedule_version.notification_title",
        "schedule_version.notification_body",
        "consent.id as consent_id",
        "consent.current_revision as consent_revision",
      ])
      .where("schedule_version.id", "=", root.current_version_id)
      .where("schedule_version.user_id", "=", input.userId)
      .forUpdate("consent")
      .executeTakeFirstOrThrow();
    const occurredAt = await transactionClock(transaction, input.occurredAt);
    const nextRevision = (BigInt(root.current_revision) + 1n).toString();
    const nextConsentRevision = (BigInt(current.consent_revision) + 1n).toString();
    const scheduleVersionId = randomUUID();
    const consentVersionId = randomUUID();
    await transaction
      .insertInto("reminder_consent_version")
      .values({
        consent_id: current.consent_id,
        id: consentVersionId,
        occurred_at: occurredAt,
        policy_version: "local-reminders-v1",
        reason: "schedule_revoked",
        status: "revoked",
        user_id: input.userId,
        version_number: nextConsentRevision,
      })
      .execute();
    await transaction
      .updateTable("reminder_consent")
      .set({
        current_revision: nextConsentRevision,
        current_version_id: consentVersionId,
        status: "revoked",
      })
      .where("id", "=", current.consent_id)
      .execute();
    await transaction
      .insertInto("reminder_schedule_version")
      .values({
        channel: current.channel,
        consent_version_id: consentVersionId,
        days_of_week: current.days_of_week,
        dst_policy: current.dst_policy,
        id: scheduleVersionId,
        initial_delivery_at: null,
        label: current.label,
        local_time: current.local_time,
        notification_body: current.notification_body,
        notification_title: current.notification_title,
        schedule_id: root.id,
        schedule_status: "revoked",
        time_zone: current.time_zone,
        user_id: input.userId,
        version_number: nextRevision,
      })
      .execute();
    await transaction
      .updateTable("reminder_schedule")
      .set({
        current_revision: nextRevision,
        current_version_id: scheduleVersionId,
        next_delivery_at: null,
        revoked_at: occurredAt,
        status: "revoked",
      })
      .where("id", "=", root.id)
      .execute();
    await transaction
      .updateTable("reminder_delivery_outbox")
      .set({ status: "cancelled" })
      .where("schedule_id", "=", root.id)
      .where("status", "in", ["pending", "processing"])
      .execute();
    const result = {
      replayed: false,
      schedule: await loadReminderSchedule(transaction, input.userId, root.id),
    };
    await recordFeatureOperation(transaction, input, "reminder", "revoke", root.id, result);
    return result;
  });
}
export async function listReminderSchedules(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly includeRevoked?: boolean },
): Promise<readonly ReminderScheduleRecord[]> {
  await requireActiveProfile(database, input.userId, false);
  let query = database
    .selectFrom("reminder_schedule")
    .select("id")
    .where("user_id", "=", input.userId)
    .orderBy("updated_at", "desc")
    .limit(100);
  if (!input.includeRevoked) query = query.where("status", "!=", "revoked");
  const rows = await query.execute();
  return Promise.all(rows.map((row) => loadReminderSchedule(database, input.userId, row.id)));
}

export async function enqueueDueReminderDeliveries(
  database: Kysely<Database>,
  input: { readonly through: string; readonly limit?: number },
): Promise<number> {
  const through = canonicalInstant(input.through);
  const limit = boundedLimit(input.limit, 500);
  return database.transaction().execute(async (transaction) => {
    const rows = await transaction
      .selectFrom("reminder_schedule as root")
      .innerJoin("reminder_schedule_version as version", "version.id", "root.current_version_id")
      .select([
        "root.id",
        "root.user_id",
        "root.current_version_id",
        "root.next_delivery_at",
        "version.days_of_week",
        "version.local_time",
        "version.time_zone",
      ])
      .where("root.status", "=", "active")
      .where("root.next_delivery_at", "is not", null)
      .where("root.next_delivery_at", "<=", new Date(through))
      .orderBy("root.next_delivery_at")
      .orderBy("root.id")
      .forUpdate("root")
      .skipLocked()
      .limit(limit)
      .execute();
    for (const row of rows) {
      if (!row.next_delivery_at) continue;
      await transaction
        .insertInto("reminder_delivery_outbox")
        .values({
          device_id: null,
          notification_body: "Time to check in.",
          notification_title: "Nutrition Tracker",
          schedule_id: row.id,
          schedule_version_id: row.current_version_id,
          scheduled_for: row.next_delivery_at,
          user_id: row.user_id,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      const next = nextReminderOccurrence({
        after: row.next_delivery_at.toISOString(),
        daysOfWeek: row.days_of_week as readonly IsoWeekday[],
        localTime: row.local_time.slice(0, 5),
        timeZone: row.time_zone,
      });
      await transaction
        .updateTable("reminder_schedule")
        .set({ next_delivery_at: next.instant })
        .where("id", "=", row.id)
        .execute();
    }
    return rows.length;
  });
}

export async function claimReminderDeliveries(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly now: string; readonly limit?: number },
): Promise<readonly ClaimedReminderDeliveryRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  const limit = boundedLimit(input.limit, 100);
  const workerId = boundedText(input.workerId, 200, "workerId");
  return database.transaction().execute(async (transaction) => {
    await transaction
      .updateTable("reminder_delivery_outbox")
      .set({
        dead_lettered_at: now,
        last_error_code: "DELIVERY_ATTEMPTS_EXHAUSTED",
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("status", "in", ["pending", "processing"])
      .where("attempt_count", ">=", 20)
      .where("dead_lettered_at", "is", null)
      .execute();
    const rows = await transaction
      .selectFrom("reminder_delivery_outbox")
      .select("id")
      .where("attempt_count", "<", 20)
      .where("dead_lettered_at", "is", null)
      .where(
        sql<boolean>`((status = 'pending' and available_at <= ${new Date(now)}) or
          (status = 'processing' and locked_at <= ${staleBefore}))`,
      )
      .orderBy("scheduled_for")
      .orderBy("id")
      .forUpdate()
      .skipLocked()
      .limit(limit)
      .execute();
    if (!rows.length) return [];
    const claimed = await transaction
      .updateTable("reminder_delivery_outbox")
      .set({
        attempt_count: sql<number>`attempt_count + 1`,
        locked_at: now,
        locked_by: workerId,
        status: "processing",
      })
      .where(
        "id",
        "in",
        rows.map((row) => row.id),
      )
      .returningAll()
      .execute();
    return claimed.map((row) => ({
      attemptCount: row.attempt_count,
      deviceId: row.device_id,
      id: row.id,
      notificationBody: "Time to check in.",
      notificationTitle: "Nutrition Tracker",
      scheduleId: row.schedule_id,
      scheduledFor: row.scheduled_for.toISOString(),
    }));
  });
}

export async function markReminderDeliverySucceeded(
  database: Kysely<Database>,
  input: { readonly deliveryId: string; readonly workerId: string; readonly deliveredAt: string },
): Promise<boolean> {
  const result = await database
    .updateTable("reminder_delivery_outbox")
    .set({
      delivered_at: canonicalInstant(input.deliveredAt),
      last_error_code: null,
      locked_at: null,
      locked_by: null,
      status: "succeeded",
    })
    .where("id", "=", input.deliveryId)
    .where("status", "=", "processing")
    .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function markReminderDeliveryFailed(
  database: Kysely<Database>,
  input: {
    readonly deliveryId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt?: string | null;
  },
): Promise<boolean> {
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("reminder_delivery_outbox")
      .select(["attempt_count", "id"])
      .where("id", "=", input.deliveryId)
      .where("status", "=", "processing")
      .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    const exhausted = row.attempt_count >= 20;
    await transaction
      .updateTable("reminder_delivery_outbox")
      .set({
        available_at: input.retryAt ? canonicalInstant(input.retryAt) : new Date(),
        dead_lettered_at: exhausted ? new Date() : null,
        last_error_code: boundedText(input.errorCode, 100, "errorCode"),
        locked_at: null,
        locked_by: null,
        status: input.retryAt && !exhausted ? "pending" : "failed",
      })
      .where("id", "=", row.id)
      .execute();
    return true;
  });
}

export async function registerDevice(
  database: Kysely<Database>,
  input: RegisterDeviceInput,
): Promise<DeviceMutationResult> {
  validateOperation(input);
  requireDigest(input.nonceHash, "nonceHash");
  requireDigest(input.keyFingerprint, "keyFingerprint");
  requireDigest(input.proofSignatureDigest, "proofSignatureDigest");
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<DeviceMutationResult>(
      transaction,
      input,
      "device",
      "register",
    );
    if (replay) return replay;
    const challenge = await transaction
      .updateTable("security_challenge")
      .set({ consumed_at: new Date(), proof_signature_digest: input.proofSignatureDigest })
      .where("id", "=", input.challengeId)
      .where("user_id", "=", input.userId)
      .where("purpose", "=", "device_registration")
      .where("platform", "=", input.platform)
      .where("nonce_hash", "=", input.nonceHash)
      .where("device_id", "is", null)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .returning("id")
      .executeTakeFirst();
    if (!challenge) throw new RetentionNotFoundError();
    const existing = await transaction
      .selectFrom("device_registration")
      .select("id")
      .where("user_id", "=", input.userId)
      .where("key_fingerprint", "=", input.keyFingerprint)
      .executeTakeFirst();
    if (existing) {
      throw new RetentionRevisionConflictError();
    }
    const row = await transaction
      .insertInto("device_registration")
      .values({
        attestation_metadata: input.attestationMetadata ?? {},
        attestation_status: input.attestationStatus,
        display_name: boundedText(input.displayName, 120, "displayName"),
        key_algorithm: "ES256",
        key_fingerprint: input.keyFingerprint,
        platform: input.platform,
        proof_signature_digest: input.proofSignatureDigest,
        public_key_spki_base64: boundedText(input.publicKeySpkiBase64, 8192, "publicKeySpkiBase64"),
        user_id: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const result = { device: mapDevice(row), replayed: false };
    await recordFeatureOperation(transaction, input, "device", "register", row.id, result);
    return result;
  });
}
export async function getActiveDeviceRegistration(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly platform: HealthPlatform;
  },
): Promise<DeviceRegistrationRecord> {
  await requireActiveProfile(database, input.userId, false);
  const row = await database
    .selectFrom("device_registration")
    .selectAll()
    .where("id", "=", input.deviceId)
    .where("user_id", "=", input.userId)
    .where("platform", "=", input.platform)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return mapDevice(row);
}
export async function revokeDevice(
  database: Kysely<Database>,
  input: RevokeDeviceInput,
): Promise<DeviceMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<DeviceMutationResult>(
      transaction,
      input,
      "device",
      "revoke",
    );
    if (replay) return replay;
    const current = await transaction
      .selectFrom("device_registration")
      .selectAll()
      .where("id", "=", input.deviceId)
      .where("user_id", "=", input.userId)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new RetentionNotFoundError();
    if (current.revision !== canonicalRevision(input.expectedRevision))
      throw new RetentionRevisionConflictError();
    const occurredAt = await transactionClock(transaction, input.occurredAt);
    const row = await transaction
      .updateTable("device_registration")
      .set({
        revision: (BigInt(current.revision) + 1n).toString(),
        revoked_at: occurredAt,
      })
      .where("id", "=", current.id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    await transaction
      .updateTable("security_challenge")
      .set({ revoked_at: occurredAt })
      .where("device_id", "=", row.id)
      .where("consumed_at", "is", null)
      .execute();
    await transaction
      .updateTable("reauthentication_proof")
      .set({ revoked_at: occurredAt })
      .where("user_id", "=", input.userId)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();
    const result = { device: mapDevice(row), replayed: false };
    await recordFeatureOperation(transaction, input, "device", "revoke", row.id, result);
    return result;
  });
}
export async function createDeviceChallenge(
  database: Kysely<Database>,
  input: CreateDeviceChallengeInput,
): Promise<DeviceChallengeMutationResult> {
  validateOperation(input);
  requireDigest(input.nonceHash, "nonceHash");
  const expiresAt = canonicalInstant(input.expiresAt);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<DeviceChallengeMutationResult>(
      transaction,
      input,
      "device",
      "challenge",
    );
    if (replay) return { ...replay, replayed: true };
    const row = await transaction
      .insertInto("security_challenge")
      .values({
        device_id: null,
        expires_at: expiresAt,
        nonce_hash: input.nonceHash,
        platform: input.platform,
        purpose: "device_registration",
        user_id: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const result = { challenge: mapChallenge(row), replayed: false };
    await recordFeatureOperation(transaction, input, "device", "challenge", row.id, result);
    return result;
  });
}
export async function consumeDeviceChallenge(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly challengeId: string;
    readonly nonceHash: string;
    readonly proofSignatureDigest: string;
    readonly consumedAt: string;
    readonly expectedPurpose: "device_registration";
    readonly expectedPlatform: HealthPlatform;
  },
): Promise<DeviceChallengeRecord> {
  requireDigest(input.nonceHash, "nonceHash");
  requireDigest(input.proofSignatureDigest, "proofSignatureDigest");
  const consumedAt = canonicalInstant(input.consumedAt);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const row = await transaction
      .updateTable("security_challenge")
      .set({ consumed_at: consumedAt, proof_signature_digest: input.proofSignatureDigest })
      .where("id", "=", input.challengeId)
      .where("user_id", "=", input.userId)
      .where("nonce_hash", "=", input.nonceHash)
      .where("purpose", "=", input.expectedPurpose)
      .where("platform", "=", input.expectedPlatform)
      .where("device_id", "is", null)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date(consumedAt))
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    return mapChallenge(row);
  });
}

export async function createReauthenticationProof(
  database: Kysely<Database>,
  input: CreateReauthenticationProofInput,
): Promise<ReauthenticationProofRecord> {
  requireDigest(input.sessionTokenHash, "sessionTokenHash");
  requireDigest(input.tokenHash, "tokenHash");
  const expiresAt = canonicalInstant(input.expiresAt);
  const expectedPasswordHashBytes = Buffer.byteLength(input.expectedPasswordHash, "utf8");
  if (expectedPasswordHashBytes < 16 || expectedPasswordHashBytes > 1_024) {
    throw new RetentionValidationError("Password verifier is invalid");
  }
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const credential = await transaction
      .selectFrom("user_password_credential")
      .select("password_hash")
      .where("user_id", "=", input.userId)
      .forShare()
      .executeTakeFirst();
    if (!credential || credential.password_hash !== input.expectedPasswordHash) {
      throw new PasswordCredentialStaleError("Password credential changed");
    }
    const session = await transaction
      .selectFrom("user_session")
      .select("expires_at")
      .where("user_id", "=", input.userId)
      .where("token_hash", "=", input.sessionTokenHash)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .forShare()
      .executeTakeFirst();
    if (!session || new Date(expiresAt) > session.expires_at) throw new RetentionNotFoundError();
    const row = await transaction
      .insertInto("reauthentication_proof")
      .values({
        consumed_at: null,
        consumed_client_operation_id: null,
        expires_at: expiresAt,
        purpose: input.purpose,
        revoked_at: null,
        session_token_hash: input.sessionTokenHash,
        token_hash: input.tokenHash,
        user_id: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapReauthenticationProof(row);
  });
}

export async function consumeReauthenticationProof(
  database: Kysely<Database>,
  input: ConsumeReauthenticationProofInput,
): Promise<ReauthenticationProofRecord> {
  requireDigest(input.sessionTokenHash, "sessionTokenHash");
  requireDigest(input.tokenHash, "tokenHash");
  const consumedAt = input.consumedAt
    ? canonicalInstant(input.consumedAt)
    : new Date().toISOString();
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    return consumeReauthenticationProofInTransaction(transaction, input, consumedAt);
  });
}

export async function applyPlatformHealthImport(
  database: Kysely<Database>,
  input: PlatformHealthImportInput,
): Promise<PlatformHealthImportRecord> {
  return applyHealthImport(database, input);
}
export async function listPlatformHealthImports(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly provider?: string; readonly limit?: number },
): Promise<readonly PlatformHealthImportRecord[]> {
  await requireActiveProfile(database, input.userId, false);
  let query = database
    .selectFrom("platform_health_import as root")
    .innerJoin(
      "platform_health_import_revision as revision",
      "revision.id",
      "root.current_revision_id",
    )
    .select([
      "root.id",
      "root.provider",
      "root.external_source_id",
      "root.current_revision",
      "root.state",
      "root.current_event_id",
      "revision.operation",
      "revision.provider_revision",
      "revision.provider_modified_at",
      "revision.raw_digest",
    ])
    .where("root.user_id", "=", input.userId)
    .orderBy("root.updated_at", "desc")
    .limit(boundedLimit(input.limit, 200));
  if (input.provider) query = query.where("root.provider", "=", input.provider);
  const rows = await query.execute();
  return rows.map((row) => ({
    conflictId: null,
    duplicate: false,
    eventId: row.current_event_id,
    externalSourceId: row.external_source_id,
    id: row.id,
    operation: row.operation,
    provider: row.provider,
    providerModifiedAt: row.provider_modified_at.toISOString(),
    providerRevision: row.provider_revision,
    rawDigest: row.raw_digest,
    revision: row.current_revision,
    state: row.state,
  }));
}

export async function consentPlatformIntegration(
  database: Kysely<Database>,
  input: ConsentPlatformIntegrationInput,
): Promise<PlatformIntegrationMutationResult> {
  validateOperation(input);
  if (
    !input.consentGranted ||
    input.dataTypeCodes.length !== 1 ||
    input.dataTypeCodes[0] !== "body_weight"
  )
    throw new RetentionValidationError("Only explicit body-weight consent is supported");
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<PlatformIntegrationMutationResult>(
      transaction,
      input,
      "integration",
      "consent",
    );
    if (replay) return { ...replay, replayed: true };
    const device = await transaction
      .selectFrom("device_registration")
      .select("id")
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .forShare()
      .executeTakeFirst();
    if (!device) throw new RetentionNotFoundError();
    const now = await transactionClock(transaction, input.occurredAt);
    let root = await transaction
      .selectFrom("platform_integration")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .forUpdate()
      .executeTakeFirst();
    if (root?.status === "connected") {
      const result = {
        integration: await loadPlatformIntegration(transaction, input.userId, root.id),
        replayed: false,
      };
      await recordFeatureOperation(transaction, input, "integration", "consent", root.id, result);
      return result;
    }
    await ensureBodyWeightDefinition(transaction, input.userId);
    const integrationId = root?.id ?? randomUUID();
    const versionId = randomUUID();
    const revision = root ? (BigInt(root.current_revision) + 1n).toString() : "1";
    if (!root) {
      await transaction
        .insertInto("platform_integration")
        .values({
          consent_granted_at: now,
          current_revision: "1",
          current_source_cursor: null,
          current_version_id: versionId,
          data_type_codes: ["body_weight"],
          device_id: device.id,
          disconnected_at: null,
          id: integrationId,
          last_import_at: null,
          platform: input.platform,
          status: "connected",
          user_id: input.userId,
        })
        .execute();
    }
    await transaction
      .insertInto("platform_integration_version")
      .values({
        data_type_codes: ["body_weight"],
        device_id: device.id,
        disconnect_disposition: null,
        id: versionId,
        integration_id: integrationId,
        recorded_at: now,
        status: "connected",
        user_id: input.userId,
        version_number: revision,
      })
      .execute();
    if (root) {
      await transaction
        .updateTable("platform_integration")
        .set({
          consent_granted_at: now,
          current_revision: revision,
          // Reconnect/key rotation begins a new signed cursor epoch. Existing provider source IDs
          // remain the dedupe authority, so a complete reread is safe and never infers deletion.
          cursor_epoch: sql`cursor_epoch + 1`,
          current_source_cursor: null,
          current_version_id: versionId,
          device_id: device.id,
          disconnected_at: null,
          status: "connected",
        })
        .where("id", "=", root.id)
        .execute();
      root = { ...root, current_revision: revision };
    }
    const result = {
      integration: await loadPlatformIntegration(transaction, input.userId, integrationId),
      replayed: false,
    };
    await recordFeatureOperation(
      transaction,
      input,
      "integration",
      "consent",
      integrationId,
      result,
    );
    return result;
  });
}

export async function listPlatformIntegrations(
  database: Kysely<Database>,
  input: { readonly userId: string },
): Promise<readonly PlatformIntegrationRecord[]> {
  await requireActiveProfile(database, input.userId, false);
  const rows = await database
    .selectFrom("platform_integration")
    .select("id")
    .where("user_id", "=", input.userId)
    .orderBy("platform")
    .execute();
  return Promise.all(rows.map((row) => loadPlatformIntegration(database, input.userId, row.id)));
}

/**
 * Rebinds an already-consented integration after key/device recovery. The signed source cursor
 * starts a new epoch at null; immutable provider source IDs make the subsequent full reread
 * idempotent and prevent absence in that reread from being interpreted as deletion.
 */
export async function rebindPlatformIntegration(
  database: Kysely<Database>,
  input: RebindPlatformIntegrationInput,
): Promise<PlatformIntegrationMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<PlatformIntegrationMutationResult>(
      transaction,
      input,
      "integration",
      "rebind",
    );
    if (replay) return { ...replay, replayed: true };
    const device = await transaction
      .selectFrom("device_registration")
      .select("id")
      .where("id", "=", input.deviceId)
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("revoked_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!device) throw new RetentionNotFoundError();
    const root = await transaction
      .selectFrom("platform_integration")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("status", "=", "connected")
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionConsentRequiredError();
    if (root.current_revision !== canonicalRevision(input.expectedRevision))
      throw new RetentionRevisionConflictError();
    const now = await transactionClock(transaction, input.occurredAt);
    const revision = (BigInt(root.current_revision) + 1n).toString();
    const versionId = randomUUID();
    await transaction
      .insertInto("platform_integration_version")
      .values({
        data_type_codes: ["body_weight"],
        device_id: device.id,
        disconnect_disposition: null,
        id: versionId,
        integration_id: root.id,
        recorded_at: now,
        status: "connected",
        user_id: input.userId,
        version_number: revision,
      })
      .execute();
    await transaction
      .updateTable("platform_integration")
      .set({
        current_revision: revision,
        cursor_epoch: sql`cursor_epoch + 1`,
        current_source_cursor: null,
        current_version_id: versionId,
        device_id: device.id,
        last_import_at: null,
      })
      .where("id", "=", root.id)
      .execute();
    const result = {
      integration: await loadPlatformIntegration(transaction, input.userId, root.id),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "integration", "rebind", root.id, result);
    return result;
  });
}

export async function disconnectPlatformIntegration(
  database: Kysely<Database>,
  input: DisconnectPlatformIntegrationInput,
): Promise<PlatformIntegrationMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<PlatformIntegrationMutationResult>(
      transaction,
      input,
      "integration",
      "disconnect",
    );
    if (replay) return { ...replay, replayed: true };
    const root = await transaction
      .selectFrom("platform_integration")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("status", "=", "connected")
      .forUpdate()
      .executeTakeFirst();
    if (!root) throw new RetentionNotFoundError();
    if (root.current_revision !== canonicalRevision(input.expectedRevision))
      throw new RetentionRevisionConflictError();
    const now = await transactionClock(transaction, input.occurredAt);
    const revision = (BigInt(root.current_revision) + 1n).toString();
    const versionId = randomUUID();
    if (input.importedDataDisposition === "delete") {
      const events = await transaction
        .selectFrom("platform_health_import")
        .select("current_event_id")
        .where("integration_id", "=", root.id)
        .where("current_event_id", "is not", null)
        .execute();
      await transaction
        .deleteFrom("platform_health_import")
        .where("integration_id", "=", root.id)
        .execute();
      const eventIds = events.flatMap((row) =>
        row.current_event_id ? [row.current_event_id] : [],
      );
      if (eventIds.length)
        await transaction.deleteFrom("biometric_event").where("id", "in", eventIds).execute();
    }
    await transaction
      .insertInto("platform_integration_version")
      .values({
        data_type_codes: ["body_weight"],
        device_id: root.device_id,
        disconnect_disposition: input.importedDataDisposition,
        id: versionId,
        integration_id: root.id,
        recorded_at: now,
        status: "disconnected",
        user_id: input.userId,
        version_number: revision,
      })
      .execute();
    await transaction
      .updateTable("platform_integration")
      .set({
        current_revision: revision,
        current_source_cursor:
          input.importedDataDisposition === "delete" ? null : root.current_source_cursor,
        current_version_id: versionId,
        disconnected_at: now,
        status: "disconnected",
      })
      .where("id", "=", root.id)
      .execute();
    const result = {
      integration: await loadPlatformIntegration(transaction, input.userId, root.id),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "integration", "disconnect", root.id, result);
    return result;
  });
}

export async function applyPlatformHealthImportBatch(
  database: Kysely<Database>,
  input: ApplyPlatformHealthImportBatchInput,
): Promise<PlatformHealthImportBatchResult> {
  validateOperation(input);
  requireDigest(input.nonceHash, "nonceHash");
  requireDigest(input.batchDigest, "batchDigest");
  requireDigest(input.signatureDigest, "signatureDigest");
  if (input.records.length > 1_000)
    throw new RetentionValidationError("Import batch exceeds 1000 records");
  if (new Set(input.records.map((record) => record.externalId)).size !== input.records.length)
    throw new RetentionValidationError("Import batch contains duplicate source identifiers");
  const signedAt = canonicalInstant(input.signedAt);
  const cursorEpoch = canonicalCursorEpoch(input.cursorEpoch);
  const nextCursor = boundedText(input.nextSourceCursor, 1_000, "nextSourceCursor");
  const sourceCursor =
    input.sourceCursor === null ? null : boundedText(input.sourceCursor, 1_000, "sourceCursor");
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const integration = await transaction
      .selectFrom("platform_integration")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("device_id", "=", input.deviceId)
      .where("status", "=", "connected")
      .forUpdate()
      .executeTakeFirst();
    if (!integration) throw new RetentionConsentRequiredError();
    if (integration.cursor_epoch !== cursorEpoch) throw new RetentionImportConflictError();
    const device = await transaction
      .selectFrom("device_registration")
      .select("id")
      .where("id", "=", input.deviceId)
      .where("user_id", "=", input.userId)
      .where("platform", "=", input.platform)
      .where("revoked_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!device) throw new RetentionNotFoundError();
    const existing = await transaction
      .selectFrom("platform_import_batch")
      .selectAll()
      .where("integration_id", "=", integration.id)
      .where("batch_id", "=", input.batchId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        existing.batch_digest !== input.batchDigest ||
        existing.signature_digest !== input.signatureDigest ||
        existing.nonce_hash !== input.nonceHash ||
        existing.cursor_epoch !== cursorEpoch ||
        existing.source_cursor !== sourceCursor ||
        existing.next_source_cursor !== nextCursor
      )
        throw new RetentionIdempotencyConflictError();
      return {
        ...(existing.result_payload as unknown as PlatformHealthImportBatchResult),
        replayed: true,
      };
    }
    if (input.isTimestampFresh !== true)
      throw new RetentionValidationError("Signed import timestamp is outside the accepted window");
    if (integration.current_source_cursor !== sourceCursor)
      throw new RetentionImportConflictError();
    const definition = await loadBodyWeightDefinition(transaction, input.userId);
    const conflicts: PlatformHealthImportBatchResult["conflicts"] extends readonly (infer C)[]
      ? C[]
      : never = [];
    let accepted = 0;
    let deleted = 0;
    let duplicates = 0;
    for (const record of input.records) {
      const result = await applyPlatformImportRecord(transaction, {
        batchId: input.batchId,
        definition,
        deviceId: input.deviceId,
        integrationId: integration.id,
        platform: input.platform,
        record,
        signedAt,
        userId: input.userId,
      });
      if (result.conflict) conflicts.push(result.conflict);
      else if (result.duplicate) duplicates += 1;
      else if (result.applied && record.operation === "delete") deleted += 1;
      else if (result.applied) accepted += 1;
    }
    const result: PlatformHealthImportBatchResult = {
      accepted,
      conflicts,
      deleted,
      duplicates,
      replayed: false,
    };
    await transaction
      .insertInto("platform_import_batch")
      .values({
        batch_digest: input.batchDigest,
        batch_id: input.batchId,
        cursor_epoch: cursorEpoch,
        device_id: input.deviceId,
        integration_id: integration.id,
        next_source_cursor: nextCursor,
        nonce_hash: input.nonceHash,
        record_count: input.records.length,
        request_digest: input.requestDigest,
        result_payload: result as unknown as JsonObject,
        signature_digest: input.signatureDigest,
        signed_at: signedAt,
        source_cursor: sourceCursor,
        user_id: input.userId,
      })
      .execute();
    await transaction
      .updateTable("platform_integration")
      .set({ current_source_cursor: nextCursor, last_import_at: signedAt })
      .where("id", "=", integration.id)
      .execute();
    await recordFeatureOperation(transaction, input, "import", "batch", input.batchId, result);
    return result;
  });
}

export async function createPrivacyExportJob(
  database: Kysely<Database>,
  input: CreatePrivacyExportJobInput,
): Promise<{ readonly job: PrivacyExportJobRecord; readonly replayed: boolean }> {
  validateOperation(input);
  requireDigest(input.sessionTokenHash, "sessionTokenHash");
  requireDigest(input.proofTokenHash, "proofTokenHash");
  const requestedFormats = canonicalExportFormats(input.requestedFormats);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const existing = await transaction
      .selectFrom("privacy_export_job")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("client_operation_id", "=", input.clientOperationId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        canonicalJson(existing.requested_formats as JsonValue) !==
          canonicalJson(requestedFormats as JsonValue)
      )
        throw new RetentionIdempotencyConflictError();
      return { job: await loadExportJobRecord(transaction, existing), replayed: true };
    }
    const active = await transaction
      .selectFrom("privacy_export_job")
      .select("id")
      .where("user_id", "=", input.userId)
      .where("status", "in", ["queued", "running", "failed"])
      .where("dead_lettered_at", "is", null)
      .executeTakeFirst();
    if (active) throw new RetentionExportInProgressError();
    await consumeReauthenticationProofInTransaction(
      transaction,
      {
        clientOperationId: input.clientOperationId,
        purpose: "account_export",
        sessionTokenHash: input.sessionTokenHash,
        tokenHash: input.proofTokenHash,
        userId: input.userId,
      },
      await transactionClock(transaction),
    );
    const row = await transaction
      .insertInto("privacy_export_job")
      .values({
        client_operation_id: input.clientOperationId,
        request_digest: input.requestDigest,
        requested_formats: requestedFormats,
        user_id: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { job: await loadExportJobRecord(transaction, row), replayed: false };
  });
}
export async function getPrivacyExportJob(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly jobId: string },
): Promise<PrivacyExportJobRecord> {
  await requireActiveProfile(database, input.userId, false);
  const row = await database
    .selectFrom("privacy_export_job")
    .selectAll()
    .where("id", "=", input.jobId)
    .where("user_id", "=", input.userId)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return loadExportJobRecord(database, row);
}
/** Records only bounded, owner-verified download lifecycle metadata; no object/key/request data. */
export async function recordPrivacyExportArtifactDownloadAudit(
  database: Kysely<Database>,
  input: RecordPrivacyExportArtifactDownloadAuditInput,
): Promise<void> {
  const format = input.format === "csv" ? "csv_zip" : "json";
  const occurredAt = canonicalInstant(input.occurredAt);
  await database.transaction().execute(async (transaction) => {
    await requireActiveProfile(transaction, input.userId, false);
    const artifact = await transaction
      .selectFrom("privacy_export_job as job")
      .innerJoin("privacy_export_artifact as artifact", "artifact.job_id", "job.id")
      .select("artifact.id")
      .where("job.id", "=", input.jobId)
      .where("job.user_id", "=", input.userId)
      .where("job.status", "=", "completed")
      .where("artifact.format", "=", format)
      .executeTakeFirst();
    if (!artifact) throw new RetentionNotFoundError();
    await transaction
      .insertInto("privacy_export_download_audit")
      .values({
        format,
        job_id: input.jobId,
        occurred_at: occurredAt,
        outcome: input.outcome,
        user_id: input.userId,
      })
      .execute();
  });
}
export async function claimPrivacyExportJobs(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly now: string; readonly limit?: number },
): Promise<readonly PrivacyExportJobRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  const workerId = boundedText(input.workerId, 200, "workerId");
  return database.transaction().execute(async (transaction) => {
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        cancelled_at: sql`coalesce(cancelled_at,${new Date(now)}::timestamptz)`,
        status: "cancelled",
        upload_lease_expires_at: null,
      })
      .where("status", "=", "uploading")
      .where("upload_lease_expires_at", "<=", new Date(now))
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job as retry_job")
            .select("retry_job.id")
            .whereRef("retry_job.id", "=", "privacy_export_upload_artifact.job_id")
            .where("retry_job.status", "in", ["failed", "running"])
            .where((condition) =>
              condition.or([
                condition("retry_job.status", "=", "failed"),
                condition("retry_job.locked_at", "<=", staleBefore),
              ]),
            ),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ cancelled_at: sql`coalesce(cancelled_at,${new Date(now)}::timestamptz)` })
      .where("status", "=", "uploading")
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job as retry_job")
            .select("retry_job.id")
            .whereRef("retry_job.id", "=", "privacy_export_upload_artifact.job_id")
            .where("retry_job.status", "in", ["failed", "running"])
            .where((condition) =>
              condition.or([
                condition("retry_job.status", "=", "failed"),
                condition("retry_job.locked_at", "<=", staleBefore),
              ]),
            ),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        available_at: new Date(now),
        cancelled_at: sql`coalesce(cancelled_at,${new Date(now)}::timestamptz)`,
        locked_at: null,
        locked_by: null,
        status: "cancelled",
      })
      .where("status", "in", ["staged", "uploaded"])
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job as retry_job")
            .select("retry_job.id")
            .whereRef("retry_job.id", "=", "privacy_export_upload_artifact.job_id")
            .where("retry_job.status", "in", ["failed", "running"])
            .where((condition) =>
              condition.or([
                condition("retry_job.status", "=", "failed"),
                condition("retry_job.locked_at", "<=", staleBefore),
              ]),
            ),
        ),
      )
      .execute();
    const newlyDeadLettered = await transaction
      .updateTable("privacy_export_job")
      .set({
        dead_lettered_at: now,
        failure_code: "EXPORT_FAILED",
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("status", "!=", "completed")
      .where("attempt_count", ">=", 20)
      .where("dead_lettered_at", "is", null)
      .where((builder) =>
        builder.or([
          builder.and([
            builder("status", "in", ["queued", "failed"]),
            builder("locked_at", "is", null),
          ]),
          builder.and([builder("status", "=", "running"), builder("locked_at", "<=", staleBefore)]),
        ]),
      )
      .returning(["attempt_count", "id"])
      .execute();
    for (const row of newlyDeadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: now,
        recoveryKind: "privacy_export",
        targetId: row.id,
      });
    await transaction
      .deleteFrom("privacy_export_record")
      .where(
        "job_id",
        "in",
        transaction
          .selectFrom("privacy_export_job")
          .select("id")
          .where("dead_lettered_at", "is not", null),
      )
      .execute();
    await transaction
      .deleteFrom("privacy_export_entity_snapshot")
      .where(
        "job_id",
        "in",
        transaction
          .selectFrom("privacy_export_job")
          .select("id")
          .where("dead_lettered_at", "is not", null),
      )
      .execute();
    const rows = await transaction
      .selectFrom("privacy_export_job")
      .selectAll()
      .where("attempt_count", "<", 20)
      .where("dead_lettered_at", "is", null)
      .where((builder) =>
        builder.not(
          builder.exists(
            builder
              .selectFrom("privacy_export_upload_artifact")
              .select("id")
              .whereRef("job_id", "=", "privacy_export_job.id")
              .where("status", "=", "uploading"),
          ),
        ),
      )
      .where(
        sql<boolean>`((status in ('queued','failed') and available_at <= ${new Date(now)}) or
          (status = 'running' and locked_at <= ${staleBefore}))`,
      )
      .orderBy("created_at")
      .forUpdate()
      .skipLocked()
      .limit(boundedLimit(input.limit, 20))
      .execute();
    const claimed = [];
    for (const row of rows) {
      await transaction.deleteFrom("privacy_export_record").where("job_id", "=", row.id).execute();
      await transaction
        .deleteFrom("privacy_export_entity_snapshot")
        .where("job_id", "=", row.id)
        .execute();
      const updated = await transaction
        .updateTable("privacy_export_job")
        .set({
          attempt_count: sql`attempt_count + 1`,
          entity_count: null,
          failure_code: null,
          locked_at: now,
          locked_by: workerId,
          semantic_reconciliation_digest: null,
          snapshot_bytes: null,
          snapshot_id: null,
          started_at: row.started_at ?? now,
          status: "running",
          watermark_revision: null,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      claimed.push(await loadExportJobRecord(transaction, updated));
    }
    return claimed;
  });
}
export async function withPrivacyExportSnapshot<T>(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly maximumSnapshotBytes: number;
  },
  callback: (snapshot: PrivacyExportSnapshotContext) => Promise<T>,
): Promise<T> {
  const workerId = boundedText(input.workerId, 200, "workerId");
  if (
    !Number.isSafeInteger(input.maximumSnapshotBytes) ||
    input.maximumSnapshotBytes < 1 ||
    input.maximumSnapshotBytes > MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES
  )
    throw new RetentionValidationError("maximumSnapshotBytes is invalid");
  const materialized = await database
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (transaction) => {
      // PG17 transaction_timeout is the beta safety budget for coherent capture. It bounds xmin
      // retention even for an unexpectedly large account; external fsync/upload never runs here.
      await sql.raw("set local transaction_timeout = '300s'").execute(transaction);
      await lockRetentionUser(transaction, input.userId);
      const profile = await requireActiveProfile(transaction, input.userId, true);
      const job = await transaction
        .selectFrom("privacy_export_job")
        .selectAll()
        .where("id", "=", input.jobId)
        .where("user_id", "=", input.userId)
        .where("status", "=", "running")
        .where("locked_by", "=", workerId)
        .forUpdate()
        .executeTakeFirst();
      if (!job) throw new RetentionNotFoundError();
      const snapshotResult = await sql<{
        snapshot: string;
      }>`select txid_current_snapshot()::text snapshot`.execute(transaction);
      const snapshotId = snapshotResult.rows[0]?.snapshot;
      if (!snapshotId) throw new RetentionExportNotReadyError();
      await assertPrivacyExportSchemaClassified(transaction);
      const entities = await countPrivacyExportEntities(
        transaction,
        input.userId,
        input.jobId,
        profile.watermarkRevision,
      );
      const semanticEvidence = await computePrivacyExportSemanticEvidence(
        transaction,
        input.userId,
      );
      const total = entities.reduce((sum, entity) => sum + BigInt(entity.sourceCount), 0n);
      // A prior failed worker attempt may have completed only the coherent DB snapshot phase.
      // Those unpublished staging rows are replaced as one transaction for the new attempt.
      await transaction
        .deleteFrom("privacy_export_entity_snapshot")
        .where("job_id", "=", job.id)
        .execute();
      await transaction.deleteFrom("privacy_export_record").where("job_id", "=", job.id).execute();
      const materializedEntities: PrivacyExportEntitySnapshotRecord[] = [];
      let snapshotBytes = 0;
      for (const [entityIndex, entity] of entities.entries()) {
        const ordinalBase = entities
          .slice(0, entityIndex)
          .reduce((sum, candidate) => sum + BigInt(candidate.sourceCount), 0n);
        let cursor: string | null = null;
        let materializedCount = 0n;
        const recordSetHash = createHash("sha256");
        do {
          const page = await pagePrivacyExportEntity(transaction, {
            cursor,
            entity: entity.entity,
            jobId: job.id,
            limit: 1_000,
            ordinalBase,
            snapshot: entity,
            userId: input.userId,
          });
          for (const record of page.records) {
            const line = `${canonicalJson(record)}\n`;
            snapshotBytes += Buffer.byteLength(line, "utf8");
            if (snapshotBytes > input.maximumSnapshotBytes)
              throw new RetentionExportTooLargeError();
            recordSetHash.update(line, "utf8");
          }
          if (page.records.length)
            await transaction
              .insertInto("privacy_export_record")
              .values(
                page.records.map((record) => ({
                  deleted: record.deleted,
                  entity_id: record.entityId,
                  entity_type: record.entityType,
                  job_id: job.id,
                  ordinal: record.ordinal,
                  payload: record.payload,
                  payload_sha256: record.payloadSha256,
                  revision: record.revision,
                  watermark_revision: record.watermark,
                })),
              )
              .execute();
          materializedCount += BigInt(page.records.length);
          cursor = page.nextCursor;
        } while (cursor);
        if (materializedCount !== BigInt(entity.sourceCount))
          throw new RetentionExportNotReadyError();
        materializedEntities.push({
          ...entity,
          sourceRecordSetSha256: recordSetHash.digest("hex"),
        });
      }
      if (materializedEntities.length)
        await transaction
          .insertInto("privacy_export_entity_snapshot")
          .values(
            materializedEntities.map((entity) => ({
              entity_type: entity.entity,
              job_id: job.id,
              source_count: entity.sourceCount,
              source_record_set_sha256: entity.sourceRecordSetSha256,
              watermark_revision: entity.watermarkRevision,
            })),
          )
          .execute();
      await transaction
        .updateTable("privacy_export_job")
        .set({
          entity_count: total.toString(),
          semantic_reconciliation_digest: semanticEvidence.digest,
          snapshot_bytes: snapshotBytes.toString(),
          snapshot_id: snapshotId,
          watermark_revision: profile.watermarkRevision,
        })
        .where("id", "=", job.id)
        .execute();
      return {
        byEntity: new Map(materializedEntities.map((entity) => [entity.entity, entity])),
        entities: materializedEntities,
        semanticEvidence,
        snapshotId,
        snapshotWatermark: profile.watermarkRevision,
      };
    });
  // The coherent source rows are now an immutable DB spool. The worker callback and all local
  // fsync/object-store work happen after the REPEATABLE READ transaction has closed, so neither
  // external latency nor a large account pins the primary's xmin horizon.
  return callback({
    entities: materialized.entities,
    jobId: input.jobId,
    page: async (pageInput) => {
      const snapshot = materialized.byEntity.get(pageInput.entity);
      if (!snapshot) throw new RetentionValidationError("Unknown privacy export entity");
      return pageMaterializedPrivacyExportEntity(database, {
        ...pageInput,
        jobId: input.jobId,
        snapshot,
        snapshotId: materialized.snapshotId,
        userId: input.userId,
        workerId,
      });
    },
    snapshotId: materialized.snapshotId,
    snapshotWatermark: materialized.snapshotWatermark,
    semanticEvidence: materialized.semanticEvidence,
  });
}

/** Registers every final object key before external upload so erasure can discover and fence it. */
export async function stagePrivacyExportArtifacts(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifacts: readonly {
      readonly format: "csv" | "json";
      readonly objectKey: string;
    }[];
  },
): Promise<readonly StagedPrivacyExportArtifactRecord[]> {
  const workerId = boundedText(input.workerId, 200, "workerId");
  const snapshotId = boundedText(input.snapshotId, 500, "snapshotId");
  const formats = canonicalExportFormats(input.artifacts.map((artifact) => artifact.format));
  const artifacts = input.artifacts.map((artifact) => ({
    format: artifact.format,
    objectKey: boundedText(artifact.objectKey, 1_000, "objectKey"),
  }));
  if (new Set(artifacts.map((artifact) => artifact.objectKey)).size !== artifacts.length)
    throw new RetentionValidationError("Export object keys must be unique");
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const job = await transaction
      .selectFrom("privacy_export_job")
      .selectAll()
      .where("id", "=", input.jobId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "running")
      .where("locked_by", "=", workerId)
      .forUpdate()
      .executeTakeFirst();
    if (!job || job.snapshot_id !== snapshotId) throw new RetentionExportNotReadyError();
    const required = canonicalExportFormats(job.requested_formats);
    if (formats.length !== required.length || formats.some((format) => !required.includes(format)))
      throw new RetentionExportNotReadyError();
    const existing = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .selectAll()
      .where("job_id", "=", job.id)
      .where("snapshot_id", "=", snapshotId)
      .orderBy("format")
      .forUpdate()
      .execute();
    if (existing.length) {
      if (
        existing.length !== artifacts.length ||
        existing.some((row) => {
          const format = row.format === "csv_zip" ? "csv" : "json";
          return (
            artifacts.find((artifact) => artifact.format === format)?.objectKey !== row.object_key
          );
        })
      )
        throw new RetentionIdempotencyConflictError();
      return existing.map(mapStagedPrivacyExportArtifact);
    }
    const rows = await transaction
      .insertInto("privacy_export_upload_artifact")
      .values(
        artifacts.map((artifact) => ({
          format: artifact.format === "csv" ? "csv_zip" : "json",
          job_id: job.id,
          object_key: artifact.objectKey,
          snapshot_id: snapshotId,
          worker_id: workerId,
        })),
      )
      .returningAll()
      .execute();
    return rows.map(mapStagedPrivacyExportArtifact);
  });
}

export async function markPrivacyExportStagedArtifactUploaded(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly uploadedAt: string;
  },
): Promise<StagedPrivacyExportArtifactRecord> {
  const uploadedAt = canonicalInstant(input.uploadedAt);
  const outcome = await database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_upload_artifact as artifact")
      .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
      .selectAll("artifact")
      .where("artifact.id", "=", input.artifactId)
      .where("artifact.job_id", "=", input.jobId)
      .where("artifact.snapshot_id", "=", boundedText(input.snapshotId, 500, "snapshotId"))
      .where("artifact.worker_id", "=", boundedText(input.workerId, 200, "workerId"))
      .where("artifact.status", "=", "uploading")
      .where("job.user_id", "=", input.userId)
      .forUpdate("artifact")
      .executeTakeFirst();
    if (!row) throw new RetentionExportNotReadyError();
    if (
      row.cancelled_at ||
      row.upload_lease_expires_at === null ||
      row.upload_lease_expires_at <= new Date(uploadedAt)
    ) {
      const cancelled = await transaction
        .updateTable("privacy_export_upload_artifact")
        .set({
          cancelled_at: row.cancelled_at ?? uploadedAt,
          status: "cancelled",
          upload_lease_expires_at: null,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { cancelled: true, row: cancelled };
    }
    const uploaded = await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ status: "uploaded", upload_lease_expires_at: null, uploaded_at: uploadedAt })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { cancelled: false, row: uploaded };
  });
  if (outcome.cancelled) throw new RetentionExportNotReadyError();
  return mapStagedPrivacyExportArtifact(outcome.row);
}

export async function beginPrivacyExportStagedArtifactUpload(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly startedAt: string;
    readonly leaseExpiresAt: string;
  },
): Promise<StagedPrivacyExportArtifactRecord> {
  const startedAt = canonicalInstant(input.startedAt);
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt);
  const leaseMilliseconds = Date.parse(leaseExpiresAt) - Date.parse(startedAt);
  if (leaseMilliseconds <= 0 || leaseMilliseconds > 15 * 60_000)
    throw new RetentionValidationError("Upload lease must be positive and at most 15 minutes");
  const row = await database
    .updateTable("privacy_export_upload_artifact")
    .set({
      available_at: leaseExpiresAt,
      status: "uploading",
      upload_lease_expires_at: leaseExpiresAt,
    })
    .where("id", "=", input.artifactId)
    .where("job_id", "=", input.jobId)
    .where("snapshot_id", "=", boundedText(input.snapshotId, 500, "snapshotId"))
    .where("worker_id", "=", boundedText(input.workerId, 200, "workerId"))
    .where("status", "=", "staged")
    .where((builder) =>
      builder.exists(
        builder
          .selectFrom("privacy_export_job")
          .select("id")
          .whereRef("id", "=", "privacy_export_upload_artifact.job_id")
          .where("user_id", "=", input.userId)
          .where("status", "=", "running"),
      ),
    )
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new RetentionExportNotReadyError();
  return mapStagedPrivacyExportArtifact(row);
}

/** Extends an active PUT fence; callers heartbeat while a single object-store request is pending. */
export async function renewPrivacyExportStagedArtifactUploadLease(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly renewedAt: string;
    readonly leaseExpiresAt: string;
  },
): Promise<void> {
  const renewedAt = canonicalInstant(input.renewedAt);
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt);
  const leaseMilliseconds = Date.parse(leaseExpiresAt) - Date.parse(renewedAt);
  if (leaseMilliseconds <= 0 || leaseMilliseconds > 15 * 60_000)
    throw new RetentionValidationError("Upload lease must be positive and at most 15 minutes");
  const workerId = boundedText(input.workerId, 200, "workerId");
  await database.transaction().execute(async (transaction) => {
    const job = await transaction
      .updateTable("privacy_export_job")
      .set({ locked_at: renewedAt })
      .where("id", "=", input.jobId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "running")
      .where("locked_by", "=", workerId)
      .executeTakeFirst();
    if (job.numUpdatedRows !== 1n) throw new RetentionExportNotReadyError();
    const artifact = await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ available_at: leaseExpiresAt, upload_lease_expires_at: leaseExpiresAt })
      .where("id", "=", input.artifactId)
      .where("job_id", "=", input.jobId)
      .where("snapshot_id", "=", boundedText(input.snapshotId, 500, "snapshotId"))
      .where("worker_id", "=", workerId)
      .where("status", "=", "uploading")
      .where("cancelled_at", "is", null)
      .where("upload_lease_expires_at", ">", new Date(renewedAt))
      .executeTakeFirst();
    if (artifact.numUpdatedRows !== 1n) throw new RetentionExportNotReadyError();
  });
}

export async function completePrivacyExportStagedArtifactDeletion(
  database: Kysely<Database>,
  input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly deletedAt: string;
    readonly deletionEvidenceDigest: string;
  },
): Promise<void> {
  requireDigest(input.deletionEvidenceDigest, "deletionEvidenceDigest");
  const result = await database
    .updateTable("privacy_export_upload_artifact")
    .set({
      deleted_at: canonicalInstant(input.deletedAt),
      deletion_evidence_digest: input.deletionEvidenceDigest,
      last_error_code: null,
      locked_at: null,
      locked_by: null,
      status: "deleted",
    })
    .where("id", "=", input.artifactId)
    .where("status", "=", "cancelled")
    .where("available_at", "<=", new Date(canonicalInstant(input.deletedAt)))
    .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new RetentionNotFoundError();
}

export async function claimCancelledPrivacyExportStagedArtifacts(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly now: string; readonly limit?: number },
): Promise<readonly ClaimedStagedPrivacyExportArtifactDeletionRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  const workerId = boundedText(input.workerId, 200, "workerId");
  return database.transaction().execute(async (transaction) => {
    const newlyDeadLettered = await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        dead_lettered_at: now,
        last_error_code: "STAGED_ARTIFACT_DELETE_ATTEMPTS_EXHAUSTED",
        locked_at: null,
        locked_by: null,
      })
      .where("status", "=", "cancelled")
      .where("attempt_count", ">=", 20)
      .where("dead_lettered_at", "is", null)
      .where((builder) =>
        builder.or([builder("locked_at", "is", null), builder("locked_at", "<=", staleBefore)]),
      )
      .returning("id")
      .execute();
    for (const row of newlyDeadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: now,
        recoveryKind: "staged_artifact_deletion",
        targetId: row.id,
      });
    const rows = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .selectAll()
      .where("status", "=", "cancelled")
      .where("attempt_count", "<", 20)
      .where("dead_lettered_at", "is", null)
      .where("available_at", "<=", new Date(now))
      .where((builder) =>
        builder.or([builder("locked_at", "is", null), builder("locked_at", "<=", staleBefore)]),
      )
      .orderBy("staged_at")
      .forUpdate()
      .skipLocked()
      .limit(boundedLimit(input.limit, 20))
      .execute();
    const claimed: ClaimedStagedPrivacyExportArtifactDeletionRecord[] = [];
    for (const row of rows) {
      const updated = await transaction
        .updateTable("privacy_export_upload_artifact")
        .set({
          attempt_count: sql`attempt_count + 1`,
          locked_at: now,
          locked_by: workerId,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      claimed.push({
        artifactId: updated.id,
        attemptCount: updated.attempt_count,
        format: updated.format === "csv_zip" ? "csv" : "json",
        jobId: updated.job_id,
        objectKey: updated.object_key,
        snapshotId: updated.snapshot_id,
      });
    }
    return claimed;
  });
}

export async function failPrivacyExportStagedArtifactDeletion(
  database: Kysely<Database>,
  input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly retryAt: string;
    readonly errorCode: string;
  },
): Promise<RetentionRetryDisposition> {
  const retryAt = canonicalInstant(input.retryAt);
  const workerId = boundedText(input.workerId, 200, "workerId");
  const errorCode = boundedText(input.errorCode, 100, "errorCode");
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .select(["attempt_count", "id"])
      .where("id", "=", input.artifactId)
      .where("status", "=", "cancelled")
      .where("locked_by", "=", workerId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    const disposition = retentionRetryDisposition(row.attempt_count);
    if (disposition.deadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: new Date(),
        recoveryKind: "staged_artifact_deletion",
        targetId: row.id,
      });
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        available_at: retryAt,
        dead_lettered_at: disposition.deadLettered ? new Date() : null,
        last_error_code: errorCode,
        locked_at: null,
        locked_by: null,
      })
      .where("id", "=", row.id)
      .execute();
    return disposition;
  });
}

export async function requeueDeadLetteredPrivacyExportStagedArtifactDeletion(
  database: Kysely<Database>,
  input: RequeueDeadLetteredRetentionCleanupInput,
): Promise<RetentionRecoveryRecord> {
  requireDigest(input.approvalDigest, "approvalDigest");
  const requeuedAt = canonicalInstant(input.requeuedAt);
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .select("id")
      .where("id", "=", input.artifactId)
      .where("status", "=", "cancelled")
      .where("attempt_count", "=", 20)
      .where("dead_lettered_at", "is not", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    await insertRetentionJobRecoveryAudit(transaction, {
      approvalDigest: input.approvalDigest,
      recoveryKind: "staged_artifact_deletion",
      requeuedAt,
      targetId: row.id,
    });
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        attempt_count: 0,
        available_at: requeuedAt,
        dead_lettered_at: null,
        last_error_code: null,
        locked_at: null,
        locked_by: null,
      })
      .where("id", "=", row.id)
      .execute();
    return {
      recoveryKind: "staged_artifact_deletion",
      requeuedAt,
      targetId: row.id,
    };
  });
}

export async function completePrivacyExportJob(
  database: Kysely<Database>,
  input: CompletePrivacyExportJobInput,
): Promise<PrivacyExportJobRecord> {
  requireDigest(input.manifestDigest, "manifestDigest");
  const snapshotId = boundedText(input.snapshotId, 500, "snapshotId");
  const artifacts = validatePrivacyExportArtifacts(input.artifacts);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const job = await transaction
      .selectFrom("privacy_export_job")
      .selectAll()
      .where("id", "=", input.jobId)
      .where("user_id", "=", input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!job) throw new RetentionNotFoundError();
    if (job.status === "completed") {
      if (job.manifest_digest !== input.manifestDigest)
        throw new RetentionIdempotencyConflictError();
      return loadExportJobRecord(transaction, job);
    }
    if (
      job.status !== "running" ||
      !job.snapshot_id ||
      job.snapshot_id !== snapshotId ||
      !job.watermark_revision
    )
      throw new RetentionExportNotReadyError();
    const snapshots = await loadExportEntitySnapshots(transaction, job.id);
    if (!job.semantic_reconciliation_digest) throw new RetentionExportNotReadyError();
    assertExportReconciliation(
      job.watermark_revision,
      job.semantic_reconciliation_digest,
      snapshots,
      input.reconciliation,
    );
    const required = canonicalExportFormats(job.requested_formats);
    if (
      artifacts.length !== required.length ||
      artifacts.some((artifact) => !required.includes(artifact.format))
    )
      throw new RetentionExportNotReadyError();
    const stagedArtifacts = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .selectAll()
      .where("job_id", "=", job.id)
      .where("snapshot_id", "=", snapshotId)
      .where("status", "=", "uploaded")
      .forUpdate()
      .execute();
    const pendingPriorArtifacts = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .select("id")
      .where("job_id", "=", job.id)
      .where("snapshot_id", "!=", snapshotId)
      .where("status", "!=", "deleted")
      .executeTakeFirst();
    if (pendingPriorArtifacts) throw new RetentionExportNotReadyError();
    if (
      stagedArtifacts.length !== artifacts.length ||
      stagedArtifacts.some((staged) => {
        const format = staged.format === "csv_zip" ? "csv" : "json";
        return (
          artifacts.find((artifact) => artifact.format === format)?.objectKey !== staged.object_key
        );
      })
    )
      throw new RetentionExportNotReadyError();
    const insertedArtifacts = await transaction
      .insertInto("privacy_export_artifact")
      .values(
        artifacts.map((artifact) => ({
          ciphertext_bytes: artifact.ciphertextBytes,
          encryption_key_id: artifact.encryptionKeyId,
          expires_at: artifact.expiresAt,
          file_name: artifact.fileName,
          format: artifact.format === "csv" ? "csv_zip" : "json",
          job_id: job.id,
          media_type: artifact.mediaType,
          object_key: artifact.objectKey,
          plaintext_bytes: artifact.plaintextBytes,
          plaintext_sha256: artifact.plaintextSha256,
        })),
      )
      .returning(["id", "expires_at"])
      .execute();
    await transaction
      .insertInto("privacy_export_artifact_deletion")
      .values(
        insertedArtifacts.map((artifact) => ({
          artifact_id: artifact.id,
          available_at: artifact.expires_at,
        })),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ status: "promoted" })
      .where("job_id", "=", job.id)
      .where("snapshot_id", "=", snapshotId)
      .where("status", "=", "uploaded")
      .execute();
    // The immutable object artifacts and the bounded reconciliation manifest are the durable
    // result. The full canonical DB spool is transient and must not duplicate account data after
    // successful reconciliation.
    await transaction.deleteFrom("privacy_export_record").where("job_id", "=", job.id).execute();
    await transaction
      .deleteFrom("privacy_export_entity_snapshot")
      .where("job_id", "=", job.id)
      .execute();
    const expiresAt = artifacts.map((artifact) => artifact.expiresAt).sort()[0];
    if (!expiresAt) throw new RetentionExportNotReadyError();
    const row = await transaction
      .updateTable("privacy_export_job")
      .set({
        completed_at: new Date(),
        expires_at: expiresAt,
        locked_at: null,
        locked_by: null,
        manifest_digest: input.manifestDigest,
        reconciliation: input.reconciliation as unknown as JsonObject,
        status: "completed",
      })
      .where("id", "=", job.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return loadExportJobRecord(transaction, row);
  });
}

export async function failPrivacyExportJob(
  database: Kysely<Database>,
  input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly retryAt: string;
    readonly failureKind: "retryable" | "snapshot_too_large";
  },
): Promise<RetentionRetryDisposition> {
  const retryAt = canonicalInstant(input.retryAt);
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_job")
      .select(["attempt_count", "id"])
      .where("id", "=", input.jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    const disposition =
      input.failureKind === "snapshot_too_large"
        ? { attemptCount: 20, deadLettered: true, retryScheduled: false }
        : retentionRetryDisposition(row.attempt_count);
    if (disposition.deadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: new Date(),
        recoveryKind: "privacy_export",
        targetId: row.id,
      });
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        cancelled_at: new Date(),
        locked_at: null,
        locked_by: null,
        status: "cancelled",
      })
      .where("job_id", "=", row.id)
      .where("status", "in", ["staged", "uploaded"])
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ cancelled_at: sql`coalesce(cancelled_at,clock_timestamp())` })
      .where("job_id", "=", row.id)
      .where("status", "=", "uploading")
      .execute();
    await transaction
      .updateTable("privacy_export_job")
      .set({
        attempt_count: disposition.attemptCount,
        available_at: retryAt,
        dead_lettered_at: disposition.deadLettered ? new Date() : null,
        entity_count: null,
        failure_code: "EXPORT_FAILED",
        locked_at: null,
        locked_by: null,
        semantic_reconciliation_digest: null,
        snapshot_bytes: null,
        snapshot_id: null,
        status: "failed",
        watermark_revision: null,
      })
      .where("id", "=", row.id)
      .execute();
    await transaction.deleteFrom("privacy_export_record").where("job_id", "=", row.id).execute();
    await transaction
      .deleteFrom("privacy_export_entity_snapshot")
      .where("job_id", "=", row.id)
      .execute();
    return disposition;
  });
}

/** Offline/operator-only recovery after terminal failure and verified cleanup of every staged key. */
export async function requeueDeadLetteredPrivacyExportJob(
  database: Kysely<Database>,
  input: RequeueDeadLetteredRetentionJobInput,
): Promise<PrivacyExportJobRecord> {
  requireDigest(input.approvalDigest, "approvalDigest");
  const requeuedAt = canonicalInstant(input.requeuedAt);
  return database.transaction().execute(async (transaction) => {
    const job = await transaction
      .selectFrom("privacy_export_job as job")
      .innerJoin("app_user as account", "account.id", "job.user_id")
      .selectAll("job")
      .where("job.id", "=", input.jobId)
      .where("job.status", "=", "failed")
      .where("job.dead_lettered_at", "is not", null)
      .where("job.attempt_count", "=", 20)
      .where("account.status", "=", "active")
      .forUpdate("job")
      .executeTakeFirst();
    if (!job) throw new RetentionNotFoundError();
    await lockRetentionUser(transaction, job.user_id);
    const active = await transaction
      .selectFrom("privacy_export_job")
      .select("id")
      .where("user_id", "=", job.user_id)
      .where("id", "!=", job.id)
      .where("status", "in", ["queued", "running", "failed"])
      .where("dead_lettered_at", "is", null)
      .executeTakeFirst();
    if (active) throw new RetentionExportInProgressError();
    const dirtyArtifact = await transaction
      .selectFrom("privacy_export_upload_artifact")
      .select("id")
      .where("job_id", "=", job.id)
      .where("status", "!=", "deleted")
      .executeTakeFirst();
    if (dirtyArtifact) throw new RetentionExportNotReadyError();
    await insertRetentionJobRecoveryAudit(transaction, {
      approvalDigest: input.approvalDigest,
      recoveryKind: "privacy_export",
      requeuedAt,
      targetId: job.id,
    });
    const updated = await transaction
      .updateTable("privacy_export_job")
      .set({
        attempt_count: 0,
        available_at: requeuedAt,
        dead_lettered_at: null,
        entity_count: null,
        expires_at: null,
        failure_code: null,
        locked_at: null,
        locked_by: null,
        manifest_digest: null,
        reconciliation: null,
        semantic_reconciliation_digest: null,
        snapshot_bytes: null,
        snapshot_id: null,
        started_at: null,
        status: "queued",
        watermark_revision: null,
      })
      .where("id", "=", job.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return loadExportJobRecord(transaction, updated);
  });
}

export async function claimExpiredPrivacyExportArtifacts(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly now: string; readonly limit?: number },
): Promise<readonly ClaimedPrivacyExportArtifactDeletionRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  const workerId = boundedText(input.workerId, 200, "workerId");
  return database.transaction().execute(async (transaction) => {
    const newlyDeadLettered = await transaction
      .updateTable("privacy_export_artifact_deletion")
      .set({
        dead_lettered_at: now,
        last_error_code: "ARTIFACT_DELETE_ATTEMPTS_EXHAUSTED",
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("status", "!=", "completed")
      .where("attempt_count", ">=", 20)
      .where("dead_lettered_at", "is", null)
      .where((builder) =>
        builder.or([
          builder.and([
            builder("status", "in", ["queued", "failed"]),
            builder("locked_at", "is", null),
          ]),
          builder.and([builder("status", "=", "running"), builder("locked_at", "<=", staleBefore)]),
        ]),
      )
      .returning("artifact_id")
      .execute();
    for (const row of newlyDeadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: now,
        recoveryKind: "artifact_deletion",
        targetId: row.artifact_id,
      });
    const rows = await transaction
      .selectFrom("privacy_export_artifact_deletion as deletion")
      .innerJoin("privacy_export_artifact as artifact", "artifact.id", "deletion.artifact_id")
      .select([
        "deletion.artifact_id",
        "deletion.attempt_count",
        "artifact.format",
        "artifact.job_id",
        "artifact.object_key",
      ])
      .where("deletion.attempt_count", "<", 20)
      .where("deletion.dead_lettered_at", "is", null)
      .where(
        sql<boolean>`((deletion.status in ('queued','failed') and deletion.available_at <= ${new Date(now)}) or
          (deletion.status = 'running' and deletion.locked_at <= ${staleBefore}))`,
      )
      .orderBy("deletion.available_at")
      .orderBy("deletion.artifact_id")
      .forUpdate("deletion")
      .skipLocked()
      .limit(boundedLimit(input.limit, 100))
      .execute();
    const result: ClaimedPrivacyExportArtifactDeletionRecord[] = [];
    for (const row of rows) {
      const updated = await transaction
        .updateTable("privacy_export_artifact_deletion")
        .set({
          attempt_count: sql`attempt_count + 1`,
          last_error_code: null,
          locked_at: now,
          locked_by: workerId,
          status: "running",
        })
        .where("artifact_id", "=", row.artifact_id)
        .returning("attempt_count")
        .executeTakeFirstOrThrow();
      result.push({
        artifactId: row.artifact_id,
        attemptCount: updated.attempt_count,
        format: row.format === "csv_zip" ? "csv" : "json",
        jobId: row.job_id,
        objectKey: row.object_key,
      });
    }
    return result;
  });
}

export async function listAccountPrivacyExportArtifactsForErasure(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly erasureJobId: string;
    readonly workerId: string;
    readonly now: string;
  },
): Promise<readonly AccountPrivacyExportArtifactRecord[]> {
  const now = canonicalInstant(input.now);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    const erasure = await transaction
      .selectFrom("account_erasure_job")
      .select("id")
      .where("id", "=", input.erasureJobId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "running")
      .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate()
      .executeTakeFirst();
    if (!erasure) throw new RetentionNotFoundError();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        attempt_count: sql`attempt_count + 1`,
        cancelled_at: new Date(now),
        locked_at: new Date(now),
        locked_by: boundedText(input.workerId, 200, "workerId"),
        status: "cancelled",
      })
      .where("status", "in", ["staged", "uploaded"])
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job")
            .select("id")
            .whereRef("id", "=", "privacy_export_upload_artifact.job_id")
            .where("user_id", "=", input.userId),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        cancelled_at: sql`coalesce(cancelled_at,${new Date(now)}::timestamptz)`,
        status: "cancelled",
        upload_lease_expires_at: null,
      })
      .where("status", "=", "uploading")
      .where("upload_lease_expires_at", "<=", new Date(now))
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job")
            .select("id")
            .whereRef("id", "=", "privacy_export_upload_artifact.job_id")
            .where("user_id", "=", input.userId),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({ cancelled_at: sql`coalesce(cancelled_at,${new Date(now)}::timestamptz)` })
      .where("status", "=", "uploading")
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job")
            .select("id")
            .whereRef("id", "=", "privacy_export_upload_artifact.job_id")
            .where("user_id", "=", input.userId),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_upload_artifact")
      .set({
        attempt_count: sql`attempt_count + 1`,
        locked_at: new Date(now),
        locked_by: boundedText(input.workerId, 200, "workerId"),
      })
      .where("status", "=", "cancelled")
      .where("available_at", "<=", new Date(now))
      .where("locked_at", "is", null)
      .where((builder) =>
        builder.exists(
          builder
            .selectFrom("privacy_export_job")
            .select("id")
            .whereRef("id", "=", "privacy_export_upload_artifact.job_id")
            .where("user_id", "=", input.userId),
        ),
      )
      .execute();
    await transaction
      .updateTable("privacy_export_job")
      .set({ failure_code: "EXPORT_FAILED", locked_at: null, locked_by: null, status: "failed" })
      .where("user_id", "=", input.userId)
      .where("status", "in", ["queued", "running"])
      .execute();
    const completed = await transaction
      .selectFrom("privacy_export_artifact as artifact")
      .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
      .select(["artifact.id", "artifact.format", "artifact.object_key", "artifact.job_id"])
      .where("job.user_id", "=", input.userId)
      .orderBy("artifact.id")
      .execute();
    const staged = await transaction
      .selectFrom("privacy_export_upload_artifact as artifact")
      .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
      .select(["artifact.id", "artifact.format", "artifact.object_key", "artifact.job_id"])
      .where("job.user_id", "=", input.userId)
      .where("artifact.status", "=", "cancelled")
      .orderBy("artifact.id")
      .execute();
    return [
      ...completed.map((row) => ({
        artifactId: row.id,
        exportJobId: row.job_id,
        format: row.format === "csv_zip" ? ("csv" as const) : ("json" as const),
        objectKey: row.object_key,
        source: "completed" as const,
      })),
      ...staged.map((row) => ({
        artifactId: row.id,
        exportJobId: row.job_id,
        format: row.format === "csv_zip" ? ("csv" as const) : ("json" as const),
        objectKey: row.object_key,
        source: "staged" as const,
      })),
    ].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  });
}

export async function completePrivacyExportArtifactDeletion(
  database: Kysely<Database>,
  input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly deletedAt: string;
    readonly deletionEvidenceDigest: string;
  },
): Promise<void> {
  requireDigest(input.deletionEvidenceDigest, "deletionEvidenceDigest");
  const deletedAt = canonicalInstant(input.deletedAt);
  await database.transaction().execute(async (transaction) => {
    const artifact = await transaction
      .selectFrom("privacy_export_artifact_deletion as deletion")
      .innerJoin("privacy_export_artifact as artifact", "artifact.id", "deletion.artifact_id")
      .select(["artifact.id", "artifact.job_id", "artifact.format"])
      .where("deletion.artifact_id", "=", input.artifactId)
      .where("deletion.status", "=", "running")
      .where("deletion.locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate("deletion")
      .forUpdate("artifact")
      .executeTakeFirst();
    if (!artifact) throw new RetentionNotFoundError();
    await transaction
      .insertInto("privacy_export_artifact_tombstone")
      .values({
        artifact_id: artifact.id,
        deleted_at: deletedAt,
        deletion_evidence_digest: input.deletionEvidenceDigest,
        format: artifact.format,
        job_id: artifact.job_id,
      })
      .execute();
    await sql`select set_config('nutrition_tracker.privacy_export_cleanup','on',true)`.execute(
      transaction,
    );
    const result = await transaction
      .deleteFrom("privacy_export_artifact")
      .where("id", "=", artifact.id)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n) throw new RetentionNotFoundError();
  });
}

export async function failPrivacyExportArtifactDeletion(
  database: Kysely<Database>,
  input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: string;
  },
): Promise<RetentionRetryDisposition> {
  const retryAt = canonicalInstant(input.retryAt);
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_artifact_deletion")
      .select(["artifact_id", "attempt_count"])
      .where("artifact_id", "=", input.artifactId)
      .where("status", "=", "running")
      .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    const disposition = retentionRetryDisposition(row.attempt_count);
    if (disposition.deadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: new Date(),
        recoveryKind: "artifact_deletion",
        targetId: row.artifact_id,
      });
    await transaction
      .updateTable("privacy_export_artifact_deletion")
      .set({
        available_at: retryAt,
        dead_lettered_at: disposition.deadLettered ? new Date() : null,
        last_error_code: boundedText(input.errorCode, 100, "errorCode"),
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("artifact_id", "=", row.artifact_id)
      .execute();
    return disposition;
  });
}

export async function requeueDeadLetteredPrivacyExportArtifactDeletion(
  database: Kysely<Database>,
  input: RequeueDeadLetteredRetentionCleanupInput,
): Promise<RetentionRecoveryRecord> {
  requireDigest(input.approvalDigest, "approvalDigest");
  const requeuedAt = canonicalInstant(input.requeuedAt);
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("privacy_export_artifact_deletion")
      .select("artifact_id")
      .where("artifact_id", "=", input.artifactId)
      .where("status", "=", "failed")
      .where("attempt_count", "=", 20)
      .where("dead_lettered_at", "is not", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    await insertRetentionJobRecoveryAudit(transaction, {
      approvalDigest: input.approvalDigest,
      recoveryKind: "artifact_deletion",
      requeuedAt,
      targetId: row.artifact_id,
    });
    await transaction
      .updateTable("privacy_export_artifact_deletion")
      .set({
        attempt_count: 0,
        available_at: requeuedAt,
        dead_lettered_at: null,
        last_error_code: null,
        locked_at: null,
        locked_by: null,
        status: "queued",
      })
      .where("artifact_id", "=", row.artifact_id)
      .execute();
    return { recoveryKind: "artifact_deletion", requeuedAt, targetId: row.artifact_id };
  });
}

/** Renews a worker-owned 15-minute claim while bounded DB/object work is still progressing. */
export async function renewRetentionWorkLease(
  database: Kysely<Database>,
  input: RenewRetentionWorkLeaseInput,
): Promise<void> {
  const renewedAt = canonicalInstant(input.renewedAt);
  const workerId = boundedText(input.workerId, 200, "workerId");
  let changed = 0n;
  switch (input.kind) {
    case "privacy_export":
      changed = (
        await database
          .updateTable("privacy_export_job")
          .set({ locked_at: renewedAt })
          .where("id", "=", input.targetId)
          .where("status", "=", "running")
          .where("locked_by", "=", workerId)
          .executeTakeFirst()
      ).numUpdatedRows;
      break;
    case "account_erasure":
      changed = (
        await database
          .updateTable("account_erasure_job")
          .set({ locked_at: renewedAt })
          .where("id", "=", input.targetId)
          .where("status", "=", "running")
          .where("locked_by", "=", workerId)
          .executeTakeFirst()
      ).numUpdatedRows;
      break;
    case "artifact_deletion":
      changed = (
        await database
          .updateTable("privacy_export_artifact_deletion")
          .set({ locked_at: renewedAt })
          .where("artifact_id", "=", input.targetId)
          .where("status", "=", "running")
          .where("locked_by", "=", workerId)
          .executeTakeFirst()
      ).numUpdatedRows;
      break;
    case "staged_artifact_deletion":
      changed = (
        await database
          .updateTable("privacy_export_upload_artifact")
          .set({ locked_at: renewedAt })
          .where("id", "=", input.targetId)
          .where("status", "=", "cancelled")
          .where("locked_by", "=", workerId)
          .executeTakeFirst()
      ).numUpdatedRows;
      break;
  }
  if (changed !== 1n) throw new RetentionNotFoundError();
}

/** Durable payload-free alert stream for failures that terminalize either in fail() or claim(). */
export async function claimRetentionDeadLetterEvents(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly now: string; readonly limit?: number },
): Promise<readonly RetentionDeadLetterRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  const workerId = boundedText(input.workerId, 200, "workerId");
  return database.transaction().execute(async (transaction) => {
    const rows = await transaction
      .selectFrom("retention_dead_letter_event")
      .selectAll()
      .where((builder) =>
        builder.or([
          builder("status", "=", "pending"),
          builder.and([
            builder("status", "=", "processing"),
            builder("locked_at", "<=", staleBefore),
          ]),
        ]),
      )
      .orderBy("occurred_at")
      .orderBy("id")
      .forUpdate()
      .skipLocked()
      .limit(boundedLimit(input.limit, 100))
      .execute();
    const result: RetentionDeadLetterRecord[] = [];
    for (const row of rows) {
      await transaction
        .updateTable("retention_dead_letter_event")
        .set({ locked_at: now, locked_by: workerId, status: "processing" })
        .where("id", "=", row.id)
        .execute();
      result.push({
        attemptCount: 20,
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        recoveryKind: row.recovery_kind,
        targetId: row.target_id,
      });
    }
    return result;
  });
}

export async function acknowledgeRetentionDeadLetterEvent(
  database: Kysely<Database>,
  input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly acknowledgedAt: string;
  },
): Promise<void> {
  const row = await database
    .updateTable("retention_dead_letter_event")
    .set({
      acknowledged_at: canonicalInstant(input.acknowledgedAt),
      locked_at: null,
      locked_by: null,
      status: "completed",
    })
    .where("id", "=", input.eventId)
    .where("status", "=", "processing")
    .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
    .executeTakeFirst();
  if (row.numUpdatedRows !== 1n) throw new RetentionNotFoundError();
}

export async function requestAccountErasure(
  database: Kysely<Database>,
  input: RequestAccountErasureInput,
): Promise<AccountErasureMutationResult> {
  validateOperation(input);
  requireDigest(input.sessionTokenHash, "sessionTokenHash");
  requireDigest(input.proofTokenHash, "proofTokenHash");
  requireDigest(input.statusCapabilityHash, "statusCapabilityHash");
  const requestedAt = input.requestedAt
    ? canonicalInstant(input.requestedAt)
    : new Date().toISOString();
  const executeAfter = input.executeAfter ? canonicalInstant(input.executeAfter) : requestedAt;
  const statusCapabilityExpiresAt = canonicalInstant(input.statusCapabilityExpiresAt);
  if (executeAfter < requestedAt || statusCapabilityExpiresAt <= requestedAt)
    throw new RetentionValidationError("Erasure lifecycle timestamps are invalid");
  const restoreLocator = boundedText(input.restoreLocator, 500, "restoreLocator");
  return database.transaction().execute(async (transaction) => {
    await lockAllUserWriters(transaction, input.userId);
    const existing = await transaction
      .selectFrom("account_erasure_job")
      .selectAll()
      .where("user_id", "=", input.userId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        existing.client_operation_id !== input.clientOperationId ||
        existing.recovery_session_token_hash !== input.sessionTokenHash ||
        existing.status_capability_hash !== input.statusCapabilityHash ||
        existing.restore_locator !== restoreLocator ||
        existing.status === "completed" ||
        new Date(requestedAt) >= existing.execute_after
      )
        throw new RetentionIdempotencyConflictError();
      return { job: mapErasureJob(existing), replayed: true };
    }
    await requireActiveProfile(transaction, input.userId, true);
    await consumeReauthenticationProofInTransaction(
      transaction,
      {
        clientOperationId: input.clientOperationId,
        purpose: "account_erasure",
        sessionTokenHash: input.sessionTokenHash,
        tokenHash: input.proofTokenHash,
        userId: input.userId,
      },
      requestedAt,
    );
    const row = await transaction
      .insertInto("account_erasure_job")
      .values({
        client_operation_id: input.clientOperationId,
        execute_after: executeAfter,
        recovery_session_token_hash: input.sessionTokenHash,
        request_digest: input.requestDigest,
        requested_at: requestedAt,
        restore_locator: restoreLocator,
        status_capability_expires_at: statusCapabilityExpiresAt,
        status_capability_hash: input.statusCapabilityHash,
        user_id: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("app_user")
      .set({ deletion_requested_at: requestedAt, status: "pending_deletion" })
      .where("id", "=", input.userId)
      .execute();
    await transaction
      .updateTable("user_session")
      .set({ revoked_at: requestedAt })
      .where("user_id", "=", input.userId)
      .where("revoked_at", "is", null)
      .execute();
    await transaction
      .updateTable("reauthentication_proof")
      .set({ revoked_at: requestedAt })
      .where("user_id", "=", input.userId)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();
    await transaction
      .updateTable("device_registration")
      .set({ revoked_at: requestedAt })
      .where("user_id", "=", input.userId)
      .where("revoked_at", "is", null)
      .execute();
    await transaction
      .updateTable("security_challenge")
      .set({ revoked_at: requestedAt })
      .where("user_id", "=", input.userId)
      .where("consumed_at", "is", null)
      .execute();
    await transaction
      .updateTable("reminder_delivery_outbox")
      .set({ status: "cancelled" })
      .where("user_id", "=", input.userId)
      .where("status", "in", ["pending", "processing"])
      .execute();
    return { job: mapErasureJob(row), replayed: false };
  });
}
export async function getAccountErasureByCapability(
  database: Kysely<Database>,
  input: {
    readonly jobId: string;
    readonly statusCapabilityHash: string;
    readonly now: string;
  },
): Promise<AccountErasureJobRecord> {
  requireDigest(input.statusCapabilityHash, "statusCapabilityHash");
  const now = canonicalInstant(input.now);
  const row = await database
    .selectFrom("account_erasure_job")
    .selectAll()
    .where("id", "=", input.jobId)
    .where("status_capability_hash", "=", input.statusCapabilityHash)
    .where("status_capability_expires_at", ">", new Date(now))
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return mapErasureJob(row);
}
export async function getAccountErasureJob(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly jobId: string },
): Promise<AccountErasureJobRecord> {
  const row = await database
    .selectFrom("account_erasure_job as job")
    .innerJoin("app_user as account", "account.id", "job.user_id")
    .selectAll("job")
    .where("job.id", "=", input.jobId)
    .where("job.user_id", "=", input.userId)
    .where("account.status", "in", ["active", "pending_deletion"])
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return mapErasureJob(row);
}
export async function claimAccountErasureJobs(
  database: Kysely<Database>,
  input: { readonly workerId: string; readonly limit?: number; readonly now: string },
): Promise<readonly AccountErasureClaimRecord[]> {
  const now = canonicalInstant(input.now);
  const staleBefore = new Date(new Date(now).getTime() - 15 * 60_000);
  return database.transaction().execute(async (transaction) => {
    const newlyDeadLettered = await transaction
      .updateTable("account_erasure_job")
      .set({
        dead_lettered_at: now,
        last_error_code: "ERASURE_FAILED",
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("status", "!=", "completed")
      .where("attempt_count", ">=", 20)
      .where("dead_lettered_at", "is", null)
      .where((builder) =>
        builder.or([
          builder.and([
            builder("status", "in", ["queued", "failed"]),
            builder("locked_at", "is", null),
          ]),
          builder.and([builder("status", "=", "running"), builder("locked_at", "<=", staleBefore)]),
        ]),
      )
      .returning("id")
      .execute();
    for (const row of newlyDeadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: now,
        recoveryKind: "account_erasure",
        targetId: row.id,
      });
    const rows = await transaction
      .selectFrom("account_erasure_job")
      .selectAll()
      .where("execute_after", "<=", new Date(now))
      .where("user_id", "is not", null)
      .where("attempt_count", "<", 20)
      .where("dead_lettered_at", "is", null)
      .where(
        sql<boolean>`((status in ('queued','failed') and available_at <= ${new Date(now)}) or
          (status = 'running' and locked_at <= ${staleBefore}))`,
      )
      .orderBy("requested_at")
      .forUpdate()
      .skipLocked()
      .limit(boundedLimit(input.limit, 20))
      .execute();
    const claimed: AccountErasureClaimRecord[] = [];
    for (const row of rows) {
      const updated = await transaction
        .updateTable("account_erasure_job")
        .set({
          attempt_count: sql`attempt_count + 1`,
          last_error_code: null,
          locked_at: now,
          locked_by: boundedText(input.workerId, 200, "workerId"),
          started_at: row.started_at ?? now,
          status: "running",
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const mapped = mapErasureJob(updated);
      if (!updated.user_id || !updated.restore_locator) throw new RetentionExportNotReadyError();
      claimed.push({
        ...mapped,
        restoreLocator: updated.restore_locator,
        userId: updated.user_id,
      });
    }
    return claimed;
  });
}
export async function failAccountErasureJob(
  database: Kysely<Database>,
  input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: string;
  },
): Promise<RetentionRetryDisposition> {
  const retryAt = canonicalInstant(input.retryAt);
  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom("account_erasure_job")
      .select(["attempt_count", "id"])
      .where("id", "=", input.jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", boundedText(input.workerId, 200, "workerId"))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new RetentionNotFoundError();
    const disposition = retentionRetryDisposition(row.attempt_count);
    if (disposition.deadLettered)
      await recordRetentionDeadLetter(transaction, {
        occurredAt: new Date(),
        recoveryKind: "account_erasure",
        targetId: row.id,
      });
    await transaction
      .updateTable("account_erasure_job")
      .set({
        available_at: retryAt,
        dead_lettered_at: disposition.deadLettered ? new Date() : null,
        last_error_code: boundedText(input.errorCode, 100, "errorCode"),
        locked_at: null,
        locked_by: null,
        status: "failed",
      })
      .where("id", "=", row.id)
      .execute();
    return disposition;
  });
}

/** Offline/operator-only recovery; the pending-deletion subject and original request stay pinned. */
export async function requeueDeadLetteredAccountErasureJob(
  database: Kysely<Database>,
  input: RequeueDeadLetteredRetentionJobInput,
): Promise<AccountErasureJobRecord> {
  requireDigest(input.approvalDigest, "approvalDigest");
  const requeuedAt = canonicalInstant(input.requeuedAt);
  return database.transaction().execute(async (transaction) => {
    const job = await transaction
      .selectFrom("account_erasure_job")
      .selectAll()
      .where("id", "=", input.jobId)
      .where("status", "=", "failed")
      .where("dead_lettered_at", "is not", null)
      .where("attempt_count", "=", 20)
      .where("user_id", "is not", null)
      .forUpdate()
      .executeTakeFirst();
    if (!job) throw new RetentionNotFoundError();
    await insertRetentionJobRecoveryAudit(transaction, {
      approvalDigest: input.approvalDigest,
      recoveryKind: "account_erasure",
      requeuedAt,
      targetId: job.id,
    });
    const updated = await transaction
      .updateTable("account_erasure_job")
      .set({
        attempt_count: 0,
        available_at: requeuedAt,
        dead_lettered_at: null,
        last_error_code: null,
        locked_at: null,
        locked_by: null,
        status: "queued",
      })
      .where("id", "=", job.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapErasureJob(updated);
  });
}
export async function executeAccountErasureJob(
  database: Kysely<Database>,
  input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly completedAt: string;
    readonly evidence: AccountErasureExecutionEvidence;
  },
): Promise<AccountErasureReceiptRecord> {
  return executeErasure(database, input);
}

export async function reconcileErasedAccountRows(
  database: Kysely<Database>,
  input: { readonly userId: string },
): Promise<AccountErasureReconciliationRecord> {
  return reconcileErasedRows(database, input.userId);
}

export async function replayExternalErasureLedgerEntry(
  database: Kysely<Database>,
  input: ExternalErasureLedgerEntry,
): Promise<AccountErasureReconciliationRecord> {
  requireDigest(input.ackDigest, "ackDigest");
  boundedText(input.ledgerEntryId, 500, "ledgerEntryId");
  canonicalInstant(input.recordedAt);
  return database.transaction().execute(async (transaction) => {
    await lockAllUserWriters(transaction, input.subjectUserId);
    await sql`select set_config('nutrition_tracker.account_erasure','on',true)`.execute(
      transaction,
    );
    await assertErasureSchemaClassified(transaction);
    const subjectJobs = await transaction
      .selectFrom("account_erasure_job")
      .select("id")
      .where("user_id", "=", input.subjectUserId)
      .forUpdate()
      .execute();
    await eraseOwnedRows(transaction, input.subjectUserId);
    if (subjectJobs.length)
      await transaction
        .deleteFrom("account_erasure_job")
        .where(
          "id",
          "in",
          subjectJobs.map((job) => job.id),
        )
        .execute();
    await transaction.deleteFrom("app_user").where("id", "=", input.subjectUserId).execute();
    return reconcileErasedRows(
      transaction,
      input.subjectUserId,
      subjectJobs.map((job) => job.id),
      true,
    );
  });
}

// ---- internal implementation ----

type DbExecutor = Kysely<Database> | Transaction<Database>;

async function requireActiveProfile(
  database: DbExecutor,
  userId: string,
  forUpdate: boolean,
): Promise<{ timeZone: string; watermarkRevision: string }> {
  let query = database
    .selectFrom("app_user as user")
    .innerJoin("user_profile as profile", "profile.user_id", "user.id")
    .innerJoin("user_data_watermark as watermark", "watermark.user_id", "user.id")
    .select(["profile.time_zone", "watermark.revision"])
    .where("user.id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null);
  if (forUpdate) query = query.forUpdate("user");
  const row = await query.executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return { timeZone: row.time_zone, watermarkRevision: row.revision };
}
async function lockRetentionUser(
  transaction: Transaction<Database>,
  userId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:retention:${userId}`},0))`.execute(
    transaction,
  );
}
async function lockAllUserWriters(
  transaction: Transaction<Database>,
  userId: string,
): Promise<void> {
  for (const scope of ["diary", "goal", "recipe", "retention"]) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:${scope}:${userId}`},0))`.execute(
      transaction,
    );
  }
}
async function insertRetentionJobRecoveryAudit(
  transaction: Transaction<Database>,
  input: {
    readonly approvalDigest: string;
    readonly recoveryKind:
      | "account_erasure"
      | "artifact_deletion"
      | "privacy_export"
      | "staged_artifact_deletion";
    readonly requeuedAt: string;
    readonly targetId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("retention_job_recovery_audit")
    .values({
      approval_digest: input.approvalDigest,
      attempt_count_before: 20,
      recovery_kind: input.recoveryKind,
      reason_code: "operator_requeue",
      requeued_at: input.requeuedAt,
      target_id: input.targetId,
    })
    .execute();
}
async function recordRetentionDeadLetter(
  transaction: Transaction<Database>,
  input: {
    readonly occurredAt: string | Date;
    readonly recoveryKind: RetentionRecoveryRecord["recoveryKind"];
    readonly targetId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("retention_dead_letter_event")
    .values({
      attempt_count: 20,
      occurred_at: input.occurredAt,
      recovery_kind: input.recoveryKind,
      target_id: input.targetId,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}
function validateOperation(input: RetentionOperationInput): void {
  if (
    !/^[0-9a-f-]{36}$/iu.test(input.clientOperationId) ||
    !/^[0-9a-f]{64}$/u.test(input.requestDigest)
  )
    throw new RetentionValidationError("Invalid operation identity");
}
function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) throw new RetentionValidationError("Revision must be positive");
  return text;
}
function canonicalCursorEpoch(value: bigint | number | string): string {
  const canonical = canonicalRevision(value);
  if (BigInt(canonical) > 9_223_372_036_854_775_807n)
    throw new RetentionValidationError("Cursor epoch exceeds the supported range");
  return canonical;
}
function canonicalPositiveId(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value))
    throw new RetentionValidationError("Identifier must be positive");
  return value;
}
function canonicalNonNegative(value: string, field: string): string {
  try {
    return canonicalRetentionDecimal(value, field, { allowZero: true, maxLength: 160 });
  } catch {
    throw new RetentionValidationError(`${field} is invalid`);
  }
}
function canonicalPositive(value: string, field: string): string {
  try {
    return canonicalRetentionDecimal(value, field, { maxLength: 160 });
  } catch {
    throw new RetentionValidationError(`${field} is invalid`);
  }
}
function canonicalInstant(value: string): string {
  try {
    return deriveDiaryLocalCoordinates(value, "UTC").occurredAt;
  } catch {
    throw new RetentionValidationError("Instant must be RFC3339");
  }
}
function assertTrendRangeSafe(from: string, to: string): void {
  try {
    assertTrendRange(from, to);
  } catch {
    throw new RetentionValidationError("Trend date range is invalid");
  }
}
function boundedText(value: string, max: number, field: string): string {
  const text = value.normalize("NFKC").trim();
  if (!text || [...text].length > max) throw new RetentionValidationError(`${field} is invalid`);
  return text;
}
function boundedLimit(value: number | undefined, max: number): number {
  const result = value ?? max;
  if (!Number.isSafeInteger(result) || result < 1 || result > max)
    throw new RetentionValidationError(`limit must be 1 to ${max}`);
  return result;
}

function retentionRetryDisposition(attemptCount: number): RetentionRetryDisposition {
  const deadLettered = attemptCount >= 20;
  return { attemptCount, deadLettered, retryScheduled: !deadLettered };
}
function requireDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new RetentionValidationError(`${field} must be SHA-256 hex`);
}
function safeCount(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new RetentionValidationError("Persisted coverage count is invalid");
  return result;
}
function cleanUnknownReasons(
  value: JsonObject,
): Readonly<Partial<Record<UnknownNutrientReason, number>>> {
  const output: Partial<Record<UnknownNutrientReason, number>> = {};
  for (const reason of ["not_reported", "not_analyzed", "not_applicable", "withheld"] as const) {
    const count = value[reason];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0)
      output[reason] = count;
  }
  return output;
}

function validateCustomFoodDraft(draft: CustomFoodDraft): CustomFoodDraft {
  const name = boundedText(draft.name, 200, "name");
  const brandName = draft.brandName == null ? null : boundedText(draft.brandName, 100, "brandName");
  const notes = draft.notes == null ? null : boundedText(draft.notes, 2000, "notes");
  if (draft.nutrients.length < 1 || draft.nutrients.length > MAX_NUTRIENTS)
    throw new RetentionValidationError("Custom food nutrient count is invalid");
  const nutrientIds = new Set<string>();
  const nutrients = draft.nutrients.map((row) => {
    const nutrientId = canonicalPositiveId(row.nutrientId);
    if (nutrientIds.has(nutrientId)) throw new RetentionValidationError("Duplicate nutrient");
    nutrientIds.add(nutrientId);
    return row.state === "quantified"
      ? {
          amountPer100Grams: canonicalNonNegative(row.amountPer100Grams, "amountPer100Grams"),
          nutrientId,
          state: "quantified" as const,
        }
      : { ...row, nutrientId };
  });
  const serving = draft.serving
    ? {
        grams: canonicalPositive(draft.serving.grams, "serving grams"),
        label: boundedText(draft.serving.label, 200, "serving label"),
      }
    : null;
  return { name, brandName, notes, nutrients, serving };
}
async function loadCustomFoodNutrients(transaction: Transaction<Database>, draft: CustomFoodDraft) {
  const rows = await transaction
    .selectFrom("nutrient")
    .select(["id", "code", "name", "canonical_unit"])
    .where("active", "=", true)
    .orderBy("id")
    .execute();
  if (rows.length < 1 || rows.length > MAX_NUTRIENTS)
    throw new RetentionValidationError("Active nutrient registry is unavailable");
  const activeIds = new Set(rows.map((row) => row.id));
  if (draft.nutrients.some((row) => !activeIds.has(row.nutrientId)))
    throw new RetentionValidationError("Custom food references an unavailable nutrient");
  return new Map(rows.map((row) => [row.id, row]));
}
async function insertCustomFoodVersion(
  transaction: Transaction<Database>,
  input: {
    customFoodId: string;
    draft: CustomFoodDraft;
    foodId: string;
    nutrientDefinitions: Map<
      string,
      { id: string; code: string; name: string; canonical_unit: string }
    >;
    userId: string;
    versionNumber: number;
  },
) {
  const version = await transaction
    .insertInto("food_version")
    .values({
      attributes: { customFoodId: input.customFoodId },
      basis_quantity: "100",
      basis_unit: "g",
      brand_name: input.draft.brandName ?? null,
      created_by_user_id: input.userId,
      data_quality: "provisional",
      description: input.draft.notes,
      food_id: input.foodId,
      ingredients_text: null,
      language_tag: "und",
      market_code: "001",
      name: input.draft.name,
      normalized_name: input.draft.name.normalize("NFKC").toLocaleLowerCase("en-US"),
      source_modified_at: null,
      source_release_id: null,
      version_number: input.versionNumber,
    })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();
  const enteredById = new Map(input.draft.nutrients.map((row) => [row.nutrientId, row]));
  const quantified = [...input.nutrientDefinitions.values()].flatMap((definition) => {
    const row = enteredById.get(definition.id);
    return row?.state === "quantified" || row?.state === "trace"
      ? [
          {
            amount: row.state === "trace" ? "0" : row.amountPer100Grams,
            basis_quantity: "100",
            basis_unit: "g" as const,
            derivation_code: "user-custom-food",
            food_version_id: version.id,
            metadata: { customFoodId: input.customFoodId },
            nutrient_id: definition.id,
            source_amount: null,
            source_basis_quantity: null,
            source_basis_unit: null,
            source_unit: null,
            unit: definition.canonical_unit,
            value_status: row.state === "trace" ? ("trace" as const) : ("estimated" as const),
          },
        ]
      : [];
  });
  if (quantified.length)
    await transaction.insertInto("food_nutrient_value").values(quantified).execute();
  let servingId: string | null = null;
  if (input.draft.serving) {
    const serving = await transaction
      .insertInto("food_serving")
      .values({
        display_order: 0,
        food_version_id: version.id,
        gram_weight: input.draft.serving.grams,
        is_default: true,
        label: input.draft.serving.label,
        metadata: { customFoodId: input.customFoodId },
        milliliter_volume: null,
        quantity: "1",
        source_serving_key: null,
        unit: "serving",
        unit_kind: "count",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    servingId = serving.id;
  }
  const snapshots = [...input.nutrientDefinitions.values()].map((definition) => {
    const entered = enteredById.get(definition.id);
    return {
      amountPer100Grams: entered?.state === "quantified" ? entered.amountPer100Grams : null,
      code: definition.code,
      name: definition.name,
      nutrientId: definition.id,
      reason:
        entered?.state === "unknown" ? entered.reason : entered ? null : ("not_reported" as const),
      state: entered?.state ?? ("unknown" as const),
      unit: definition.canonical_unit,
    };
  });
  return { ...version, servingId, snapshots };
}

async function publishCustomVersionEvidence(
  transaction: Transaction<Database>,
  customFoodId: string,
  version: Awaited<ReturnType<typeof insertCustomFoodVersion>>,
  versionNumber: number,
): Promise<void> {
  await transaction
    .insertInto("custom_food_version")
    .values({
      custom_food_id: customFoodId,
      food_version_id: version.id,
      version_number: String(versionNumber),
    })
    .execute();
  await transaction
    .insertInto("custom_food_version_nutrient")
    .values(
      version.snapshots.map((snapshot) => ({
        amount_per_100_grams: snapshot.amountPer100Grams,
        custom_food_id: customFoodId,
        food_version_id: version.id,
        nutrient_code: snapshot.code,
        nutrient_id: snapshot.nutrientId,
        nutrient_name: snapshot.name,
        provenance_statement: "Entered by the owner; not independently verified.",
        unit: snapshot.unit,
        unknown_reason: snapshot.reason,
        value_state: snapshot.state,
      })),
    )
    .execute();
}
async function loadCustomFood(
  database: DbExecutor,
  userId: string,
  id: string,
): Promise<CustomFoodRecord> {
  const row = await database
    .selectFrom("custom_food as custom")
    .innerJoin("food_version as version", "version.id", "custom.current_food_version_id")
    .select([
      "custom.id",
      "custom.food_id",
      "custom.current_revision",
      "custom.status",
      "custom.created_at",
      "custom.updated_at",
      "version.id as version_id",
      "version.version_number",
      "version.name",
      "version.brand_name",
      "version.description",
      "version.created_at as version_created_at",
    ])
    .where("custom.id", "=", id)
    .where("custom.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  const [servings, nutrients] = await Promise.all([
    database
      .selectFrom("food_serving")
      .selectAll()
      .where("food_version_id", "=", row.version_id)
      .orderBy("display_order")
      .orderBy("id")
      .execute(),
    database
      .selectFrom("custom_food_version_nutrient")
      .select([
        "nutrient_id",
        "nutrient_code",
        "nutrient_name",
        "unit",
        "value_state",
        "amount_per_100_grams",
        "unknown_reason",
        "provenance_statement",
      ])
      .where("food_version_id", "=", row.version_id)
      .orderBy("nutrient_id")
      .execute(),
  ]);
  return {
    createdAt: row.created_at.toISOString(),
    currentRevision: row.current_revision,
    currentVersion: {
      brandName: row.brand_name,
      createdAt: row.version_created_at.toISOString(),
      id: row.version_id,
      name: row.name,
      notes: row.description,
      nutrients: nutrients.map((value) => ({
        amountPer100Grams:
          value.amount_per_100_grams === null
            ? null
            : canonicalNonNegative(value.amount_per_100_grams, "amountPer100Grams"),
        nutrient: {
          code: value.nutrient_code,
          id: value.nutrient_id,
          name: value.nutrient_name,
          unit: value.unit,
        },
        provenance: value.provenance_statement,
        reason: value.unknown_reason,
        state: value.value_state,
      })),
      serving: servings[0]
        ? {
            grams: canonicalPositive(servings[0].gram_weight ?? "", "serving grams"),
            id: servings[0].id,
            label: servings[0].label,
          }
        : null,
      versionNumber: String(row.version_number),
    },
    foodId: row.food_id,
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function writeBiometricDefinition(
  database: Kysely<Database>,
  input: CreateBiometricDefinitionInput | ReviseBiometricDefinitionInput,
  definitionId: string | null,
): Promise<BiometricDefinitionMutationResult> {
  validateOperation(input);
  const createDraft = definitionId
    ? null
    : validateDefinition(input.definition as BiometricDefinitionDraft);
  const revisionDraft = definitionId
    ? validateDefinitionRevision(input.definition as BiometricDefinitionRevisionDraft)
    : null;
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const operation = definitionId ? "revise" : "create";
    const replay = await readFeatureReplay<BiometricDefinitionMutationResult>(
      transaction,
      input,
      "biometric",
      operation,
    );
    if (replay) return replay;
    const rootId = definitionId ?? randomUUID();
    let versionNumber = "1";
    const versionId = randomUUID();
    let identity:
      | {
          canonicalUnit: string;
          code: string;
          dimension: BiometricDimension;
          maximumValue: string | null;
          minimumValue: string | null;
        }
      | undefined;
    if (definitionId) {
      const root = await transaction
        .selectFrom("biometric_definition")
        .selectAll()
        .where("id", "=", definitionId)
        .where("user_id", "=", input.userId)
        .where("status", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (!root) throw new RetentionNotFoundError();
      if (
        root.current_revision !==
        canonicalRevision((input as ReviseBiometricDefinitionInput).expectedRevision)
      )
        throw new RetentionRevisionConflictError();
      const current = await transaction
        .selectFrom("biometric_definition_version")
        .select(["code", "canonical_unit", "dimension", "minimum_value", "maximum_value"])
        .where("id", "=", root.current_version_id)
        .executeTakeFirstOrThrow();
      identity = {
        canonicalUnit: current.canonical_unit,
        code: current.code,
        dimension: current.dimension,
        maximumValue: current.maximum_value,
        minimumValue: current.minimum_value,
      };
      versionNumber = (BigInt(root.current_revision) + 1n).toString();
    } else {
      const count = await transaction
        .selectFrom("biometric_definition")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      if (BigInt(count.count) >= 100n)
        throw new RetentionValidationError("Biometric definition limit reached");
      await transaction
        .insertInto("biometric_definition")
        .values({
          current_revision: "1",
          current_version_id: versionId,
          id: rootId,
          user_id: input.userId,
        })
        .execute();
    }
    await transaction
      .insertInto("biometric_definition_version")
      .values({
        canonical_unit: identity?.canonicalUnit ?? createDraft?.canonicalUnit ?? "",
        code: identity?.code ?? `custom_${rootId.replaceAll("-", "")}`,
        definition_id: rootId,
        dimension: identity?.dimension ?? createDraft?.dimension ?? "other",
        id: versionId,
        maximum_value: identity?.maximumValue ?? null,
        metadata: { notes: revisionDraft?.notes ?? createDraft?.notes ?? null },
        minimum_value: identity?.minimumValue ?? null,
        name: revisionDraft?.name ?? createDraft?.name ?? "",
        user_id: input.userId,
        version_number: versionNumber,
      })
      .execute();
    if (definitionId)
      await transaction
        .updateTable("biometric_definition")
        .set({ current_revision: versionNumber, current_version_id: versionId })
        .where("id", "=", rootId)
        .execute();
    const result = {
      definition: await loadBiometricDefinition(transaction, input.userId, rootId),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "biometric", operation, rootId, result);
    return result;
  });
}
function validateDefinition(draft: BiometricDefinitionDraft): BiometricDefinitionDraft {
  return {
    canonicalUnit: boundedText(draft.canonicalUnit, 32, "canonicalUnit"),
    dimension: draft.dimension,
    name: boundedText(draft.name, 120, "name"),
    notes: draft.notes === null ? null : boundedText(draft.notes, 1_000, "notes"),
  };
}
function validateDefinitionRevision(
  draft: BiometricDefinitionRevisionDraft,
): BiometricDefinitionRevisionDraft {
  return {
    name: boundedText(draft.name, 120, "name"),
    notes: draft.notes === null ? null : boundedText(draft.notes, 1_000, "notes"),
  };
}
function canonicalSigned(value: string, field: string): string {
  try {
    return canonicalRetentionDecimal(value, field, { allowZero: true, maxLength: 160 });
  } catch {
    if (/^-[0-9]+(?:\.[0-9]+)?$/u.test(value) && value.length <= 160)
      return value.replace(/^-0(?:\.0+)?$/u, "0");
    throw new RetentionValidationError(`${field} is invalid`);
  }
}
async function loadBiometricDefinition(
  database: DbExecutor,
  userId: string,
  id: string,
): Promise<BiometricDefinitionRecord> {
  const row = await database
    .selectFrom("biometric_definition as root")
    .innerJoin("biometric_definition_version as version", "version.id", "root.current_version_id")
    .select([
      "root.id",
      "root.current_revision",
      "root.status",
      "root.created_at",
      "root.updated_at",
      "version.id as version_id",
      "version.version_number",
      "version.code",
      "version.name",
      "version.canonical_unit",
      "version.dimension",
      "version.minimum_value",
      "version.maximum_value",
      "version.metadata",
      "version.created_at as version_created_at",
    ])
    .where("root.id", "=", id)
    .where("root.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return {
    createdAt: row.created_at.toISOString(),
    currentRevision: row.current_revision,
    currentVersion: {
      canonicalUnit: row.canonical_unit,
      code: row.code,
      createdAt: row.version_created_at.toISOString(),
      dimension: row.dimension,
      id: row.version_id,
      maximumValue: row.maximum_value,
      metadata: row.metadata,
      minimumValue: row.minimum_value,
      name: row.name,
      notes: typeof row.metadata.notes === "string" ? row.metadata.notes : null,
      versionNumber: row.version_number,
    },
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function createManualBiometricEvent(
  database: Kysely<Database>,
  input: RecordBiometricEventInput,
): Promise<BiometricEventMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    const profile = await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<BiometricEventMutationResult>(
      transaction,
      input,
      "biometric",
      "event_create",
    );
    if (replay) return replay;
    const definition = await transaction
      .selectFrom("biometric_definition_version as version")
      .innerJoin("biometric_definition as root", "root.id", "version.definition_id")
      .select([
        "version.id",
        "version.canonical_unit",
        "version.minimum_value",
        "version.maximum_value",
      ])
      .where("root.id", "=", input.definitionId)
      .whereRef("version.id", "=", "root.current_version_id")
      .where("root.user_id", "=", input.userId)
      .where("root.status", "=", "active")
      .executeTakeFirst();
    if (!definition) throw new RetentionNotFoundError();
    const value = validateBiometricValue(
      input.value,
      definition.minimum_value,
      definition.maximum_value,
    );
    const coordinates = deriveCoordinates(input.measuredAt, profile.timeZone);
    const eventId = randomUUID(),
      revisionId = randomUUID();
    await transaction
      .insertInto("biometric_event")
      .values({
        current_revision: "1",
        current_revision_id: revisionId,
        id: eventId,
        user_id: input.userId,
      })
      .execute();
    await insertBiometricRevision(transaction, {
      coordinates,
      definitionVersionId: definition.id,
      eventId,
      note: input.note ?? null,
      operation: "create",
      provenance: input.provenance ?? {},
      revisionId,
      revisionNumber: "1",
      sourceKind: "manual",
      unit: definition.canonical_unit,
      userId: input.userId,
      value,
    });
    const result = {
      event: await loadBiometricEvent(transaction, input.userId, eventId),
      replayed: false,
    };
    await recordFeatureOperation(transaction, input, "biometric", "event_create", eventId, result);
    return result;
  });
}
async function mutateManualBiometricEvent(
  database: Kysely<Database>,
  input: ReviseBiometricEventInput | DeleteBiometricEventInput,
  operation: "update" | "delete",
): Promise<BiometricEventMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    const profile = await requireActiveProfile(transaction, input.userId, true);
    const replay = await readFeatureReplay<BiometricEventMutationResult>(
      transaction,
      input,
      "biometric",
      `event_${operation}`,
    );
    if (replay) return replay;
    const head = await transaction
      .selectFrom("biometric_event as event")
      .innerJoin("biometric_event_revision as revision", "revision.id", "event.current_revision_id")
      .select([
        "event.id",
        "event.current_revision",
        "revision.definition_version_id",
        "revision.value",
        "revision.canonical_unit",
        "revision.measured_at",
        "revision.local_date",
        "revision.local_time",
        "revision.time_zone",
        "revision.note",
        "revision.provenance",
        "revision.source_kind",
      ])
      .where("event.id", "=", input.eventId)
      .where("event.user_id", "=", input.userId)
      .where("event.deleted_at", "is", null)
      .forUpdate("event")
      .executeTakeFirst();
    if (head?.source_kind !== "manual") throw new RetentionNotFoundError();
    if (head.current_revision !== canonicalRevision(input.expectedRevision))
      throw new RetentionRevisionConflictError();
    const definition = await transaction
      .selectFrom("biometric_definition_version")
      .select(["minimum_value", "maximum_value"])
      .where("id", "=", head.definition_version_id)
      .executeTakeFirstOrThrow();
    const next = (BigInt(head.current_revision) + 1n).toString();
    const revisionId = randomUUID();
    const revise = input as ReviseBiometricEventInput;
    const value =
      operation === "update" && revise.value !== undefined
        ? validateBiometricValue(revise.value, definition.minimum_value, definition.maximum_value)
        : canonicalSigned(head.value, "value");
    const measuredAt =
      operation === "update" && revise.measuredAt !== undefined
        ? revise.measuredAt
        : head.measured_at.toISOString();
    const coordinates =
      operation === "update" && revise.measuredAt !== undefined
        ? deriveCoordinates(measuredAt, profile.timeZone)
        : {
            localDate: head.local_date,
            localTime: head.local_time,
            occurredAt: head.measured_at.toISOString(),
            timeZone: head.time_zone,
          };
    await insertBiometricRevision(transaction, {
      coordinates,
      definitionVersionId: head.definition_version_id,
      eventId: head.id,
      note:
        operation === "update" && "note" in revise && revise.note !== undefined
          ? revise.note
          : head.note,
      operation,
      provenance: head.provenance,
      revisionId,
      revisionNumber: next,
      sourceKind: "manual",
      unit: head.canonical_unit,
      userId: input.userId,
      value,
    });
    await transaction
      .updateTable("biometric_event")
      .set({
        current_revision: next,
        current_revision_id: revisionId,
        deleted_at: operation === "delete" ? new Date() : null,
      })
      .where("id", "=", head.id)
      .execute();
    const result = {
      event:
        operation === "delete"
          ? null
          : await loadBiometricEvent(transaction, input.userId, head.id),
      replayed: false,
    };
    await recordFeatureOperation(
      transaction,
      input,
      "biometric",
      `event_${operation}`,
      head.id,
      result,
    );
    return result;
  });
}
function validateBiometricValue(value: string, min: string | null, max: string | null): string {
  const canonical = canonicalSigned(value, "value");
  const numeric = decimal(canonical, "value");
  if (
    (min !== null && numeric.lt(decimal(min, "minimumValue"))) ||
    (max !== null && numeric.gt(decimal(max, "maximumValue")))
  )
    throw new RetentionValidationError("Biometric value is outside its definition range");
  return canonical;
}
function deriveCoordinates(instant: string, timeZone: string) {
  try {
    return deriveDiaryLocalCoordinates(instant, timeZone);
  } catch {
    throw new RetentionValidationError("measuredAt is invalid");
  }
}
async function insertBiometricRevision(
  transaction: Transaction<Database>,
  input: {
    coordinates: ReturnType<typeof deriveDiaryLocalCoordinates>;
    definitionVersionId: string;
    eventId: string;
    note: string | null;
    operation: "create" | "delete" | "update";
    provenance: JsonObject;
    revisionId: string;
    revisionNumber: string;
    sourceKind: "manual" | "platform";
    sourceDeviceId?: string | null;
    unit: string;
    userId: string;
    value: string;
    provider?: string | null;
    externalSourceId?: string | null;
    externalRevision?: string | null;
    rawDigest?: string | null;
  },
) {
  await transaction
    .insertInto("biometric_event_revision")
    .values({
      canonical_unit: input.unit,
      definition_version_id: input.definitionVersionId,
      event_id: input.eventId,
      external_revision: input.externalRevision ?? null,
      external_source_id: input.externalSourceId ?? null,
      id: input.revisionId,
      local_date: input.coordinates.localDate,
      local_time: input.coordinates.localTime,
      measured_at: input.coordinates.occurredAt,
      note: input.note,
      operation: input.operation,
      provenance: input.provenance,
      provider: input.provider ?? null,
      raw_digest: input.rawDigest ?? null,
      revision_number: input.revisionNumber,
      source_kind: input.sourceKind,
      source_device_id: input.sourceDeviceId ?? null,
      time_zone: input.coordinates.timeZone,
      user_id: input.userId,
      value: input.value,
    })
    .execute();
}
async function loadBiometricEvent(
  database: DbExecutor,
  userId: string,
  id: string,
): Promise<BiometricEventRecord> {
  const row = await database
    .selectFrom("biometric_event as event")
    .innerJoin("biometric_event_revision as revision", "revision.id", "event.current_revision_id")
    .innerJoin(
      "biometric_definition_version as definition",
      "definition.id",
      "revision.definition_version_id",
    )
    .select([
      "event.id",
      "event.current_revision",
      "event.created_at",
      "event.updated_at",
      "event.deleted_at",
      "revision.operation",
      "revision.definition_version_id",
      "revision.value",
      "revision.canonical_unit",
      "revision.measured_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
      "revision.source_kind",
      "revision.source_device_id",
      "revision.provider",
      "revision.external_source_id",
      "revision.external_revision",
      "revision.raw_digest",
      "revision.provenance",
      "revision.note",
      "definition.definition_id",
      "definition.code",
      "definition.name",
    ])
    .where("event.id", "=", id)
    .where("event.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return {
    createdAt: row.created_at.toISOString(),
    currentRevision: row.current_revision,
    definition: { code: row.code, id: row.definition_id, name: row.name },
    definitionVersionId: row.definition_version_id,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    id: row.id,
    localDate: row.local_date,
    localTime: row.local_time,
    measuredAt: row.measured_at.toISOString(),
    note: row.note,
    operation: row.operation,
    source: {
      deviceId: row.source_device_id,
      externalRevision: row.external_revision,
      externalSourceId: row.external_source_id,
      kind: row.source_kind,
      provenance: row.provenance,
      provider: row.provider,
      rawDigest: row.raw_digest,
    },
    timeZone: row.time_zone,
    unit: row.canonical_unit,
    updatedAt: row.updated_at.toISOString(),
    value: canonicalSigned(row.value, "value"),
  };
}

async function writeReminderSchedule(
  database: Kysely<Database>,
  input: CreateReminderScheduleInput | ReviseReminderScheduleInput,
  scheduleId: string | null,
): Promise<ReminderScheduleMutationResult> {
  validateOperation(input);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    await requireActiveProfile(transaction, input.userId, true);
    const operation = scheduleId ? "revise" : "create";
    const replay = await readFeatureReplay<ReminderScheduleMutationResult>(
      transaction,
      input,
      "reminder",
      operation,
    );
    if (replay) return replay;
    const now = await transactionClock(transaction, input.schedule.after);
    const requestedStatus = scheduleId ? input.schedule.status : "active";
    if (scheduleId && requestedStatus === undefined)
      throw new RetentionValidationError("Reminder status is required for revision");
    let occurrence: ReturnType<typeof nextReminderOccurrence> | null = null;
    try {
      if (requestedStatus === "active") {
        occurrence = nextReminderOccurrence({
          after: now,
          daysOfWeek: input.schedule.daysOfWeek as readonly IsoWeekday[],
          localTime: input.schedule.localTime,
          timeZone: input.schedule.timeZone,
        });
      } else {
        // Validate the same canonical fields even though paused rows have no next delivery.
        canonicalIanaTimeZone(input.schedule.timeZone);
        nextReminderOccurrence({
          after: now,
          daysOfWeek: input.schedule.daysOfWeek as readonly IsoWeekday[],
          localTime: input.schedule.localTime,
          timeZone: input.schedule.timeZone,
        });
      }
    } catch {
      throw new RetentionValidationError("Reminder schedule is invalid");
    }
    let consentVersionId: string;
    const versionId = randomUUID();
    let rootId = scheduleId ?? randomUUID(),
      versionNumber = "1";
    if (scheduleId) {
      const root = await transaction
        .selectFrom("reminder_schedule")
        .selectAll()
        .where("id", "=", scheduleId)
        .where("user_id", "=", input.userId)
        .where("status", "in", ["active", "paused"])
        .forUpdate()
        .executeTakeFirst();
      if (!root) throw new RetentionNotFoundError();
      if (
        root.current_revision !==
        canonicalRevision((input as ReviseReminderScheduleInput).expectedRevision)
      )
        throw new RetentionRevisionConflictError();
      versionNumber = (BigInt(root.current_revision) + 1n).toString();
      const current = await transaction
        .selectFrom("reminder_schedule_version as schedule_version")
        .innerJoin(
          "reminder_consent_version as consent_version",
          "consent_version.id",
          "schedule_version.consent_version_id",
        )
        .innerJoin("reminder_consent as consent", "consent.id", "consent_version.consent_id")
        .select(["consent.current_version_id", "consent.status"])
        .where("schedule_version.id", "=", root.current_version_id)
        .where("schedule_version.user_id", "=", input.userId)
        .forShare("consent")
        .executeTakeFirstOrThrow();
      if (current.status !== "granted") throw new RetentionConsentRequiredError();
      consentVersionId = current.current_version_id;
      if (requestedStatus === "active")
        await assertReminderOccurrenceCapacity(
          transaction,
          input.userId,
          scheduleId,
          input.schedule.daysOfWeek.length,
        );
    } else {
      if (input.schedule.consentGranted !== true) throw new RetentionConsentRequiredError();
      await assertReminderOccurrenceCapacity(
        transaction,
        input.userId,
        null,
        input.schedule.daysOfWeek.length,
      );
      const count = await transaction
        .selectFrom("reminder_schedule")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .where("user_id", "=", input.userId)
        .where("status", "!=", "revoked")
        .executeTakeFirstOrThrow();
      if (BigInt(count.count) >= BigInt(MAX_NON_REVOKED_REMINDER_SCHEDULES))
        throw new RetentionValidationError("Reminder schedule limit reached");
      const consentId = randomUUID();
      consentVersionId = randomUUID();
      await transaction
        .insertInto("reminder_consent")
        .values({
          current_revision: "1",
          current_version_id: consentVersionId,
          id: consentId,
          status: "granted",
          user_id: input.userId,
        })
        .execute();
      await transaction
        .insertInto("reminder_consent_version")
        .values({
          consent_id: consentId,
          id: consentVersionId,
          occurred_at: now,
          policy_version: "local-reminders-v1",
          reason: null,
          status: "granted",
          user_id: input.userId,
          version_number: "1",
        })
        .execute();
      await transaction
        .insertInto("reminder_schedule")
        .values({
          current_revision: "1",
          current_version_id: versionId,
          id: rootId,
          next_delivery_at: occurrence?.instant ?? null,
          status: "active",
          user_id: input.userId,
        })
        .execute();
    }
    await transaction
      .insertInto("reminder_schedule_version")
      .values({
        channel: input.schedule.channel,
        consent_version_id: consentVersionId,
        days_of_week: [...new Set(input.schedule.daysOfWeek)].sort(),
        dst_policy: "earliest_offset_skip_gap",
        id: versionId,
        initial_delivery_at: occurrence?.instant ?? null,
        label: boundedText(input.schedule.label, 120, "label"),
        local_time: input.schedule.localTime,
        notification_body: "Time to check in.",
        notification_title: "Nutrition Tracker",
        schedule_id: rootId,
        schedule_status: requestedStatus ?? "active",
        time_zone: canonicalIanaTimeZone(input.schedule.timeZone),
        user_id: input.userId,
        version_number: versionNumber,
      })
      .execute();
    if (scheduleId)
      await transaction
        .updateTable("reminder_schedule")
        .set({
          current_revision: versionNumber,
          current_version_id: versionId,
          next_delivery_at: occurrence?.instant ?? null,
          status: requestedStatus ?? "active",
        })
        .where("id", "=", rootId)
        .execute();
    const result = {
      replayed: false,
      schedule: await loadReminderSchedule(transaction, input.userId, rootId),
    };
    await recordFeatureOperation(transaction, input, "reminder", operation, rootId, result);
    return result;
  });
}

async function assertReminderOccurrenceCapacity(
  transaction: Transaction<Database>,
  userId: string,
  excludedScheduleId: string | null,
  requestedOccurrences: number,
): Promise<void> {
  const result = await sql<{ occurrence_count: string }>`
    select coalesce(sum(cardinality(version.days_of_week)), 0)::text occurrence_count
    from reminder_schedule root
    join reminder_schedule_version version on version.id = root.current_version_id
    where root.user_id = ${userId}
      and root.status = 'active'
      and (${excludedScheduleId}::uuid is null or root.id <> ${excludedScheduleId}::uuid)
  `.execute(transaction);
  const activeOccurrences = BigInt(result.rows[0]?.occurrence_count ?? "0");
  if (activeOccurrences + BigInt(requestedOccurrences) > BigInt(MAX_ACTIVE_REMINDER_OCCURRENCES)) {
    throw new RetentionValidationError("Active reminder occurrence limit reached");
  }
}

async function transactionClock(
  transaction: Transaction<Database>,
  override?: string,
): Promise<string> {
  if (override !== undefined) return canonicalInstant(override);
  const result = await sql<{ now: Date }>`select clock_timestamp() now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!now) throw new RetentionValidationError("Database clock is unavailable");
  return now.toISOString();
}

async function consumeReauthenticationProofInTransaction(
  transaction: Transaction<Database>,
  input: ConsumeReauthenticationProofInput,
  consumedAt: string,
): Promise<ReauthenticationProofRecord> {
  const row = await transaction
    .updateTable("reauthentication_proof")
    .set({
      consumed_at: consumedAt,
      consumed_client_operation_id: input.clientOperationId,
    })
    .where("user_id", "=", input.userId)
    .where("session_token_hash", "=", input.sessionTokenHash)
    .where("purpose", "=", input.purpose)
    .where("token_hash", "=", input.tokenHash)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date(consumedAt))
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  return mapReauthenticationProof(row);
}
async function loadReminderSchedule(
  database: DbExecutor,
  userId: string,
  id: string,
): Promise<ReminderScheduleRecord> {
  const row = await database
    .selectFrom("reminder_schedule as root")
    .innerJoin("reminder_schedule_version as version", "version.id", "root.current_version_id")
    .innerJoin(
      "reminder_consent_version as consent_version",
      "consent_version.id",
      "version.consent_version_id",
    )
    .innerJoin("reminder_consent as consent", "consent.id", "consent_version.consent_id")
    .select([
      "root.id",
      "root.current_revision",
      "root.status",
      "root.next_delivery_at",
      "root.created_at",
      "root.updated_at",
      "root.revoked_at",
      "version.id as version_id",
      "version.label",
      "version.channel",
      "version.time_zone",
      "version.local_time",
      "version.days_of_week",
      "version.dst_policy",
      "version.notification_title",
      "version.notification_body",
      "consent.status as consent_status",
      "consent.id as consent_id",
      "consent_version.policy_version",
      "consent_version.occurred_at as consent_occurred_at",
    ])
    .where("root.id", "=", id)
    .where("root.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new RetentionNotFoundError();
  const granted = await database
    .selectFrom("reminder_consent_version")
    .select("occurred_at")
    .where("consent_id", "=", row.consent_id)
    .where("status", "=", "granted")
    .orderBy("version_number")
    .executeTakeFirst();
  if (!granted) throw new RetentionConsentRequiredError();
  return {
    channel: row.channel,
    consent: {
      grantedAt: granted.occurred_at.toISOString(),
      policyVersion: "local-reminders-v1",
      revokedAt: row.consent_status === "revoked" ? row.consent_occurred_at.toISOString() : null,
    },
    createdAt: row.created_at.toISOString(),
    currentRevision: row.current_revision,
    currentVersionId: row.version_id,
    daysOfWeek: row.days_of_week,
    dstPolicy: row.dst_policy,
    id: row.id,
    label: row.label,
    localTime: row.local_time,
    nextDeliveryAt: row.next_delivery_at?.toISOString() ?? null,
    deliveryPolicy: {
      includesHealthDetails: false,
      lockScreenText: "Time to check in.",
      title: "Nutrition Tracker",
    },
    revokedAt: row.revoked_at?.toISOString() ?? null,
    status: row.status,
    timeZone: row.time_zone,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function applyHealthImport(
  database: Kysely<Database>,
  input: PlatformHealthImportInput,
): Promise<PlatformHealthImportRecord> {
  requireDigest(input.rawDigest, "rawDigest");
  const modified = canonicalInstant(input.providerModifiedAt);
  return database.transaction().execute(async (transaction) => {
    await lockRetentionUser(transaction, input.userId);
    const profile = await requireActiveProfile(transaction, input.userId, true);
    const device = await transaction
      .selectFrom("device_registration")
      .select("id")
      .where("id", "=", input.deviceId)
      .where("user_id", "=", input.userId)
      .where("revoked_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!device) throw new RetentionNotFoundError();
    const integration = await transaction
      .selectFrom("platform_integration")
      .select(["id", "current_source_cursor"])
      .where("id", "=", input.integrationId)
      .where("user_id", "=", input.userId)
      .where("device_id", "=", input.deviceId)
      .where("status", "=", "connected")
      .forUpdate()
      .executeTakeFirst();
    if (!integration) throw new RetentionConsentRequiredError();
    const root = await transaction
      .selectFrom("platform_health_import")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("provider", "=", boundedText(input.provider, 64, "provider"))
      .where(
        "external_source_id",
        "=",
        boundedText(input.externalSourceId, 500, "externalSourceId"),
      )
      .forUpdate()
      .executeTakeFirst();
    if (root) {
      const current = await transaction
        .selectFrom("platform_health_import_revision")
        .selectAll()
        .where("id", "=", root.current_revision_id)
        .executeTakeFirstOrThrow();
      if (current.provider_revision === input.providerRevision) {
        if (current.raw_digest === input.rawDigest && current.operation === input.operation)
          return {
            conflictId: null,
            duplicate: true,
            eventId: root.current_event_id,
            externalSourceId: root.external_source_id,
            id: root.id,
            operation: current.operation,
            provider: root.provider,
            providerModifiedAt: current.provider_modified_at.toISOString(),
            providerRevision: current.provider_revision,
            rawDigest: current.raw_digest,
            revision: root.current_revision,
            state: root.state,
          };
        const conflict = await transaction
          .insertInto("platform_health_import_conflict")
          .values({
            attempted_raw_digest: input.rawDigest,
            evidence: { operation: input.operation },
            existing_raw_digest: current.raw_digest,
            import_id: root.id,
            provider_modified_at: modified,
            provider_revision: input.providerRevision,
            user_id: input.userId,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("platform_health_import")
          .set({ state: "conflict" })
          .where("id", "=", root.id)
          .execute();
        return {
          conflictId: conflict.id,
          duplicate: false,
          eventId: root.current_event_id,
          externalSourceId: root.external_source_id,
          id: root.id,
          operation: input.operation,
          provider: root.provider,
          providerModifiedAt: modified,
          providerRevision: input.providerRevision,
          rawDigest: input.rawDigest,
          revision: root.current_revision,
          state: "conflict",
        };
      }
    }
    const importId = root?.id ?? randomUUID();
    const revisionNumber = root ? (BigInt(root.current_revision) + 1n).toString() : "1";
    const importRevisionId = randomUUID();
    let eventId: string | null = root?.current_event_id ?? null,
      eventRevisionId: string | null = null;
    if (input.operation === "upsert") {
      if (
        !input.definitionVersionId ||
        !input.measuredAt ||
        input.canonicalValue === undefined ||
        !input.canonicalUnit
      )
        throw new RetentionValidationError("Import upsert requires normalized biometric facts");
      const definition = await transaction
        .selectFrom("biometric_definition_version as version")
        .innerJoin("biometric_definition as definition", "definition.id", "version.definition_id")
        .select([
          "version.id",
          "version.canonical_unit",
          "version.minimum_value",
          "version.maximum_value",
        ])
        .where("version.id", "=", input.definitionVersionId)
        .where("definition.user_id", "=", input.userId)
        .executeTakeFirst();
      if (!definition || definition.canonical_unit !== input.canonicalUnit)
        throw new RetentionValidationError("Import unit does not match definition");
      const value = validateBiometricValue(
        input.canonicalValue,
        definition.minimum_value,
        definition.maximum_value,
      );
      const coordinates = deriveCoordinates(input.measuredAt, profile.timeZone);
      eventId = eventId ?? randomUUID();
      eventRevisionId = randomUUID();
      const currentEvent = root?.current_event_id
        ? await transaction
            .selectFrom("biometric_event")
            .select("current_revision")
            .where("id", "=", eventId)
            .forUpdate()
            .executeTakeFirstOrThrow()
        : null;
      const eventRevisionNumber = currentEvent
        ? (BigInt(currentEvent.current_revision) + 1n).toString()
        : "1";
      if (eventRevisionNumber === "1")
        await transaction
          .insertInto("biometric_event")
          .values({
            current_revision: "1",
            current_revision_id: eventRevisionId,
            id: eventId,
            user_id: input.userId,
          })
          .execute();
      await insertBiometricRevision(transaction, {
        coordinates,
        definitionVersionId: definition.id,
        eventId,
        externalRevision: input.providerRevision,
        externalSourceId: input.externalSourceId,
        note: null,
        operation: eventRevisionNumber === "1" ? "create" : "update",
        provenance: input.provenance,
        provider: input.provider,
        rawDigest: input.rawDigest,
        revisionId: eventRevisionId,
        revisionNumber: eventRevisionNumber,
        sourceKind: "platform",
        sourceDeviceId: input.deviceId,
        unit: input.canonicalUnit,
        userId: input.userId,
        value,
      });
      if (eventRevisionNumber !== "1")
        await transaction
          .updateTable("biometric_event")
          .set({
            current_revision: eventRevisionNumber,
            current_revision_id: eventRevisionId,
            deleted_at: null,
          })
          .where("id", "=", eventId)
          .execute();
    } else if (eventId) {
      const event = await transaction
        .selectFrom("biometric_event as event")
        .innerJoin(
          "biometric_event_revision as revision",
          "revision.id",
          "event.current_revision_id",
        )
        .select([
          "event.current_revision",
          "revision.definition_version_id",
          "revision.value",
          "revision.canonical_unit",
          "revision.measured_at",
          "revision.provenance",
        ])
        .where("event.id", "=", eventId)
        .forUpdate("event")
        .executeTakeFirstOrThrow();
      eventRevisionId = randomUUID();
      const next = (BigInt(event.current_revision) + 1n).toString();
      await insertBiometricRevision(transaction, {
        coordinates: deriveCoordinates(event.measured_at.toISOString(), profile.timeZone),
        definitionVersionId: event.definition_version_id,
        eventId,
        externalRevision: input.providerRevision,
        externalSourceId: input.externalSourceId,
        note: null,
        operation: "delete",
        provenance: event.provenance,
        provider: input.provider,
        rawDigest: input.rawDigest,
        revisionId: eventRevisionId,
        revisionNumber: next,
        sourceKind: "platform",
        sourceDeviceId: input.deviceId,
        unit: event.canonical_unit,
        userId: input.userId,
        value: event.value,
      });
      await transaction
        .updateTable("biometric_event")
        .set({
          current_revision: next,
          current_revision_id: eventRevisionId,
          deleted_at: new Date(modified),
        })
        .where("id", "=", eventId)
        .execute();
    }
    if (!root) {
      await transaction
        .insertInto("platform_health_import")
        .values({
          current_event_id: eventId,
          current_revision: "1",
          current_revision_id: importRevisionId,
          device_id: input.deviceId,
          external_source_id: input.externalSourceId,
          id: importId,
          integration_id: integration.id,
          provider: input.provider,
          state: input.operation === "delete" ? "deleted" : "active",
          user_id: input.userId,
        })
        .execute();
    }
    await transaction
      .insertInto("platform_health_import_revision")
      .values({
        biometric_event_revision_id: eventRevisionId,
        canonical_unit: input.operation === "upsert" ? (input.canonicalUnit ?? null) : null,
        canonical_value: input.operation === "upsert" ? (input.canonicalValue ?? null) : null,
        definition_version_id:
          input.operation === "upsert" ? (input.definitionVersionId ?? null) : null,
        id: importRevisionId,
        import_id: importId,
        measured_at: input.operation === "upsert" ? (input.measuredAt ?? null) : null,
        operation: input.operation,
        provenance: input.provenance,
        provider_modified_at: modified,
        provider_revision: boundedText(input.providerRevision, 300, "providerRevision"),
        raw_digest: input.rawDigest,
        revision_number: revisionNumber,
        user_id: input.userId,
      })
      .execute();
    if (root)
      await transaction
        .updateTable("platform_health_import")
        .set({
          current_event_id: eventId,
          current_revision: revisionNumber,
          current_revision_id: importRevisionId,
          state: input.operation === "delete" ? "deleted" : "active",
        })
        .where("id", "=", root.id)
        .execute();
    return {
      conflictId: null,
      duplicate: false,
      eventId,
      externalSourceId: input.externalSourceId,
      id: importId,
      operation: input.operation,
      provider: input.provider,
      providerModifiedAt: modified,
      providerRevision: input.providerRevision,
      rawDigest: input.rawDigest,
      revision: revisionNumber,
      state: input.operation === "delete" ? "deleted" : "active",
    };
  });
}

async function loadPlatformIntegration(
  database: DbExecutor,
  userId: string,
  integrationId: string,
): Promise<PlatformIntegrationRecord> {
  const root = await database
    .selectFrom("platform_integration")
    .selectAll()
    .where("id", "=", integrationId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!root) throw new RetentionNotFoundError();
  const history = await database
    .selectFrom("platform_integration_version")
    .select(["id", "status", "data_type_codes", "recorded_at"])
    .where("integration_id", "=", root.id)
    .where("user_id", "=", userId)
    .orderBy("version_number")
    .execute();
  return {
    consentGrantedAt: root.consent_granted_at.toISOString(),
    consentHistory: history.map((version) => ({
      dataTypeCodes: version.data_type_codes as ["body_weight"],
      id: version.id,
      recordedAt: version.recorded_at.toISOString(),
      status: version.status === "connected" ? "granted" : "revoked",
    })),
    currentRevision: root.current_revision,
    cursorEpoch: root.cursor_epoch,
    currentSourceCursor: root.current_source_cursor,
    dataTypeCodes: root.data_type_codes as ["body_weight"],
    deviceId: root.device_id,
    disconnectedAt: root.disconnected_at?.toISOString() ?? null,
    id: root.id,
    lastImportAt: root.last_import_at?.toISOString() ?? null,
    platform: root.platform,
    status: root.status,
  };
}

async function ensureBodyWeightDefinition(
  transaction: Transaction<Database>,
  userId: string,
): Promise<{ id: string; canonicalUnit: string }> {
  const existing = await loadBodyWeightDefinition(transaction, userId, false);
  if (existing) return { canonicalUnit: existing.canonicalUnit, id: existing.id };
  const count = await transaction
    .selectFrom("biometric_definition")
    .select((builder) => builder.fn.countAll<string>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  if (BigInt(count.count) >= 100n)
    throw new RetentionValidationError("Biometric definition limit reached");
  const definitionId = randomUUID();
  const versionId = randomUUID();
  await transaction
    .insertInto("biometric_definition")
    .values({
      current_revision: "1",
      current_version_id: versionId,
      id: definitionId,
      user_id: userId,
    })
    .execute();
  await transaction
    .insertInto("biometric_definition_version")
    .values({
      canonical_unit: "kg",
      code: "body_weight",
      definition_id: definitionId,
      dimension: "mass",
      id: versionId,
      maximum_value: null,
      metadata: { notes: "Normalized body weight imported with explicit consent." },
      minimum_value: "0",
      name: "Body weight",
      user_id: userId,
      version_number: "1",
    })
    .execute();
  return { canonicalUnit: "kg", id: versionId };
}

async function loadBodyWeightDefinition(
  database: DbExecutor,
  userId: string,
  required?: true,
): Promise<{
  id: string;
  canonicalUnit: string;
  minimumValue: string | null;
  maximumValue: string | null;
}>;
async function loadBodyWeightDefinition(
  database: DbExecutor,
  userId: string,
  required: false,
): Promise<{
  id: string;
  canonicalUnit: string;
  minimumValue: string | null;
  maximumValue: string | null;
} | null>;
async function loadBodyWeightDefinition(database: DbExecutor, userId: string, required = true) {
  const row = await database
    .selectFrom("biometric_definition as root")
    .innerJoin("biometric_definition_version as version", "version.id", "root.current_version_id")
    .select([
      "version.id",
      "version.canonical_unit",
      "version.minimum_value",
      "version.maximum_value",
    ])
    .where("root.user_id", "=", userId)
    .where("root.status", "=", "active")
    .where("version.code", "=", "body_weight")
    .executeTakeFirst();
  if (!row) {
    if (required) throw new RetentionNotFoundError();
    return null;
  }
  return {
    canonicalUnit: row.canonical_unit,
    id: row.id,
    maximumValue: row.maximum_value,
    minimumValue: row.minimum_value,
  };
}

async function applyPlatformImportRecord(
  transaction: Transaction<Database>,
  input: {
    readonly batchId: string;
    readonly definition: NonNullable<Awaited<ReturnType<typeof loadBodyWeightDefinition>>>;
    readonly deviceId: string;
    readonly integrationId: string;
    readonly platform: HealthPlatform;
    readonly record: PlatformImportRecordInput;
    readonly signedAt: string;
    readonly userId: string;
  },
): Promise<{
  applied: boolean;
  duplicate?: boolean;
  conflict?: PlatformHealthImportBatchResult["conflicts"][number];
}> {
  const externalId = boundedText(input.record.externalId, 500, "externalId");
  const externalRevision = boundedText(input.record.externalRevision, 300, "externalRevision");
  const rawDigest = sha256(canonicalJson(input.record as unknown as JsonValue));
  const root = await transaction
    .selectFrom("platform_health_import")
    .selectAll()
    .where("integration_id", "=", input.integrationId)
    .where("external_source_id", "=", externalId)
    .forUpdate()
    .executeTakeFirst();
  if (root) {
    const current = await transaction
      .selectFrom("platform_health_import_revision")
      .select(["provider_revision", "raw_digest", "operation"])
      .where("id", "=", root.current_revision_id)
      .executeTakeFirstOrThrow();
    if (current.provider_revision === externalRevision) {
      if (current.raw_digest === rawDigest && current.operation === input.record.operation)
        return { applied: false, duplicate: true };
      await transaction
        .insertInto("platform_health_import_conflict")
        .values({
          attempted_raw_digest: rawDigest,
          evidence: { batchId: input.batchId, code: "SOURCE_ID_REUSED" },
          existing_raw_digest: current.raw_digest,
          import_id: root.id,
          provider_modified_at: input.signedAt,
          provider_revision: externalRevision,
          user_id: input.userId,
        })
        .execute();
      await transaction
        .updateTable("platform_health_import")
        .set({ state: "conflict" })
        .where("id", "=", root.id)
        .execute();
      return {
        applied: false,
        conflict: {
          code: "SOURCE_ID_REUSED",
          currentRevision: current.provider_revision,
          externalId,
          submittedRevision: externalRevision,
        },
      };
    }
  }
  const importId = root?.id ?? randomUUID();
  const importRevisionId = randomUUID();
  const importRevision = root ? (BigInt(root.current_revision) + 1n).toString() : "1";
  let eventId = root?.current_event_id ?? null;
  let eventRevisionId: string | null = null;
  if (input.record.operation === "upsert") {
    if (input.record.definitionCode !== "body_weight" || input.record.unit !== "kg")
      throw new RetentionValidationError("Only canonical body_weight kg imports are supported");
    canonicalIanaTimeZone(input.record.recordedTimeZone);
    const value = validateBiometricValue(
      input.record.value,
      input.definition.minimumValue,
      input.definition.maximumValue,
    );
    const coordinates = deriveCoordinates(input.record.measuredAt, input.record.recordedTimeZone);
    let eventRevision = "1";
    if (eventId) {
      const event = await transaction
        .selectFrom("biometric_event")
        .select("current_revision")
        .where("id", "=", eventId)
        .where("user_id", "=", input.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      eventRevision = (BigInt(event.current_revision) + 1n).toString();
    } else {
      eventId = randomUUID();
    }
    eventRevisionId = randomUUID();
    if (eventRevision === "1")
      await transaction
        .insertInto("biometric_event")
        .values({
          current_revision: "1",
          current_revision_id: eventRevisionId,
          id: eventId,
          user_id: input.userId,
        })
        .execute();
    await insertBiometricRevision(transaction, {
      coordinates,
      definitionVersionId: input.definition.id,
      eventId,
      externalRevision,
      externalSourceId: externalId,
      note: null,
      operation: eventRevision === "1" ? "create" : "update",
      provenance: {
        batchId: input.batchId,
        recordedTimeZone: input.record.recordedTimeZone,
      },
      provider: input.platform,
      rawDigest,
      revisionId: eventRevisionId,
      revisionNumber: eventRevision,
      sourceKind: "platform",
      sourceDeviceId: input.deviceId,
      unit: "kg",
      userId: input.userId,
      value,
    });
    if (eventRevision !== "1")
      await transaction
        .updateTable("biometric_event")
        .set({
          current_revision: eventRevision,
          current_revision_id: eventRevisionId,
          deleted_at: null,
        })
        .where("id", "=", eventId)
        .execute();
  } else if (eventId) {
    const head = await transaction
      .selectFrom("biometric_event as event")
      .innerJoin("biometric_event_revision as revision", "revision.id", "event.current_revision_id")
      .select([
        "event.current_revision",
        "revision.definition_version_id",
        "revision.value",
        "revision.canonical_unit",
        "revision.measured_at",
        "revision.local_date",
        "revision.local_time",
        "revision.time_zone",
        "revision.provenance",
      ])
      .where("event.id", "=", eventId)
      .where("event.user_id", "=", input.userId)
      .forUpdate("event")
      .executeTakeFirstOrThrow();
    const eventRevision = (BigInt(head.current_revision) + 1n).toString();
    eventRevisionId = randomUUID();
    await insertBiometricRevision(transaction, {
      coordinates: {
        localDate: head.local_date,
        localTime: head.local_time,
        occurredAt: head.measured_at.toISOString(),
        timeZone: head.time_zone,
      },
      definitionVersionId: head.definition_version_id,
      eventId,
      externalRevision,
      externalSourceId: externalId,
      note: null,
      operation: "delete",
      provenance: head.provenance,
      provider: input.platform,
      rawDigest,
      revisionId: eventRevisionId,
      revisionNumber: eventRevision,
      sourceKind: "platform",
      sourceDeviceId: input.deviceId,
      unit: head.canonical_unit,
      userId: input.userId,
      value: head.value,
    });
    await transaction
      .updateTable("biometric_event")
      .set({
        current_revision: eventRevision,
        current_revision_id: eventRevisionId,
        deleted_at: input.signedAt,
      })
      .where("id", "=", eventId)
      .execute();
  }
  if (!root) {
    await transaction
      .insertInto("platform_health_import")
      .values({
        current_event_id: eventId,
        current_revision: "1",
        current_revision_id: importRevisionId,
        device_id: input.deviceId,
        external_source_id: externalId,
        id: importId,
        integration_id: input.integrationId,
        provider: input.platform,
        state: input.record.operation === "delete" ? "deleted" : "active",
        user_id: input.userId,
      })
      .execute();
  }
  await transaction
    .insertInto("platform_health_import_revision")
    .values({
      biometric_event_revision_id: eventRevisionId,
      canonical_unit: input.record.operation === "upsert" ? "kg" : null,
      canonical_value: input.record.operation === "upsert" ? input.record.value : null,
      definition_version_id: input.record.operation === "upsert" ? input.definition.id : null,
      id: importRevisionId,
      import_id: importId,
      measured_at: input.record.operation === "upsert" ? input.record.measuredAt : null,
      operation: input.record.operation,
      provenance: {
        batchId: input.batchId,
        recordedTimeZone:
          input.record.operation === "upsert" ? input.record.recordedTimeZone : null,
      },
      provider_modified_at: input.signedAt,
      provider_revision: externalRevision,
      raw_digest: rawDigest,
      revision_number: importRevision,
      user_id: input.userId,
    })
    .execute();
  if (root)
    await transaction
      .updateTable("platform_health_import")
      .set({
        current_event_id: eventId,
        current_revision: importRevision,
        current_revision_id: importRevisionId,
        device_id: input.deviceId,
        state: input.record.operation === "delete" ? "deleted" : "active",
      })
      .where("id", "=", root.id)
      .execute();
  return { applied: true };
}

/** Worker streams each page to a 0600 spool; no export row set is buffered in Node. */
type PrivacyExportEntitySpec = {
  readonly entity: PrivacyExportEntity;
  readonly table: string;
  readonly from: string;
  readonly userColumn: string;
  readonly entityId: string;
  readonly revision: string;
  readonly deleted: string;
  readonly redacted?: readonly string[];
};
const EXPORT_ENTITY_SPECS: readonly PrivacyExportEntitySpec[] = [
  exportSpec(
    "account",
    "app_user",
    "app_user t",
    "t.id",
    "t.id::text",
    "null",
    "t.deleted_at is not null",
    ["auth_subject"],
  ),
  exportSpec(
    "profile",
    "user_profile",
    "user_profile t",
    "t.user_id",
    "t.user_id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "user_watermark",
    "user_data_watermark",
    "user_data_watermark t",
    "t.user_id",
    "t.user_id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "session",
    "user_session",
    "user_session t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["token_hash"],
  ),
  exportSpec(
    "diary_day",
    "diary",
    "diary t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "diary_entry",
    "diary_entry",
    "diary_entry t",
    "t.user_id",
    "t.id::text",
    "t.current_revision_number::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "diary_entry_legacy_nutrient",
    "diary_entry_nutrient_snapshot",
    "diary_entry_nutrient_snapshot t join diary_entry owner on owner.id=t.diary_entry_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_id::text,t.nutrient_id::text)",
    "owner.current_revision_number::text",
    "owner.deleted_at is not null",
  ),
  exportSpec(
    "diary_entry_revision",
    "diary_entry_revision",
    "diary_entry_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "diary_entry_nutrient",
    "diary_entry_revision_nutrient",
    "diary_entry_revision_nutrient t join diary_entry_revision owner on owner.id=t.diary_entry_revision_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_revision_id::text,t.nutrient_id::text)",
    "owner.revision_number::text",
    "owner.operation = 'delete'",
  ),
  exportSpec(
    "diary_entry_source",
    "diary_entry_revision_source",
    "diary_entry_revision_source t join diary_entry_revision owner on owner.id=t.diary_entry_revision_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_revision_id::text,t.food_source_id::text,t.source_release_id::text)",
    "owner.revision_number::text",
    "owner.operation = 'delete'",
  ),
  exportSpec(
    "diary_operation",
    "diary_operation",
    "diary_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "recipe",
    "recipe",
    "recipe t",
    "t.owner_user_id",
    "t.id::text",
    "null",
    "t.status = 'archived'",
  ),
  exportSpec(
    "recipe_version",
    "recipe_version",
    "recipe_version t",
    "t.owner_user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_ingredient",
    "recipe_ingredient",
    "recipe_ingredient t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "t.id::text",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_nutrient",
    "recipe_version_nutrient",
    "recipe_version_nutrient t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "concat_ws(':',t.recipe_version_id::text,t.nutrient_id::text)",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_source",
    "recipe_version_source",
    "recipe_version_source t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "concat_ws(':',t.recipe_version_id::text,t.food_source_id::text,t.source_release_id::text)",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_operation",
    "recipe_operation",
    "recipe_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "nutrition_goal",
    "nutrition_goal",
    "nutrition_goal t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_version",
    "nutrition_goal_version",
    "nutrition_goal_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.goal_status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_target",
    "nutrition_goal_target",
    "nutrition_goal_target t join nutrition_goal_version owner on owner.id=t.nutrition_goal_version_id",
    "owner.user_id",
    "concat_ws(':',t.nutrition_goal_version_id::text,t.nutrient_id::text)",
    "owner.version_number::text",
    "owner.goal_status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_operation",
    "nutrition_goal_operation",
    "nutrition_goal_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food",
    "custom_food",
    "custom_food t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'archived'",
  ),
  exportSpec(
    "custom_food_version",
    "custom_food_version",
    "custom_food_version t join custom_food owner on owner.id=t.custom_food_id",
    "owner.user_id",
    "concat_ws(':',t.custom_food_id::text,t.food_version_id::text)",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_nutrient",
    "custom_food_version_nutrient",
    "custom_food_version_nutrient t join custom_food owner on owner.id=t.custom_food_id",
    "owner.user_id",
    "concat_ws(':',t.custom_food_id::text,t.food_version_id::text,t.nutrient_id::text)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food_operation",
    "custom_food_operation",
    "custom_food_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_food",
    "food",
    "food t",
    "t.owner_user_id",
    "t.id::text",
    "null",
    "t.archived_at is not null",
  ),
  exportSpec(
    "custom_food_catalogue_barcode",
    "food_barcode",
    "food_barcode t join food owner on owner.id=t.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "null",
    "owner.archived_at is not null",
  ),
  exportSpec(
    "custom_food_catalogue_version",
    "food_version",
    "food_version t join food owner on owner.id=t.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_serving",
    "food_serving",
    "food_serving t join food_version version on version.id=t.food_version_id join food owner on owner.id=version.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "version.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_nutrient",
    "food_nutrient_value",
    "food_nutrient_value t join food_version version on version.id=t.food_version_id join food owner on owner.id=version.food_id",
    "owner.owner_user_id",
    "concat_ws(':',t.food_version_id::text,t.nutrient_id::text)",
    "version.version_number::text",
    "false",
  ),
  exportSpec(
    "biometric_definition",
    "biometric_definition",
    "biometric_definition t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'archived'",
  ),
  exportSpec(
    "biometric_definition_version",
    "biometric_definition_version",
    "biometric_definition_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "biometric_definition_operation",
    "biometric_definition_operation",
    "biometric_definition_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "biometric_event",
    "biometric_event",
    "biometric_event t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "biometric_event_revision",
    "biometric_event_revision",
    "biometric_event_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "biometric_event_operation",
    "biometric_event_operation",
    "biometric_event_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "reminder_consent",
    "reminder_consent",
    "reminder_consent t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_consent_version",
    "reminder_consent_version",
    "reminder_consent_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_schedule",
    "reminder_schedule",
    "reminder_schedule t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_schedule_version",
    "reminder_schedule_version",
    "reminder_schedule_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.schedule_status = 'revoked'",
  ),
  exportSpec(
    "reminder_delivery",
    "reminder_delivery_outbox",
    "reminder_delivery_outbox t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.status = 'cancelled'",
  ),
  exportSpec(
    "device",
    "device_registration",
    "device_registration t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "t.revoked_at is not null",
    ["public_key_spki_base64", "key_fingerprint", "proof_signature_digest"],
  ),
  exportSpec(
    "platform_integration",
    "platform_integration",
    "platform_integration t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'disconnected'",
  ),
  exportSpec(
    "platform_integration_version",
    "platform_integration_version",
    "platform_integration_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.status = 'disconnected'",
  ),
  exportSpec(
    "platform_import_batch",
    "platform_import_batch",
    "platform_import_batch t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
    ["nonce_hash", "signature_digest"],
  ),
  exportSpec(
    "platform_health_import",
    "platform_health_import",
    "platform_health_import t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.state = 'deleted'",
  ),
  exportSpec(
    "platform_health_import_revision",
    "platform_health_import_revision",
    "platform_health_import_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "platform_health_import_conflict",
    "platform_health_import_conflict",
    "platform_health_import_conflict t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "retention_operation",
    "retention_operation",
    "retention_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.feature,t.operation)",
    "null",
    "false",
    ["result_payload"],
  ),
  exportSpec(
    "audit_event",
    "audit_log",
    "audit_log t",
    "coalesce(t.subject_user_id,t.actor_user_id)",
    "t.id::text",
    "null",
    "false",
    [
      "actor_user_id",
      "subject_user_id",
      "source_ip",
      "request_id",
      "user_agent",
      "before_state",
      "after_state",
      "context",
    ],
  ),
  exportSpec(
    "privacy_export_job",
    "privacy_export_job",
    "privacy_export_job t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "privacy_export_artifact",
    "privacy_export_artifact",
    "privacy_export_artifact t join privacy_export_job owner on owner.id=t.job_id",
    "owner.user_id",
    "t.id::text",
    "null",
    "false",
    ["object_key", "encryption_key_id", "ciphertext_bytes"],
  ),
  exportSpec(
    "privacy_export_artifact_deletion",
    "privacy_export_artifact_deletion",
    "privacy_export_artifact_deletion t join privacy_export_artifact artifact on artifact.id=t.artifact_id join privacy_export_job owner on owner.id=artifact.job_id",
    "owner.user_id",
    "t.artifact_id::text",
    "null",
    "t.status = 'completed'",
    ["deletion_evidence_digest"],
  ),
  exportSpec(
    "privacy_export_artifact_tombstone",
    "privacy_export_artifact_tombstone",
    "privacy_export_artifact_tombstone t join privacy_export_job owner on owner.id=t.job_id",
    "owner.user_id",
    "t.artifact_id::text",
    "null",
    "true",
    ["deletion_evidence_digest"],
  ),
  exportSpec(
    "privacy_export_download_audit",
    "privacy_export_download_audit",
    "privacy_export_download_audit t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "security_challenge",
    "security_challenge",
    "security_challenge t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["nonce_hash", "proof_signature_digest"],
  ),
  exportSpec(
    "reauthentication_proof",
    "reauthentication_proof",
    "reauthentication_proof t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["session_token_hash", "token_hash"],
  ),
];

// This closed schema fingerprint is the export column-classification allowlist. Every current
// column is either deliberately emitted or named in the entity's redacted set above. A forward
// schema change therefore fails export before a row is materialized until it is reviewed here.
const EXPORT_TABLE_SCHEMA_SHA256: Readonly<Record<string, string>> = {
  app_user: "2289e77b06addc3a6edffbac67395ea570347b4d02bf5371cba92e245e88af67",
  audit_log: "b0f3e21291cb254ff5e1030da753753807b74a9287c029b3a44430f7cdf0a863",
  biometric_definition: "8c9270ac3ef872064ea2cf0faf8a6f98fead61cf47f0a62ef0c7b0579674f467",
  biometric_definition_operation:
    "c49d630acc0a25898d6888889a15d3df213464bb3707765d3d376e21f89d4f10",
  biometric_definition_version: "7753d037755ac2df263565b867a6263b0a630cac3ec0476c8bc3089ccebfe2c5",
  biometric_event: "a1bb0e5ecb718e561899eb7b6a7179280d32e82f73fcbf37ba8ead99519bbccd",
  biometric_event_operation: "6bfe8ffac06ed35a8e9ab1d5922f7366c1e8f8a68c3b6ee46495ac0705378652",
  biometric_event_revision: "e296d84c26b34f424ca280fa779c01279e3aeb37223a430d7a92efe7623a5e5a",
  custom_food: "30feab0c34b065a255a50fcf55cc8050a33f57ac40312aec0fbfa87834458801",
  custom_food_operation: "70b37ca40ca11c4cd82146375e5cf35f6b41d449f0034b439c01e8018bc450bd",
  custom_food_version: "a3695fa5f1b723773800992df57523e9adeb154162585d510a6c07f09f1b9b92",
  custom_food_version_nutrient: "bf931400f740355dfce090866a6f8689dbd21a119c130e903f1ef0e1f39ee2ca",
  device_registration: "43f41397b73aa4ced8190e4076b3db85a01134a20d0a07f6f8b0f3ea5a4a5a5e",
  diary: "06814ccd20f3a56129130e02680f19a0c9a20540041940ab3469be149c5ba5df",
  diary_entry: "ad7bdfb736d6386fe07477fba57254c86b69c7e7c36c160c94271705d594f783",
  diary_entry_nutrient_snapshot: "c2bafc54df416990f1a9dc11c9da1396627e468eb5e936ced8b55818f689f969",
  diary_entry_revision: "289417ab93c81c2e44a15c6009f34c7ff57ff791357dd42f14cbf5292652f4e4",
  diary_entry_revision_nutrient: "388c6c4eb2b9983800a29313657545386770a27c6dc9446c85522c85bc14d7f1",
  diary_entry_revision_source: "1bd5f08fd5c9eab526d5ef1c357e7001c737a136749b84db020b7ba819cfea8f",
  diary_operation: "ab5534bf4cdccd950a62b869263b9ae92eff36599f7ad87e651e2542b96a2519",
  food: "87d5d13ee059ec83262c138c10fc68e85832fdc2bd6386f60c3a92276232d62a",
  food_barcode: "64b92aed5df48b3035d2f1abeab3f25ad5c6ac74ae5282d31b2b4b7f1eae0962",
  food_nutrient_value: "205612a35d2db5dfee5f2a06a3a5431880e8334c6fcf0b22e71ae4509ace2b52",
  food_serving: "ea541ebd2e446c05867a4126f4399685d1d92302691e5c33525b8506f2799e63",
  food_version: "db0fc9994d348d810118b945b7e783af43cd783368e78a4e339dc72283809dc2",
  nutrition_goal: "d985a98a3aae2060aa928f9605c516cd7261b6a68da0a3275448260f71819646",
  nutrition_goal_operation: "60572bb70b101b42ffde1213c5993b1bfd5ec5fd19a35c0b5989db2d9ea20ad9",
  nutrition_goal_target: "418e30c9b41e388febcf8d369e31910c7600ede3b947ad76ef71bbf0b560ce67",
  nutrition_goal_version: "9df43444af8db1a8ba973980b1b19154e3098c9a0d26db3c6118516837045c3b",
  platform_health_import: "f6d11d7b18dd4d63cf97ab5c1aafa8c5492753081442308445f920e9182be4b3",
  platform_health_import_conflict:
    "8c377087ea6f221dfd1fadd5021e1431a01ce1901792af0cecdda75c78081865",
  platform_health_import_revision:
    "fe6593f2d066eee06ba6643e5213354fb5a8cd730ee663ff46ffc0ae5827865c",
  platform_import_batch: "9d83a41347499fe0bb7994c58cab754ec3945c4145da64576f25d78d465fb0e5",
  platform_integration: "3a32873670c5de79c17580e65dec5cf96a5131a3f829a6052e8fd5cdc13a2c51",
  platform_integration_version: "b61bdc134442afa128adba6ff15cad79730361d595550081cf7e272e4b738829",
  privacy_export_artifact: "eae2b20c5e2859ae9f9afc975ffbb55b009365c414a364759a56e3538d8e4d19",
  privacy_export_artifact_deletion:
    "20dcfa98b853febb8d302c9ef1c78774513fc1f4272886c22549980d93cf28b9",
  privacy_export_artifact_tombstone:
    "695ef36bfcc732fdd4f925ed0b859bc7b8966bbc3d10e7a823ecd70d6e8e44dc",
  privacy_export_download_audit: "480233141169776277f33399f21f767946501b55a233a2437d7fb7002cabc1b7",
  privacy_export_job: "9bea83bbec14ef01bda061b9f953555c8076e58703ff6b6671f81e6af077809a",
  reauthentication_proof: "fc050bfe192672f98116e46a72870d07f73f18a10a62cf88506c70d7c25b75a8", // gitleaks:allow -- closed-schema fingerprint
  recipe: "55363e77d3ae4231ddaf207f13718bdddb0338b3b617b1fa52083f0e2bfbe77d",
  recipe_ingredient: "453bbc34ee6c08b60fa6eed9dda9d0ab075c7625994c7eb8ba98f863de983a65",
  recipe_operation: "e0e8b1c1b59fdaa4e3124de0dc0b7a05c53f8fb4e50467f524ef2913a11f473e",
  recipe_version: "a6790a343d2d1291b0dda5784d66cc9ce3bffa7a3c833e34ed88d3dd39626a84",
  recipe_version_nutrient: "9960997724392473495e475626327d6287144a4e5e78e9333dac649e7f0d0cdc",
  recipe_version_source: "8f1a37bdac653aeddf83c282ed5673885e05a1fdd94c7efe40d6a67763584dcc",
  reminder_consent: "6d57d6b2e37c4dcd806d4b28c6918622f62d429b8be425842d18ba805c4567f0",
  reminder_consent_version: "619f410220efa5d9f2f9061561123708d85730e285088325f2dd4edf3631735e",
  reminder_delivery_outbox: "ef7ad84f1bd2456a26373cc8d3c255b741c62c18f50a3862b454d9fc01481884",
  reminder_schedule: "834abc69851f8a15573b41a4cad3cae418f5ec2e2a238ff7fd0633589b2830a5",
  reminder_schedule_version: "62bad77e0d861a65f64d6627dbbbff24ca063247577a5f368d2a2580e4684d07",
  retention_operation: "5ca39f43cdc8d6280c59d46bdba3e2fe857417ec38bdb3b27eabae47633ded58",
  security_challenge: "48f0e0812859dfa1b603a26b2cb845639adf24ff2295cc8cb39d3fc5f646b421",
  user_data_watermark: "db87636afcf455e6bdda2ce6c39babc655531536ca820af95026e787fb0145f5",
  user_profile: "e8842c5c39855d0546c9571bfb589efda02013531c7ef30dd422884b9992056a",
  user_session: "2b2d5b0e243ebb9c0dc0bf3f18990f1b48d3cdf7b1fd8a5660a23cd032073fd2",
};

// Tables transitively owned by app_user must be either exported above or deliberately excluded
// here. This is separate from the per-table column fingerprint: a new user-linked table therefore
// fails closed even when nobody remembered to add it to EXPORT_ENTITY_SPECS.
const USER_LINKED_EXPORT_EXCLUSIONS = new Set([
  "account_erasure_job", // pseudonymous lifecycle/status capability; never in account export
  "account_erasure_receipt", // deliberately non-identifying post-erasure evidence
  "auth_action_token", // single-use credential and current-email digests
  "food_import_record", // public-source ingestion evidence; custom foods cannot reference it
  "privacy_export_entity_snapshot", // transient DB spool manifest
  "privacy_export_record", // transient canonical DB spool rows
  "privacy_export_upload_artifact", // transient object-key/upload fencing evidence
  "user_password_credential", // password verifier material
]);

type ErasureTableSpec =
  | {
      readonly table: string;
      readonly strategy: "delete";
      readonly subjectRows: (userId: string) => ReturnType<typeof sql>;
    }
  | {
      readonly table: string;
      readonly strategy: "cascade";
      readonly parentTable: string;
      readonly constraintName: string;
    }
  | {
      readonly table: string;
      readonly strategy: "empty" | "retain";
      readonly parentTable: string;
      readonly constraintName: string;
      readonly deleteAction: "n" | "r";
      readonly allColumnsNotNull: boolean;
    }
  | {
      readonly table: string;
      readonly strategy: "subject";
    };

function eraseBy(
  table: string,
  subjectRows: (userId: string) => ReturnType<typeof sql>,
): ErasureTableSpec {
  return { strategy: "delete", subjectRows, table };
}

function eraseByCascade(
  table: string,
  parentTable: string,
  constraintName: string,
): ErasureTableSpec {
  return { constraintName, parentTable, strategy: "cascade", table };
}

// One reviewed registry owns every transitive app_user-linked table. Explicit-delete entries
// carry the actual SQL used by eraseOwnedRows; cascade entries name one exact non-null FK path
// whose parent must itself be deleted. A nullable or merely unrelated CASCADE is never sufficient.
const ERASURE_TABLE_SPECS: readonly ErasureTableSpec[] = [
  eraseBy("audit_log", (userId) => sql`actor_user_id=${userId} or subject_user_id=${userId}`),
  eraseBy("privacy_export_job", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_delivery_outbox", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_import_batch", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_health_import_conflict", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_health_import", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_integration", (userId) => sql`user_id=${userId}`),
  eraseBy("biometric_event", (userId) => sql`user_id=${userId}`),
  eraseBy("biometric_definition", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_schedule", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_consent", (userId) => sql`user_id=${userId}`),
  eraseBy("security_challenge", (userId) => sql`user_id=${userId}`),
  eraseBy("reauthentication_proof", (userId) => sql`user_id=${userId}`),
  eraseBy("auth_action_token", (userId) => sql`user_id=${userId}`),
  eraseBy("device_registration", (userId) => sql`user_id=${userId}`),
  eraseBy("diary", (userId) => sql`user_id=${userId}`),
  eraseBy("recipe", (userId) => sql`owner_user_id=${userId}`),
  eraseBy("nutrition_goal", (userId) => sql`user_id=${userId}`),
  eraseBy("custom_food", (userId) => sql`user_id=${userId}`),
  eraseBy("food", (userId) => sql`owner_user_id=${userId}`),
  eraseBy("retention_operation", (userId) => sql`user_id=${userId}`),
  { strategy: "subject", table: "app_user" },
  {
    allColumnsNotNull: false,
    constraintName: "account_erasure_job_user_id_fkey",
    deleteAction: "n",
    parentTable: "app_user",
    strategy: "retain",
    table: "account_erasure_job",
  },
  {
    allColumnsNotNull: true,
    constraintName: "account_erasure_receipt_job_id_fkey",
    deleteAction: "r",
    parentTable: "account_erasure_job",
    strategy: "retain",
    table: "account_erasure_receipt",
  },
  {
    allColumnsNotNull: false,
    constraintName: "food_import_record_food_version_id_fkey",
    deleteAction: "r",
    parentTable: "food_version",
    strategy: "empty",
    table: "food_import_record",
  },
  eraseByCascade(
    "biometric_definition_operation",
    "biometric_definition",
    "biometric_definition_operation_definition_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_definition_version",
    "biometric_definition",
    "biometric_definition_version_definition_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_event_operation",
    "biometric_event",
    "biometric_event_operation_event_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_event_revision",
    "biometric_event",
    "biometric_event_revision_event_id_user_id_fkey",
  ),
  eraseByCascade(
    "custom_food_operation",
    "custom_food",
    "custom_food_operation_custom_food_id_user_id_fkey",
  ),
  eraseByCascade("custom_food_version", "custom_food", "custom_food_version_custom_food_id_fkey"),
  eraseByCascade(
    "custom_food_version_nutrient",
    "custom_food_version",
    "custom_food_version_nutrient_custom_food_id_food_version_i_fkey",
  ),
  eraseByCascade("diary_entry", "diary", "diary_entry_diary_id_user_id_fkey"),
  eraseByCascade(
    "diary_entry_nutrient_snapshot",
    "diary_entry",
    "diary_entry_nutrient_snapshot_diary_entry_id_fkey",
  ),
  eraseByCascade("diary_entry_revision", "diary_entry", "diary_entry_revision_diary_entry_id_fkey"),
  eraseByCascade(
    "diary_entry_revision_nutrient",
    "diary_entry_revision",
    "diary_entry_revision_nutrient_diary_entry_revision_id_fkey",
  ),
  eraseByCascade(
    "diary_entry_revision_source",
    "diary_entry_revision",
    "diary_entry_revision_source_diary_entry_revision_id_fkey",
  ),
  eraseByCascade("diary_operation", "diary_entry", "diary_operation_diary_entry_id_fkey"),
  eraseByCascade("food_barcode", "food", "food_barcode_food_id_fkey"),
  eraseByCascade("food_nutrient_value", "food_version", "food_nutrient_value_food_version_id_fkey"),
  eraseByCascade("food_serving", "food_version", "food_serving_food_version_id_fkey"),
  eraseByCascade("food_version", "food", "food_version_food_id_fkey"),
  eraseByCascade(
    "nutrition_goal_operation",
    "nutrition_goal",
    "nutrition_goal_operation_nutrition_goal_id_user_id_fkey",
  ),
  eraseByCascade(
    "nutrition_goal_target",
    "nutrition_goal_version",
    "nutrition_goal_target_nutrition_goal_version_id_fkey",
  ),
  eraseByCascade("nutrition_goal_version", "nutrition_goal", "nutrition_goal_version_user_fk"),
  eraseByCascade(
    "platform_health_import_revision",
    "platform_health_import",
    "platform_health_import_revision_import_id_user_id_fkey",
  ),
  eraseByCascade(
    "platform_integration_version",
    "platform_integration",
    "platform_integration_version_integration_id_user_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact",
    "privacy_export_job",
    "privacy_export_artifact_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact_deletion",
    "privacy_export_artifact",
    "privacy_export_artifact_deletion_artifact_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact_tombstone",
    "privacy_export_job",
    "privacy_export_artifact_tombstone_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_download_audit",
    "privacy_export_job",
    "privacy_export_download_audit_job_id_user_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_entity_snapshot",
    "privacy_export_job",
    "privacy_export_entity_snapshot_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_record",
    "privacy_export_job",
    "privacy_export_record_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_upload_artifact",
    "privacy_export_job",
    "privacy_export_upload_artifact_job_id_fkey",
  ),
  eraseByCascade("recipe_ingredient", "recipe_version", "recipe_ingredient_recipe_version_id_fkey"),
  eraseByCascade("recipe_operation", "recipe", "recipe_operation_recipe_id_user_id_fkey"),
  eraseByCascade("recipe_version", "recipe", "recipe_version_recipe_id_owner_user_id_fkey"),
  eraseByCascade(
    "recipe_version_nutrient",
    "recipe_version",
    "recipe_version_nutrient_recipe_version_id_fkey",
  ),
  eraseByCascade(
    "recipe_version_source",
    "recipe_version",
    "recipe_version_source_recipe_version_id_fkey",
  ),
  eraseByCascade(
    "reminder_consent_version",
    "reminder_consent",
    "reminder_consent_version_consent_id_user_id_fkey",
  ),
  eraseByCascade(
    "reminder_schedule_version",
    "reminder_schedule",
    "reminder_schedule_version_schedule_id_user_id_fkey",
  ),
  eraseByCascade("user_data_watermark", "app_user", "user_data_watermark_user_id_fkey"),
  eraseByCascade("user_password_credential", "app_user", "user_password_credential_user_id_fkey"),
  eraseByCascade("user_profile", "app_user", "user_profile_user_id_fkey"),
  eraseByCascade("user_session", "app_user", "user_session_user_id_fkey"),
];

function exportSpec(
  entity: PrivacyExportEntity,
  table: string,
  from: string,
  userColumn: string,
  entityId: string,
  revision: string,
  deleted: string,
  redacted?: readonly string[],
): PrivacyExportEntitySpec {
  return redacted
    ? { deleted, entity, entityId, from, redacted, revision, table, userColumn }
    : { deleted, entity, entityId, from, revision, table, userColumn };
}

interface DiarySemanticRow {
  readonly local_date: string;
  readonly nutrient_id: string;
  readonly known_amount: string;
  readonly contributor_count: string;
  readonly quantified_count: string;
  readonly trace_count: string;
  readonly unknown_count: string;
  readonly unknown_reasons: JsonObject;
}

async function computePrivacyExportSemanticEvidence(
  transaction: Transaction<Database>,
  userId: string,
): Promise<PrivacyExportSemanticEvidenceRecord> {
  const diaryHash = createHash("sha256");
  let groupCount = 0n;
  let lastDate: string | null = null;
  let lastNutrientId: string | null = null;
  for (;;) {
    const pageResult: QueryResult<DiarySemanticRow> = await sql<DiarySemanticRow>`
      with heads as (
        select revision.id, revision.local_date
        from diary_entry entry
        join diary_entry_revision revision on revision.id=entry.current_revision_id
        where entry.user_id=${userId}::uuid and revision.operation <> 'delete'
      ), totals as (
        select heads.local_date, nutrient.nutrient_id,
               sum(nutrient.known_amount) known_amount,
               sum(nutrient.contributor_count) contributor_count,
               sum(nutrient.quantified_count) quantified_count,
               sum(nutrient.trace_count) trace_count,
               sum(nutrient.unknown_count) unknown_count,
               jsonb_build_object(
                 'not_reported',sum(coalesce((nutrient.unknown_reasons->>'not_reported')::integer,0)),
                 'not_analyzed',sum(coalesce((nutrient.unknown_reasons->>'not_analyzed')::integer,0)),
                 'not_applicable',sum(coalesce((nutrient.unknown_reasons->>'not_applicable')::integer,0)),
                 'withheld',sum(coalesce((nutrient.unknown_reasons->>'withheld')::integer,0))
               ) unknown_reasons
        from heads
        join diary_entry_revision_nutrient nutrient on nutrient.diary_entry_revision_id=heads.id
        group by heads.local_date,nutrient.nutrient_id
      )
      select local_date::text, nutrient_id::text, known_amount::text,
             contributor_count::text, quantified_count::text, trace_count::text,
             unknown_count::text, unknown_reasons
      from totals
      where (${lastDate}::date is null or (local_date,nutrient_id) > (${lastDate}::date,${lastNutrientId}::bigint))
      order by local_date,nutrient_id
      limit 1000
    `.execute(transaction);
    if (!pageResult.rows.length) break;
    for (const row of pageResult.rows) {
      diaryHash.update(
        `${canonicalJson({
          contributorCount: canonicalExportCount(row.contributor_count, "contributorCount"),
          knownAmount: canonicalNonNegative(row.known_amount, "knownAmount"),
          localDate: row.local_date,
          nutrientId: canonicalPositiveId(row.nutrient_id),
          quantifiedCount: canonicalExportCount(row.quantified_count, "quantifiedCount"),
          traceCount: canonicalExportCount(row.trace_count, "traceCount"),
          unknownCount: canonicalExportCount(row.unknown_count, "unknownCount"),
          unknownReasons: cleanUnknownReasons(row.unknown_reasons),
        })}\n`,
      );
      groupCount += 1n;
    }
    const tail: DiarySemanticRow | undefined = pageResult.rows.at(-1);
    if (!tail) break;
    lastDate = tail.local_date;
    lastNutrientId = tail.nutrient_id;
  }
  const counts = await sql<{
    biometric_events: string;
    biometric_revisions: string;
    platform_imports: string;
    platform_revisions: string;
  }>`
    select
      (select count(*)::text from biometric_event where user_id=${userId}::uuid) biometric_events,
      (select count(*)::text from biometric_event_revision where user_id=${userId}::uuid) biometric_revisions,
      (select count(*)::text from platform_health_import where user_id=${userId}::uuid) platform_imports,
      (select count(*)::text from platform_health_import_revision where user_id=${userId}::uuid) platform_revisions
  `.execute(transaction);
  const count = counts.rows[0];
  if (!count) throw new RetentionExportNotReadyError();
  const facts = {
    biometricEventCount: canonicalExportCount(count.biometric_events, "biometricEventCount"),
    biometricRevisionCount: canonicalExportCount(
      count.biometric_revisions,
      "biometricRevisionCount",
    ),
    diaryDailyNutrientGroupCount: groupCount.toString(),
    diaryDailyTotalsSha256: diaryHash.digest("hex"),
    platformImportCount: canonicalExportCount(count.platform_imports, "platformImportCount"),
    platformImportRevisionCount: canonicalExportCount(
      count.platform_revisions,
      "platformImportRevisionCount",
    ),
    version: "retention-export-semantic-v1" as const,
  };
  return { ...facts, digest: sha256(canonicalJson(facts)) };
}

async function countPrivacyExportEntities(
  transaction: Transaction<Database>,
  userId: string,
  jobId: string,
  watermarkRevision: string,
): Promise<Omit<PrivacyExportEntitySnapshotRecord, "sourceRecordSetSha256">[]> {
  const records: Omit<PrivacyExportEntitySnapshotRecord, "sourceRecordSetSha256">[] = [];
  for (const spec of EXPORT_ENTITY_SPECS) {
    const excludeCurrent =
      spec.entity === "privacy_export_job" ? ` and t.id <> '${jobId}'::uuid` : "";
    const ownerPredicate =
      spec.entity === "audit_event"
        ? sql`(t.subject_user_id=${userId}::uuid or t.actor_user_id=${userId}::uuid)`
        : sql`${sql.raw(spec.userColumn)} = ${userId}::uuid`;
    const result = await sql<{
      count: string;
    }>`select count(*)::text count from ${sql.raw(spec.from)} where ${ownerPredicate} ${sql.raw(excludeCurrent)}`.execute(
      transaction,
    );
    records.push({
      entity: spec.entity,
      sourceCount: result.rows[0]?.count ?? "0",
      watermarkRevision,
    });
  }
  return records;
}

async function assertPrivacyExportSchemaClassified(
  transaction: Transaction<Database>,
): Promise<void> {
  const tables = [...new Set(EXPORT_ENTITY_SPECS.map((spec) => spec.table))].sort();
  if (
    tables.length !== Object.keys(EXPORT_TABLE_SCHEMA_SHA256).length ||
    tables.some((table) => !(table in EXPORT_TABLE_SCHEMA_SHA256))
  )
    throw new RetentionExportNotReadyError();
  const result = await sql<{ table_name: string; columns: string[] }>`
    select table_name,array_agg(column_name order by column_name)::text[] columns
    from information_schema.columns
    where table_schema=current_schema() and table_name = any(${sql.val(tables)}::text[])
    group by table_name
    order by table_name
  `.execute(transaction);
  if (result.rows.length !== tables.length) throw new RetentionExportNotReadyError();
  for (const row of result.rows) {
    const expected = EXPORT_TABLE_SCHEMA_SHA256[row.table_name];
    if (!expected || sha256(row.columns.join(",")) !== expected)
      throw new RetentionExportNotReadyError();
  }
  await assertUserLinkedTableInventory(transaction, () => new RetentionExportNotReadyError());
}

async function assertErasureSchemaClassified(transaction: Transaction<Database>): Promise<void> {
  const notReady = () => new Error("Account-erasure schema inventory is not current");
  const linked = await assertUserLinkedTableInventory(transaction, notReady);
  const policies = new Map(ERASURE_TABLE_SPECS.map((spec) => [spec.table, spec]));
  if (
    policies.size !== ERASURE_TABLE_SPECS.length ||
    policies.size !== linked.length ||
    linked.some((table) => !policies.has(table)) ||
    [...policies.keys()].some((table) => !linked.includes(table)) ||
    ERASURE_TABLE_SPECS.filter((spec) => spec.strategy === "subject").length !== 1 ||
    policies.get("app_user")?.strategy !== "subject"
  )
    throw notReady();

  const cascadePolicies = ERASURE_TABLE_SPECS.filter(
    (spec): spec is Extract<ErasureTableSpec, { strategy: "cascade" }> =>
      spec.strategy === "cascade",
  );
  const relationshipPolicies = ERASURE_TABLE_SPECS.filter(
    (spec): spec is Extract<ErasureTableSpec, { strategy: "cascade" | "empty" | "retain" }> =>
      spec.strategy === "cascade" || spec.strategy === "empty" || spec.strategy === "retain",
  );
  const constraints = await sql<{
    table_name: string;
    parent_table: string;
    constraint_name: string;
    delete_action: string;
    all_columns_not_null: boolean;
  }>`
    select child.relname table_name,
           parent.relname parent_table,
           edge.conname constraint_name,
           edge.confdeltype::text delete_action,
           not exists (
             select 1
             from unnest(edge.conkey) key(attnum)
             join pg_attribute attribute
               on attribute.attrelid=edge.conrelid and attribute.attnum=key.attnum
             where not attribute.attnotnull
           ) all_columns_not_null
    from pg_constraint edge
    join pg_class child on child.oid=edge.conrelid
    join pg_class parent on parent.oid=edge.confrelid
    where edge.contype='f'
      and child.relnamespace=current_schema()::regnamespace
      and edge.conname=any(${sql.val(relationshipPolicies.map((spec) => spec.constraintName))}::text[])
  `.execute(transaction);
  const byConstraint = new Map(
    constraints.rows.map((row) => [`${row.table_name}\u0000${row.constraint_name}`, row]),
  );
  if (
    byConstraint.size !== relationshipPolicies.length ||
    relationshipPolicies.some((spec) => {
      const constraint = byConstraint.get(`${spec.table}\u0000${spec.constraintName}`);
      const deleteAction = spec.strategy === "cascade" ? "c" : spec.deleteAction;
      const allColumnsNotNull = spec.strategy === "cascade" ? true : spec.allColumnsNotNull;
      return (
        !constraint ||
        constraint.parent_table !== spec.parentTable ||
        constraint.delete_action !== deleteAction ||
        constraint.all_columns_not_null !== allColumnsNotNull
      );
    })
  )
    throw notReady();

  const guaranteedDeleted = new Set(
    ERASURE_TABLE_SPECS.filter(
      (spec) => spec.strategy === "delete" || spec.strategy === "subject",
    ).map((spec) => spec.table),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const spec of cascadePolicies)
      if (!guaranteedDeleted.has(spec.table) && guaranteedDeleted.has(spec.parentTable)) {
        guaranteedDeleted.add(spec.table);
        changed = true;
      }
  }
  if (cascadePolicies.some((spec) => !guaranteedDeleted.has(spec.table))) throw notReady();
}

async function assertUserLinkedTableInventory(
  transaction: Transaction<Database>,
  notReady: () => Error,
): Promise<readonly string[]> {
  const linked = await sql<{ table_name: string }>`
    with recursive linked(oid) as (
      select 'app_user'::regclass::oid
      union
      select edge.conrelid
      from pg_constraint edge
      join linked parent on parent.oid=edge.confrelid
      where edge.contype='f'
    )
    select class.relname table_name
    from linked
    join pg_class class on class.oid=linked.oid
    where class.relnamespace=current_schema()::regnamespace and class.relkind='r'
    order by class.relname
  `.execute(transaction);
  const classified = new Set([
    ...EXPORT_ENTITY_SPECS.map((spec) => spec.table),
    ...USER_LINKED_EXPORT_EXCLUSIONS,
  ]);
  const discovered = new Set(linked.rows.map((row) => row.table_name));
  if (
    discovered.size !== classified.size ||
    [...discovered].some((table) => !classified.has(table)) ||
    [...classified].some((table) => !discovered.has(table))
  )
    throw notReady();
  const customIngestion = await sql<{ count: string }>`
    select count(*)::text count
    from food_import_record record
    join food_version version on version.id=record.food_version_id
    join food on food.id=version.food_id
    where food.owner_user_id is not null
  `.execute(transaction);
  if (customIngestion.rows[0]?.count !== "0") throw notReady();
  return linked.rows.map((row) => row.table_name);
}

async function pagePrivacyExportEntity(
  transaction: Transaction<Database>,
  input: {
    userId: string;
    jobId: string;
    entity: PrivacyExportEntity;
    cursor?: string | null;
    limit?: number;
    snapshot: Pick<PrivacyExportEntitySnapshotRecord, "sourceCount" | "watermarkRevision">;
    ordinalBase?: bigint;
  },
): Promise<PrivacyExportPage> {
  const spec = EXPORT_ENTITY_SPECS.find((candidate) => candidate.entity === input.entity);
  if (!spec) throw new RetentionValidationError("Unknown privacy export entity");
  const cursor = canonicalExportCursor(input.cursor, input.entity);
  const limit = boundedLimit(input.limit, 1_000);
  const sourceCount = BigInt(input.snapshot.sourceCount);
  if (cursor.seen > sourceCount)
    throw new RetentionValidationError("Export cursor is out of range");
  const redacted = spec.redacted ?? [];
  const excludeCurrent =
    spec.entity === "privacy_export_job" ? ` and t.id <> '${input.jobId}'::uuid` : "";
  const ownerPredicate =
    spec.entity === "audit_event"
      ? sql`(t.subject_user_id=${input.userId}::uuid or t.actor_user_id=${input.userId}::uuid)`
      : sql`${sql.raw(spec.userColumn)} = ${input.userId}::uuid`;
  const after = cursor.last ? sql`and (${sql.raw(spec.entityId)}) > ${cursor.last}` : sql``;
  const result = await sql<{
    entity_id: string;
    revision: string | null;
    deleted: boolean;
    payload: JsonObject;
  }>`
    select ${sql.raw(spec.entityId)} entity_id,
           max((${sql.raw(spec.revision)})::text) revision,
           bool_or((${sql.raw(spec.deleted)})::boolean) deleted,
           (jsonb_object_agg(
             fields.key,
             case
               when columns.data_type in ('smallint','integer','bigint','numeric','decimal','real','double precision')
                    and fields.value <> 'null'::jsonb
                 then to_jsonb(fields.value #>> '{}')
               else fields.value
             end order by fields.key
           ) - ${sql.val(redacted)}::text[]) payload
    from ${sql.raw(spec.from)}
    cross join lateral jsonb_each(to_jsonb(t)) fields
    join information_schema.columns columns
      on columns.table_schema = current_schema()
     and columns.table_name = ${spec.table}
     and columns.column_name = fields.key
    where ${ownerPredicate} ${sql.raw(excludeCurrent)} ${after}
    group by ${sql.raw(spec.entityId)}
    order by ${sql.raw(spec.entityId)}
    limit ${limit}
  `.execute(transaction);
  const base = input.ordinalBase ?? 0n;
  // Entity order is fixed; callers concatenate pages in the advertised registry order. The
  // ordinal remains deterministic within an entity and is never derived from JS floating point.
  const records = result.rows.map((row, index) => {
    const ordinal = base + cursor.seen + BigInt(index) + 1n;
    return {
      deleted: row.deleted,
      entityId: row.entity_id,
      entityType: input.entity,
      ordinal: ordinal.toString(),
      payload: row.payload,
      payloadSha256: sha256(canonicalJson(row.payload)),
      revision: row.revision,
      watermark: input.snapshot.watermarkRevision,
    } satisfies PrivacyExportRecord;
  });
  const nextSeen = cursor.seen + BigInt(records.length);
  if (records.length === 0 && nextSeen < sourceCount) throw new RetentionExportNotReadyError();
  const last = records.at(-1)?.entityId ?? cursor.last;
  return {
    entity: input.entity,
    entityWatermark: input.snapshot.watermarkRevision,
    nextCursor:
      nextSeen < sourceCount && last ? encodeExportCursor(input.entity, last, nextSeen) : null,
    records,
    sourceCount: input.snapshot.sourceCount,
  };
}

async function pageMaterializedPrivacyExportEntity(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly snapshot: PrivacyExportEntitySnapshotRecord;
    readonly entity: PrivacyExportEntity;
    readonly cursor?: string | null;
    readonly limit?: number;
  },
): Promise<PrivacyExportPage> {
  const cursor = canonicalExportCursor(input.cursor, input.entity);
  const limit = boundedLimit(input.limit, 1_000);
  const sourceCount = BigInt(input.snapshot.sourceCount);
  if (cursor.seen > sourceCount)
    throw new RetentionValidationError("Export cursor is out of range");
  const job = await database
    .selectFrom("privacy_export_job")
    .select("snapshot_id")
    .where("id", "=", input.jobId)
    .where("user_id", "=", input.userId)
    .where("status", "=", "running")
    .where("locked_by", "=", input.workerId)
    .executeTakeFirst();
  if (!job || job.snapshot_id !== input.snapshotId) throw new RetentionExportNotReadyError();
  let rowQuery = database
    .selectFrom("privacy_export_record")
    .selectAll()
    .where("job_id", "=", input.jobId)
    .where("entity_type", "=", input.entity)
    .orderBy("entity_id")
    .limit(limit);
  if (cursor.last) rowQuery = rowQuery.where("entity_id", ">", cursor.last);
  const rows = await rowQuery.execute();
  const records = rows.map(
    (row) =>
      ({
        deleted: row.deleted,
        entityId: row.entity_id,
        entityType: input.entity,
        ordinal: canonicalExportCount(row.ordinal, "ordinal"),
        payload: row.payload as JsonObject,
        payloadSha256: row.payload_sha256,
        revision: row.revision,
        watermark: canonicalExportCount(row.watermark_revision, "watermarkRevision"),
      }) satisfies PrivacyExportRecord,
  );
  const nextSeen = cursor.seen + BigInt(records.length);
  if (records.length === 0 && nextSeen < sourceCount) throw new RetentionExportNotReadyError();
  const last = records.at(-1)?.entityId ?? cursor.last;
  return {
    entity: input.entity,
    entityWatermark: input.snapshot.watermarkRevision,
    nextCursor:
      nextSeen < sourceCount && last ? encodeExportCursor(input.entity, last, nextSeen) : null,
    records,
    sourceCount: input.snapshot.sourceCount,
  };
}

function canonicalExportFormats(values: readonly string[]): ("csv" | "json")[] {
  const formats = [...new Set(values)];
  if (
    formats.length < 1 ||
    formats.length > 2 ||
    formats.some((format) => format !== "csv" && format !== "json")
  )
    throw new RetentionValidationError("requestedFormats must contain json and/or csv");
  return formats.sort() as ("csv" | "json")[];
}

function encodeExportCursor(entity: PrivacyExportEntity, last: string, seen: bigint): string {
  return Buffer.from(canonicalJson({ entity, last, seen: seen.toString() }), "utf8").toString(
    "base64url",
  );
}

function canonicalExportCursor(
  value: string | null | undefined,
  expectedEntity: PrivacyExportEntity,
): { readonly last: string | null; readonly seen: bigint } {
  if (value == null) return { last: null, seen: 0n };
  try {
    if (value.length < 8 || value.length > 4_000 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("object");
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "entity,last,seen" ||
      record.entity !== expectedEntity ||
      typeof record.last !== "string" ||
      record.last.length < 1 ||
      record.last.length > 2_000 ||
      typeof record.seen !== "string" ||
      !/^[1-9][0-9]*$/u.test(record.seen)
    )
      throw new Error("shape");
    return { last: record.last, seen: BigInt(record.seen) };
  } catch {
    throw new RetentionValidationError("Export cursor is invalid");
  }
}

function canonicalExportCount(value: bigint | number | string, field: string): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new RetentionValidationError(`${field} is invalid`);
  return text;
}

function validatePrivacyExportArtifacts(values: readonly PrivacyExportArtifactInput[]): readonly {
  format: "csv" | "json";
  objectKey: string;
  fileName: string;
  mediaType: "application/json" | "application/zip";
  plaintextBytes: string;
  plaintextSha256: string;
  ciphertextBytes: string;
  encryptionKeyId: string;
  expiresAt: string;
}[] {
  const seen = new Set<string>();
  const artifacts = values.map((value) => {
    if (seen.has(value.format)) throw new RetentionValidationError("Duplicate export artifact");
    seen.add(value.format);
    const expectedMedia = value.format === "json" ? "application/json" : "application/zip";
    if (value.mediaType !== expectedMedia)
      throw new RetentionValidationError("Export artifact media type is invalid");
    requireDigest(value.plaintextSha256, "plaintextSha256");
    return {
      ciphertextBytes: canonicalExportCount(value.ciphertextBytes, "ciphertextBytes"),
      encryptionKeyId: boundedText(value.encryptionKeyId, 500, "encryptionKeyId"),
      expiresAt: canonicalInstant(value.expiresAt),
      fileName: boundedText(value.fileName, 200, "fileName"),
      format: value.format,
      mediaType: value.mediaType,
      objectKey: boundedText(value.objectKey, 1_000, "objectKey"),
      plaintextBytes: canonicalExportCount(value.plaintextBytes, "plaintextBytes"),
      plaintextSha256: value.plaintextSha256,
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.expiresAt)).size > 1)
    throw new RetentionValidationError("Export artifacts must share one expiry");
  return artifacts;
}

async function loadExportEntitySnapshots(
  database: DbExecutor,
  jobId: string,
): Promise<PrivacyExportEntitySnapshotRecord[]> {
  const rows = await database
    .selectFrom("privacy_export_entity_snapshot")
    .selectAll()
    .where("job_id", "=", jobId)
    .orderBy("entity_type")
    .execute();
  return rows.map((row) => {
    if (!EXPORT_ENTITY_SPECS.some((spec) => spec.entity === row.entity_type))
      throw new RetentionExportNotReadyError();
    return {
      entity: row.entity_type as PrivacyExportEntity,
      sourceCount: row.source_count,
      sourceRecordSetSha256: row.source_record_set_sha256,
      watermarkRevision: row.watermark_revision,
    };
  });
}

function assertExportReconciliation(
  watermark: string,
  semanticDigest: string,
  snapshots: readonly PrivacyExportEntitySnapshotRecord[],
  reconciliation: PrivacyExportReconciliationInput,
): void {
  requireDigest(reconciliation.sourceSemanticDigest, "sourceSemanticDigest");
  requireDigest(reconciliation.exportedSemanticDigest, "exportedSemanticDigest");
  if (
    !reconciliation.reconciled ||
    reconciliation.snapshotWatermark !== watermark ||
    reconciliation.sourceSemanticDigest !== semanticDigest ||
    reconciliation.exportedSemanticDigest !== semanticDigest
  )
    throw new RetentionExportNotReadyError();
  if (reconciliation.entities.length !== snapshots.length) throw new RetentionExportNotReadyError();
  const supplied = new Map(reconciliation.entities.map((row) => [row.entity, row]));
  for (const snapshot of snapshots) {
    const row = supplied.get(snapshot.entity);
    if (row) {
      requireDigest(row.sourceRecordSetSha256, "sourceRecordSetSha256");
      requireDigest(row.exportedRecordSetSha256, "exportedRecordSetSha256");
    }
    if (
      !row ||
      canonicalExportCount(row.sourceCount, "sourceCount") !== snapshot.sourceCount ||
      canonicalExportCount(row.exportedCount, "exportedCount") !== snapshot.sourceCount ||
      canonicalExportCount(row.watermarkRevision, "watermarkRevision") !==
        snapshot.watermarkRevision ||
      row.sourceRecordSetSha256 !== snapshot.sourceRecordSetSha256 ||
      row.exportedRecordSetSha256 !== snapshot.sourceRecordSetSha256
    )
      throw new RetentionExportNotReadyError();
  }
}

async function executeErasure(
  database: Kysely<Database>,
  input: {
    jobId: string;
    workerId: string;
    completedAt: string;
    evidence: AccountErasureExecutionEvidence;
  },
): Promise<AccountErasureReceiptRecord> {
  const completedAt = canonicalInstant(input.completedAt);
  const restoreLedgerAcknowledgedAt = canonicalInstant(input.evidence.restoreLedgerAcknowledgedAt);
  requireDigest(input.evidence.restoreLedgerDigest, "restoreLedgerDigest");
  const restoreLedgerReference = boundedText(
    input.evidence.restoreLedgerReference,
    500,
    "restoreLedgerReference",
  );
  if (!Array.isArray(input.evidence.objectDeletionEvidence.artifacts))
    throw new RetentionValidationError("Object-deletion evidence is required");
  return database.transaction().execute(async (transaction) => {
    const job = await transaction
      .selectFrom("account_erasure_job")
      .selectAll()
      .where("id", "=", input.jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", input.workerId)
      .forUpdate()
      .executeTakeFirst();
    if (!job?.user_id) throw new RetentionNotFoundError();
    const userId = job.user_id;
    await lockAllUserWriters(transaction, userId);
    await sql`select set_config('nutrition_tracker.account_erasure','on',true)`.execute(
      transaction,
    );
    await transaction
      .selectFrom("app_user")
      .select("id")
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await assertErasureSchemaClassified(transaction);
    const completedArtifacts = await transaction
      .selectFrom("privacy_export_artifact as artifact")
      .innerJoin("privacy_export_job as export", "export.id", "artifact.job_id")
      .select(["artifact.id", "artifact.object_key"])
      .where("export.user_id", "=", userId)
      .orderBy("artifact.id")
      .execute();
    const stagedArtifacts = await transaction
      .selectFrom("privacy_export_upload_artifact as artifact")
      .innerJoin("privacy_export_job as export", "export.id", "artifact.job_id")
      .select(["artifact.id", "artifact.object_key", "artifact.status"])
      .where("export.user_id", "=", userId)
      .where("artifact.status", "!=", "promoted")
      .orderBy("artifact.id")
      .execute();
    if (stagedArtifacts.some((artifact) => artifact.status !== "deleted"))
      throw new RetentionValidationError("Staged export objects have not been deleted");
    // Cancelled staging keys carry their own verified deletion digest. They remain fail-closed
    // evidence but are not required again in the worker-supplied completed-artifact set.
    const storedArtifacts = completedArtifacts;
    const suppliedArtifacts = new Map(
      input.evidence.objectDeletionEvidence.artifacts.map((artifact) => {
        requireDigest(artifact.deletionEvidenceDigest, "deletionEvidenceDigest");
        return [
          artifact.artifactId,
          {
            objectKey: boundedText(artifact.objectKey, 1_000, "objectKey"),
          },
        ] as const;
      }),
    );
    if (
      suppliedArtifacts.size !== input.evidence.objectDeletionEvidence.artifacts.length ||
      suppliedArtifacts.size !== storedArtifacts.length ||
      storedArtifacts.some(
        (artifact) => suppliedArtifacts.get(artifact.id)?.objectKey !== artifact.object_key,
      )
    )
      throw new RetentionValidationError(
        "Object-deletion evidence does not reconcile to every export artifact",
      );
    // The external erasure ledger is the durable restore-replay authority. Its locator and the
    // object-deletion evidence are deliberately validated but never retained in the application
    // database, where either could re-identify a completed subject after a backup restore.
    if (restoreLedgerAcknowledgedAt > completedAt)
      throw new RetentionValidationError("Erasure evidence is acknowledged after completion");
    void restoreLedgerReference;
    const counts = await eraseOwnedRows(transaction, userId);
    const receiptId = randomUUID();
    const result = await transaction
      .deleteFrom("app_user")
      .where("id", "=", userId)
      .executeTakeFirst();
    counts.app_user = String(result.numDeletedRows ?? 0n);
    if (counts.app_user !== "1") throw new RetentionNotFoundError();
    const reconciliation = await reconcileErasedRows(transaction, userId, [], true);
    if (!reconciliation.reconciled)
      throw new RetentionValidationError("Account erasure did not reconcile to zero live rows");
    const backupCaveat =
      "Encrypted backups expire under the documented retention schedule; restored backups must replay the acknowledged external erasure ledger before serving data.";
    await transaction
      .insertInto("account_erasure_receipt")
      .values({
        backup_caveat: backupCaveat,
        completed_at: completedAt,
        deleted_counts: counts,
        id: receiptId,
        job_id: job.id,
        policy_version: "complete-account-erasure-v1",
      })
      .execute();
    await transaction
      .updateTable("account_erasure_job")
      .set({
        completed_at: completedAt,
        client_operation_id: null,
        last_error_code: null,
        locked_at: null,
        locked_by: null,
        object_deletion_evidence: null,
        request_digest: null,
        recovery_session_token_hash: null,
        restore_ledger_acknowledged_at: null,
        restore_ledger_digest: null,
        restore_ledger_reference: null,
        restore_locator: null,
        status: "completed",
      })
      .where("id", "=", job.id)
      .execute();
    return {
      backupCaveat,
      completedAt,
      id: receiptId,
      jobId: job.id,
      deletedCounts: counts,
      policyVersion: "complete-account-erasure-v1",
    };
  });
}

async function eraseOwnedRows(
  transaction: Transaction<Database>,
  userId: string,
): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  await sql`
    create temporary table erasure_retention_target_v3 (
      id uuid primary key
    ) on commit drop
  `.execute(transaction);
  await sql`
    insert into erasure_retention_target_v3(id)
    select id from account_erasure_job where user_id=${userId}
    union select id from privacy_export_job where user_id=${userId}
    union select artifact.id
      from privacy_export_upload_artifact artifact
      join privacy_export_job job on job.id=artifact.job_id
      where job.user_id=${userId}
    union select artifact.id
      from privacy_export_artifact artifact
      join privacy_export_job job on job.id=artifact.job_id
      where job.user_id=${userId}
  `.execute(transaction);
  const retentionEvidenceStatements: readonly (readonly [string, ReturnType<typeof sql>])[] = [
    [
      "retention_dead_letter_event",
      sql`delete from retention_dead_letter_event where target_id in (select id from erasure_retention_target_v3)`,
    ],
    [
      "retention_job_recovery_audit",
      sql`delete from retention_job_recovery_audit where target_id in (select id from erasure_retention_target_v3)`,
    ],
  ];
  const statements: readonly (readonly [string, ReturnType<typeof sql>])[] = [
    ...retentionEvidenceStatements,
    ...ERASURE_TABLE_SPECS.filter(
      (spec): spec is Extract<ErasureTableSpec, { strategy: "delete" }> =>
        spec.strategy === "delete",
    ).map(
      (spec) =>
        [
          spec.table,
          sql`delete from ${sql.table(spec.table)} where ${spec.subjectRows(userId)}`,
        ] as const,
    ),
  ];
  for (const [entity, statement] of statements) {
    const result = await statement.execute(transaction);
    counts[entity] = String(result.numAffectedRows ?? 0n);
  }
  return counts;
}

async function reconcileErasedRows(
  database: DbExecutor,
  userId: string,
  subjectErasureJobIds: readonly string[] = [],
  reconcileRetentionTargets = false,
): Promise<AccountErasureReconciliationRecord> {
  const remainingRows: Record<string, string> = {};
  for (const spec of EXPORT_ENTITY_SPECS) {
    const result = await sql<{
      count: string;
    }>`select count(*)::text count from ${sql.raw(spec.from)} where ${sql.raw(spec.userColumn)} = ${userId}::uuid`.execute(
      database,
    );
    remainingRows[spec.entity] = result.rows[0]?.count ?? "0";
  }
  for (const [entity, query] of [
    [
      "password_credential",
      sql<{
        count: string;
      }>`select count(*)::text count from user_password_credential where user_id=${userId}`,
    ],
    [
      "account_erasure_job_subject",
      sql<{
        count: string;
      }>`select count(*)::text count from account_erasure_job where user_id=${userId}`,
    ],
    [
      "account_erasure_job_subject_metadata",
      sql<{
        count: string;
      }>`select count(*)::text count from account_erasure_job
         where id = any(${sql.val(subjectErasureJobIds)}::uuid[]) and (
           user_id is not null or client_operation_id is not null or request_digest is not null or
           recovery_session_token_hash is not null or restore_locator is not null or
           restore_ledger_reference is not null or restore_ledger_digest is not null or
           object_deletion_evidence is not null
         )`,
    ],
  ] as const) {
    const result = await query.execute(database);
    remainingRows[entity] = result.rows[0]?.count ?? "0";
  }
  if (reconcileRetentionTargets) {
    for (const entity of ["retention_dead_letter_event", "retention_job_recovery_audit"] as const) {
      const result = await sql<{ count: string }>`
        select count(*)::text count from ${sql.table(entity)}
        where target_id in (select id from erasure_retention_target_v3)
      `.execute(database);
      remainingRows[entity] = result.rows[0]?.count ?? "0";
    }
  }
  for (const spec of ERASURE_TABLE_SPECS.filter(
    (candidate): candidate is Extract<ErasureTableSpec, { strategy: "delete" }> =>
      candidate.strategy === "delete",
  )) {
    const result = await sql<{ count: string }>`
      select count(*)::text count
      from ${sql.table(spec.table)}
      where ${spec.subjectRows(userId)}
    `.execute(database);
    remainingRows[`erasure_policy:${spec.table}`] = result.rows[0]?.count ?? "0";
  }
  return {
    reconciled: Object.values(remainingRows).every((count) => count === "0"),
    remainingRows,
    userId,
  };
}

async function readFeatureReplay<T>(
  transaction: Transaction<Database>,
  input: RetentionOperationInput,
  feature:
    | "biometric"
    | "consent"
    | "custom_food"
    | "device"
    | "erasure"
    | "export"
    | "import"
    | "integration"
    | "reauth"
    | "reminder",
  operation: string,
): Promise<T | null> {
  const row = await transaction
    .selectFrom("retention_operation")
    .select(["request_digest", "feature", "operation", "result_payload"])
    .where("user_id", "=", input.userId)
    .where("client_operation_id", "=", input.clientOperationId)
    .executeTakeFirst();
  if (!row) return null;
  if (
    row.request_digest !== input.requestDigest ||
    row.feature !== feature ||
    row.operation !== operation
  )
    throw new RetentionIdempotencyConflictError();
  return row.result_payload as unknown as T;
}
async function recordFeatureOperation(
  transaction: Transaction<Database>,
  input: RetentionOperationInput,
  feature:
    | "biometric"
    | "consent"
    | "custom_food"
    | "device"
    | "erasure"
    | "export"
    | "import"
    | "integration"
    | "reauth"
    | "reminder",
  operation: string,
  entityId: string,
  result: unknown,
): Promise<void> {
  await transaction
    .insertInto("retention_operation")
    .values({
      client_operation_id: input.clientOperationId,
      entity_id: entityId,
      feature,
      operation,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}
function mapDevice(row: Selectable<Database["device_registration"]>): DeviceRegistrationRecord {
  return {
    attestationMetadata: row.attestation_metadata,
    attestationStatus: row.attestation_status,
    createdAt: row.created_at.toISOString(),
    displayName: row.display_name,
    id: row.id,
    keyAlgorithm: row.key_algorithm,
    keyFingerprint: row.key_fingerprint,
    platform: row.platform,
    publicKeySpkiBase64: row.public_key_spki_base64,
    revision: row.revision,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    status: row.revoked_at ? "revoked" : "active",
    updatedAt: row.updated_at.toISOString(),
  };
}
function mapChallenge(row: Selectable<Database["security_challenge"]>): DeviceChallengeRecord {
  return {
    consumedAt: row.consumed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    deviceId: row.device_id,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    platform: row.platform,
    purpose: row.purpose,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
function mapStagedPrivacyExportArtifact(
  row: Selectable<Database["privacy_export_upload_artifact"]>,
): StagedPrivacyExportArtifactRecord {
  return {
    format: row.format === "csv_zip" ? "csv" : "json",
    id: row.id,
    jobId: row.job_id,
    objectKey: row.object_key,
    snapshotId: row.snapshot_id,
    status: row.status,
  };
}
function mapReauthenticationProof(
  row: Selectable<Database["reauthentication_proof"]>,
): ReauthenticationProofRecord {
  return {
    consumedAt: row.consumed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    purpose: row.purpose,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
async function loadExportJobRecord(
  database: DbExecutor,
  row: Selectable<Database["privacy_export_job"]>,
): Promise<PrivacyExportJobRecord> {
  if (row.failure_code !== null && row.failure_code !== "EXPORT_FAILED")
    throw new RetentionExportNotReadyError();
  const artifacts = await database
    .selectFrom("privacy_export_artifact")
    .selectAll()
    .where("job_id", "=", row.id)
    .orderBy("format")
    .execute();
  return {
    artifacts: artifacts.map((artifact) => ({
      ciphertextBytes: artifact.ciphertext_bytes,
      encryptionKeyId: artifact.encryption_key_id,
      expiresAt: artifact.expires_at.toISOString(),
      fileName: artifact.file_name,
      format: artifact.format === "csv_zip" ? "csv" : "json",
      id: artifact.id,
      mediaType: artifact.media_type,
      objectKey: artifact.object_key,
      plaintextBytes: artifact.plaintext_bytes,
      plaintextSha256: artifact.plaintext_sha256,
    })),
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    entityCount: row.entity_count,
    expiresAt: row.expires_at?.toISOString() ?? null,
    failureCode: row.failure_code,
    id: row.id,
    manifestDigest: row.manifest_digest,
    reconciliation: row.reconciliation,
    requestedFormats: canonicalExportFormats(row.requested_formats),
    snapshotId: row.snapshot_id,
    startedAt: row.started_at?.toISOString() ?? null,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
    userId: row.user_id,
    watermarkRevision: row.watermark_revision,
  };
}
function mapErasureJob(row: Selectable<Database["account_erasure_job"]>): AccountErasureJobRecord {
  return {
    completedAt: row.completed_at?.toISOString() ?? null,
    executeAfter: row.execute_after.toISOString(),
    id: row.id,
    lastErrorCode: row.last_error_code,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    status: row.status,
    statusCapabilityExpiresAt: row.status_capability_expires_at.toISOString(),
  };
}
function encodeRetentionCursor(
  kind: "biometric_event" | "custom_food",
  binding: string,
  time: string,
  id: string,
): string {
  return Buffer.from(canonicalJson({ binding, id, kind, time }), "utf8").toString("base64url");
}
function decodeRetentionCursor(
  value: string | null | undefined,
  expectedKind: "biometric_event" | "custom_food",
  expectedBinding: string,
): { readonly time: string; readonly id: string } | null {
  if (value == null) return null;
  try {
    if (value.length < 8 || value.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("cursor encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("cursor object");
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "binding,id,kind,time" ||
      record.kind !== expectedKind ||
      record.binding !== expectedBinding ||
      typeof record.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        record.id,
      ) ||
      typeof record.time !== "string" ||
      !/^(?:[0-9]{4})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(
        record.time,
      ) ||
      record.time.startsWith("0000-")
    )
      throw new Error("cursor fields");
    // PostgreSQL keyset cursors retain six fractional digits. The public RFC3339 validator
    // canonicalizes to milliseconds, so validate the same instant without discarding the
    // original microsecond tie-breaker used by the database comparison.
    canonicalInstant(record.time.replace(/\.(\d{3})\d{3}Z$/u, ".$1Z"));
    return { id: record.id, time: record.time };
  } catch {
    throw new RetentionValidationError("Cursor is invalid");
  }
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RetentionValidationError("JSON number is not finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    )
      throw new RetentionValidationError("JSON array is sparse or noncanonical");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") throw new RetentionValidationError("Value is not canonical JSON");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new RetentionValidationError("JSON object must be a plain record");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0) as number);
  const rightPoints = [...right].map((value) => value.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
