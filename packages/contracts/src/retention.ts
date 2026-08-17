import type {
  DiaryMealSlot,
  DiaryMutationResponse,
  DiaryNutrientAggregate,
  DiaryPortion,
} from "./diary.js";
import {
  diaryMutationResponseSchema,
  diaryNutrientAggregateSchema,
  diaryPortionSchema,
} from "./diary.js";

export const healthPlatforms = ["apple_healthkit", "android_health_connect"] as const;
export const biometricSourceKinds = ["manual", ...healthPlatforms] as const;
export const exportFormats = ["json", "csv"] as const;
export const jobStatuses = ["queued", "running", "completed", "failed"] as const;
export const GENERIC_REMINDER_LOCK_SCREEN_TEXT = "Time to check in." as const;
export const GENERIC_REMINDER_TITLE = "Nutrition Tracker" as const;
export const REMINDER_CONSENT_POLICY_VERSION = "local-reminders-v1" as const;

export type HealthPlatform = (typeof healthPlatforms)[number];
export type BiometricSourceKind = (typeof biometricSourceKinds)[number];
export type ExportFormat = (typeof exportFormats)[number];
export type RetentionJobStatus = (typeof jobStatuses)[number];

export interface NutrientTrendPoint {
  readonly localDate: string;
  /** Exact UTC bounds for this local day; they may span 23, 24, or 25 hours. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly aggregate: DiaryNutrientAggregate | null;
}

export interface NutrientTrendResponse {
  readonly data: {
    readonly nutrient: {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly unit: string;
    };
    readonly timeZone: string;
    readonly from: string;
    readonly to: string;
    readonly bucket: "day";
    readonly watermarkRevision: string;
    readonly points: readonly NutrientTrendPoint[];
  };
}

export interface BiometricTrendPoint {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly count: number;
  readonly first: string;
  readonly last: string;
  readonly minimum: string;
  readonly maximum: string;
}

export interface BiometricTrendResponse {
  readonly data: {
    readonly definition: BiometricDefinition;
    readonly timeZone: string;
    readonly from: string;
    readonly to: string;
    readonly bucket: "day";
    readonly points: readonly BiometricTrendPoint[];
  };
}

export interface RepeatDiaryEntryRequest {
  readonly occurredAt: string;
  readonly mealSlot?: DiaryMealSlot;
  readonly position?: number;
}

export type RepeatDiaryEntryResponse = DiaryMutationResponse;

export type CustomFoodNutrientDraft =
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
      readonly reason: "not_reported" | "not_analyzed" | "not_applicable" | "withheld";
    };

export interface CustomFoodDraftRequest {
  readonly name: string;
  readonly brandName: string | null;
  readonly serving: {
    readonly label: string;
    readonly grams: string;
  } | null;
  readonly nutrients: readonly CustomFoodNutrientDraft[];
  readonly notes: string | null;
}

export interface CustomFoodVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly brandName: string | null;
  readonly notes: string | null;
  readonly serving: { readonly id: string; readonly label: string; readonly grams: string } | null;
  readonly nutrients: readonly CustomFoodNutrientSnapshot[];
  readonly provenance: { readonly kind: "user_entered"; readonly statement: string };
  readonly createdAt: string;
}

export type CustomFoodNutrientSnapshot =
  | {
      readonly nutrient: {
        readonly id: string;
        readonly code: string;
        readonly name: string;
        readonly unit: string;
      };
      readonly state: "quantified";
      readonly amountPer100Grams: string;
    }
  | {
      readonly nutrient: {
        readonly id: string;
        readonly code: string;
        readonly name: string;
        readonly unit: string;
      };
      readonly state: "trace";
      readonly amountPer100Grams: null;
    }
  | {
      readonly nutrient: {
        readonly id: string;
        readonly code: string;
        readonly name: string;
        readonly unit: string;
      };
      readonly state: "unknown";
      readonly amountPer100Grams: null;
      readonly reason: "not_reported" | "not_analyzed" | "not_applicable" | "withheld";
    };

export interface CustomFood {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly revision: string;
  readonly currentVersion: CustomFoodVersion;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomFoodResponse {
  readonly data: { readonly customFood: CustomFood };
}

export interface CustomFoodListResponse {
  readonly data: readonly CustomFood[];
  readonly page: { readonly nextCursor: string | null };
}

export interface CustomFoodMutationResponse {
  readonly data: { readonly replayed: boolean; readonly customFood: CustomFood };
}

export interface CreateCustomFoodDiaryEntryRequest {
  readonly customFoodVersionId: string;
  readonly portion: DiaryPortion;
  readonly mealSlot: DiaryMealSlot;
  readonly occurredAt: string;
  readonly position?: number;
}

export interface BiometricDefinitionDraftRequest {
  readonly name: string;
  readonly dimension: "mass" | "length" | "temperature" | "duration" | "count" | "other";
  readonly canonicalUnit: string;
  readonly notes: string | null;
}

export interface BiometricDefinitionRevisionRequest {
  readonly name: string;
  readonly notes: string | null;
}

export interface BiometricDefinition {
  readonly id: string;
  readonly revision: string;
  readonly status: "active" | "archived";
  readonly name: string;
  readonly dimension: "mass" | "length" | "temperature" | "duration" | "count" | "other";
  readonly canonicalUnit: string;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BiometricDefinitionResponse {
  readonly data: { readonly definition: BiometricDefinition };
}

export interface BiometricDefinitionListResponse {
  readonly data: readonly BiometricDefinition[];
}

export interface BiometricDefinitionMutationResponse {
  readonly data: { readonly replayed: boolean; readonly definition: BiometricDefinition };
}

export interface BiometricEventDraftRequest {
  readonly definitionId: string;
  readonly measuredAt: string;
  readonly value: string;
}

export interface BiometricEventRevisionRequest {
  readonly value: string;
  readonly measuredAt?: string;
}

export interface BiometricEvent {
  readonly id: string;
  readonly revision: string;
  readonly definitionId: string;
  readonly measuredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly value: string;
  readonly source: {
    readonly kind: BiometricSourceKind;
    readonly deviceId: string | null;
    readonly externalId: string | null;
    readonly externalRevision: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BiometricEventResponse {
  readonly data: { readonly event: BiometricEvent };
}

export interface BiometricEventListResponse {
  readonly data: readonly BiometricEvent[];
  readonly page: { readonly nextCursor: string | null };
}

export interface BiometricEventMutationResponse {
  readonly data: { readonly replayed: boolean; readonly event: BiometricEvent | null };
}

export interface ReminderDraftRequest {
  readonly label: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly timeZone: string;
  readonly channel: "local";
  readonly consentGranted: true;
}

export interface ReminderRevisionRequest {
  readonly label: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly timeZone: string;
  readonly status: "active" | "paused";
}

export interface Reminder {
  readonly id: string;
  readonly revision: string;
  readonly status: "active" | "paused" | "revoked";
  readonly label: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly timeZone: string;
  readonly channel: "local";
  readonly consent: {
    readonly policyVersion: typeof REMINDER_CONSENT_POLICY_VERSION;
    readonly grantedAt: string;
    readonly revokedAt: string | null;
  };
  readonly deliveryPolicy: {
    readonly title: typeof GENERIC_REMINDER_TITLE;
    readonly lockScreenText: typeof GENERIC_REMINDER_LOCK_SCREEN_TEXT;
    readonly includesHealthDetails: false;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReminderResponse {
  readonly data: { readonly reminder: Reminder };
}
export interface ReminderListResponse {
  readonly data: readonly Reminder[];
}
export interface ReminderMutationResponse {
  readonly data: { readonly replayed: boolean; readonly reminder: Reminder };
}

export interface DeviceChallengeRequest {
  readonly platform: HealthPlatform;
}
export interface DeviceChallengeResponse {
  readonly data: {
    readonly id: string;
    readonly challenge: string;
    readonly platform: HealthPlatform;
    readonly expiresAt: string;
  };
}

export interface RegisterHealthDeviceRequest {
  readonly challengeId: string;
  readonly challenge: string;
  readonly platform: HealthPlatform;
  readonly displayName: string;
  readonly publicKey: {
    readonly format: "spki";
    readonly algorithm: "ES256";
    /** Padded standard-base64 X.509 SubjectPublicKeyInfo DER. */
    readonly derBase64: string;
  };
  /** Proof of possession over the issued challenge and the canonical public key. */
  readonly challengeSignature: string;
  /** Optional platform evidence; never treated as verified merely because it is present. */
  readonly attestation: string | null;
}

export interface HealthDevice {
  readonly id: string;
  readonly revision: string;
  readonly platform: HealthPlatform;
  readonly displayName: string;
  readonly keyFingerprint: string;
  readonly status: "active" | "revoked";
  readonly attestationStatus: "not_provided" | "unverified" | "verified";
  readonly registeredAt: string;
  readonly revokedAt: string | null;
}

export interface HealthDeviceResponse {
  readonly data: { readonly replayed: boolean; readonly device: HealthDevice };
}

export type HealthImportRecord =
  | {
      readonly operation: "upsert";
      readonly externalId: string;
      readonly externalRevision: string;
      readonly definitionCode: string;
      readonly measuredAt: string;
      readonly recordedTimeZone: string;
      readonly value: string;
      readonly unit: string;
    }
  | {
      readonly operation: "delete";
      readonly externalId: string;
      readonly externalRevision: string;
    };

export interface HealthImportBatchRequest {
  readonly deviceId: string;
  readonly batchId: string;
  readonly platform: HealthPlatform;
  /** Signed server-issued cursor generation; changes on every consent/rebind/reconnect. */
  readonly cursorEpoch: string;
  /** Last server-accepted provider anchor digest; null only for the first batch in this epoch. */
  readonly sourceCursor: string | null;
  /** Provider anchor digest after this batch, advanced atomically with its records. */
  readonly nextSourceCursor: string;
  readonly records: readonly HealthImportRecord[];
}

export interface HealthImportBatchResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly accepted: number;
    readonly deleted: number;
    /** Provider source IDs already present at the same revision; accepted as exact no-ops. */
    readonly duplicates: number;
    readonly conflicts: readonly {
      readonly externalId: string;
      readonly submittedRevision: string;
      readonly currentRevision: string;
      readonly code: "STALE_SOURCE_REVISION" | "SOURCE_ID_REUSED";
    }[];
  };
}

export interface PlatformConsentRequest {
  readonly platform: HealthPlatform;
  readonly dataTypeCodes: readonly ["body_weight"];
  readonly consentGranted: true;
}

export interface PlatformIntegration {
  readonly platform: HealthPlatform;
  /** Active device whose key is authorized for the current signed cursor epoch. */
  readonly deviceId: string;
  /** Positive signed-bigint generation that every import envelope must sign exactly. */
  readonly cursorEpoch: string;
  readonly revision: string;
  readonly status: "connected" | "disconnected";
  readonly dataTypeCodes: readonly ["body_weight"];
  readonly consentGrantedAt: string;
  readonly disconnectedAt: string | null;
  readonly lastImportAt: string | null;
  /** Last accepted provider cursor in this epoch; null immediately after consent/rebind. */
  readonly currentSourceCursor: string | null;
  readonly consentHistory: readonly {
    readonly id: string;
    readonly dataTypeCodes: readonly ["body_weight"];
    readonly status: "granted" | "revoked";
    readonly recordedAt: string;
  }[];
}

export interface PlatformIntegrationResponse {
  readonly data: { readonly replayed: boolean; readonly integration: PlatformIntegration };
}

export interface PlatformIntegrationListResponse {
  readonly data: readonly PlatformIntegration[];
}
export interface DisconnectPlatformIntegrationRequest {
  readonly importedDataDisposition: "retain" | "delete";
}

export interface RebindPlatformIntegrationRequest {
  /** A registered, active device on the same platform. */
  readonly deviceId: string;
}

export interface AccountExportRequest {
  readonly formats: readonly ExportFormat[];
}

export interface ExportArtifact {
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly byteLength: string;
  readonly sha256: string;
  /** Authenticated same-origin API path; never contains a bearer secret. */
  readonly downloadPath: string;
  /** CSV is a deterministic ZIP with one-or-more ordered RFC 4180 chunks per entity plus logical and delivery manifests. */
  readonly mediaType: "application/json" | "application/zip";
  readonly expiresAt: string;
}

export interface AccountExportJob {
  readonly id: string;
  readonly status: RetentionJobStatus;
  readonly formats: readonly ExportFormat[];
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly artifacts: readonly ExportArtifact[];
  readonly manifestSha256: string | null;
  readonly reconciliation: {
    readonly snapshotWatermark: string;
    readonly entities: readonly {
      readonly entity: string;
      readonly sourceCount: number;
      readonly exportedCount: number;
      readonly watermark: string;
    }[];
    readonly reconciled: boolean;
  } | null;
  readonly failureCode: "EXPORT_FAILED" | null;
}

export interface AccountExportResponse {
  readonly data: { readonly replayed: boolean; readonly export: AccountExportJob };
}

export interface AccountErasureRequest {
  readonly confirmation: "DELETE_MY_ACCOUNT";
}

export interface AccountErasureJob {
  readonly id: string;
  readonly status: RetentionJobStatus;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly executeAfter: string;
  readonly recentAuthenticationSatisfied: true;
  readonly consequences: readonly [
    "ACCOUNT_ACCESS_REVOKED",
    "PRIVATE_HEALTH_DATA_DELETED",
    "EXPORT_LINKS_REVOKED",
  ];
  readonly failureCode: "ERASURE_FAILED" | null;
}

export interface AccountErasureResponse {
  readonly data: { readonly replayed: boolean; readonly erasure: AccountErasureJob };
}

/** Returned only when erasure is requested; grants lifecycle-status access and nothing else. */
export interface AccountErasureMutationResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly erasure: AccountErasureJob;
    readonly statusCapability: {
      readonly token: string;
      readonly expiresAt: string;
    };
  };
}

export function assertAccountExportLifecycle(job: AccountExportJob): void {
  const emptyArtifacts = job.artifacts.length === 0;
  if (job.status === "queued") {
    if (
      job.startedAt !== null ||
      job.completedAt !== null ||
      job.expiresAt !== null ||
      !emptyArtifacts ||
      job.manifestSha256 !== null ||
      job.reconciliation !== null ||
      job.failureCode !== null
    )
      throw new TypeError("Queued export lifecycle is inconsistent");
    return;
  }
  if (job.status === "running") {
    if (
      job.startedAt === null ||
      job.completedAt !== null ||
      job.expiresAt !== null ||
      !emptyArtifacts ||
      job.manifestSha256 !== null ||
      job.reconciliation !== null ||
      job.failureCode !== null
    )
      throw new TypeError("Running export lifecycle is inconsistent");
    return;
  }
  if (job.status === "failed") {
    if (
      job.completedAt !== null ||
      job.expiresAt !== null ||
      !emptyArtifacts ||
      job.manifestSha256 !== null ||
      job.reconciliation !== null ||
      job.failureCode !== "EXPORT_FAILED"
    )
      throw new TypeError("Failed export lifecycle is inconsistent");
    return;
  }
  const formats = new Set(job.artifacts.map((artifact) => artifact.format));
  if (
    job.startedAt === null ||
    job.completedAt === null ||
    job.expiresAt === null ||
    job.manifestSha256 === null ||
    job.reconciliation === null ||
    !job.reconciliation.reconciled ||
    job.failureCode !== null ||
    job.artifacts.length !== job.formats.length ||
    formats.size !== job.formats.length ||
    job.formats.some((format) => !formats.has(format)) ||
    job.artifacts.some(
      (artifact) =>
        artifact.mediaType !==
        (artifact.format === "json" ? "application/json" : "application/zip"),
    ) ||
    job.reconciliation.entities.some((entity) => entity.sourceCount !== entity.exportedCount)
  )
    throw new TypeError("Completed export lifecycle is inconsistent");
}

export function assertAccountErasureLifecycle(job: AccountErasureJob): void {
  if (job.status === "queued") {
    if (job.startedAt !== null || job.completedAt !== null || job.failureCode !== null) {
      throw new TypeError("Queued erasure lifecycle is inconsistent");
    }
    return;
  }
  if (job.status === "running") {
    if (job.startedAt === null || job.completedAt !== null || job.failureCode !== null) {
      throw new TypeError("Running erasure lifecycle is inconsistent");
    }
    return;
  }
  if (job.status === "completed") {
    if (job.startedAt === null || job.completedAt === null || job.failureCode !== null) {
      throw new TypeError("Completed erasure lifecycle is inconsistent");
    }
    return;
  }
  if (job.completedAt !== null || job.failureCode !== "ERASURE_FAILED") {
    throw new TypeError("Failed erasure lifecycle is inconsistent");
  }
}

export interface ReauthenticationRequest {
  readonly password: string;
  readonly purpose: "account_export" | "account_erasure";
}
export interface ReauthenticationResponse {
  readonly data: { readonly reauthenticationToken: string; readonly expiresAt: string };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const positiveIdentifierSchema = { type: "string", pattern: "^[1-9][0-9]{0,19}$" } as const;
const revisionSchema = { type: "string", pattern: "^[1-9][0-9]*$" } as const;
const localDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const timestampSchema = { type: "string", format: "date-time", pattern: "^(?!0000)" } as const;
const exactDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const nonNegativeDecimalSchema = {
  type: "string",
  maxLength: 200,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveInputDecimalSchema = {
  type: "string",
  maxLength: 19,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$",
} as const;
const nullableTimestampSchema = { anyOf: [timestampSchema, { type: "null" }] } as const;
const nullableText = (maxLength: number) => ({
  anyOf: [{ type: "string", minLength: 1, maxLength }, { type: "null" }],
});
const pageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nextCursor"],
  properties: {
    nextCursor: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_.-]+$" },
        { type: "null" },
      ],
    },
  },
} as const;

export const boundedDateRangeQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: { from: localDateSchema, to: localDateSchema },
} as const;

const trendBoundsProperties = {
  localDate: localDateSchema,
  startsAt: timestampSchema,
  endsAt: timestampSchema,
} as const;

export const nutrientTrendQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrientId", "from", "to"],
  properties: { nutrientId: positiveIdentifierSchema, ...boundedDateRangeQuerySchema.properties },
} as const;

export const nutrientTrendResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["nutrient", "timeZone", "from", "to", "bucket", "watermarkRevision", "points"],
      properties: {
        nutrient: {
          type: "object",
          additionalProperties: false,
          required: ["id", "code", "name", "unit"],
          properties: {
            id: positiveIdentifierSchema,
            code: { type: "string", minLength: 1, maxLength: 64 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            unit: { type: "string", minLength: 1, maxLength: 32 },
          },
        },
        timeZone: { type: "string", minLength: 1, maxLength: 63 },
        from: localDateSchema,
        to: localDateSchema,
        bucket: { type: "string", const: "day" },
        watermarkRevision: revisionSchema,
        points: {
          type: "array",
          maxItems: 366,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["localDate", "startsAt", "endsAt", "aggregate"],
            properties: {
              ...trendBoundsProperties,
              aggregate: { anyOf: [diaryNutrientAggregateSchema, { type: "null" }] },
            },
          },
        },
      },
    },
  },
} as const;

export const repeatDiaryEntryRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["occurredAt"],
  properties: {
    occurredAt: timestampSchema,
    mealSlot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snacks"] },
    position: { type: "integer", minimum: 0, maximum: 1_000_000 },
  },
} as const;
export const repeatDiaryEntryResponseSchema = diaryMutationResponseSchema;

const quantifiedCustomNutrientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrientId", "state", "amountPer100Grams"],
  properties: {
    nutrientId: positiveIdentifierSchema,
    state: { type: "string", const: "quantified" },
    amountPer100Grams: nonNegativeDecimalSchema,
  },
} as const;
const traceCustomNutrientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrientId", "state", "amountPer100Grams"],
  properties: {
    nutrientId: positiveIdentifierSchema,
    state: { type: "string", const: "trace" },
    amountPer100Grams: { type: "null" },
  },
} as const;
const unknownCustomNutrientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrientId", "state", "amountPer100Grams", "reason"],
  properties: {
    nutrientId: positiveIdentifierSchema,
    state: { type: "string", const: "unknown" },
    amountPer100Grams: { type: "null" },
    reason: {
      type: "string",
      enum: ["not_reported", "not_analyzed", "not_applicable", "withheld"],
    },
  },
} as const;
const customFoodNutrientSchema = {
  oneOf: [quantifiedCustomNutrientSchema, traceCustomNutrientSchema, unknownCustomNutrientSchema],
} as const;
const nutrientDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "unit"],
  properties: {
    id: positiveIdentifierSchema,
    code: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
  },
} as const;
const quantifiedCustomNutrientSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrient", "state", "amountPer100Grams"],
  properties: {
    nutrient: nutrientDefinitionSchema,
    state: { type: "string", const: "quantified" },
    amountPer100Grams: nonNegativeDecimalSchema,
  },
} as const;
const traceCustomNutrientSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrient", "state", "amountPer100Grams"],
  properties: {
    nutrient: nutrientDefinitionSchema,
    state: { type: "string", const: "trace" },
    amountPer100Grams: { type: "null" },
  },
} as const;
const unknownCustomNutrientSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nutrient", "state", "amountPer100Grams", "reason"],
  properties: {
    nutrient: nutrientDefinitionSchema,
    state: { type: "string", const: "unknown" },
    amountPer100Grams: { type: "null" },
    reason: {
      type: "string",
      enum: ["not_reported", "not_analyzed", "not_applicable", "withheld"],
    },
  },
} as const;
const customFoodNutrientSnapshotSchema = {
  oneOf: [
    quantifiedCustomNutrientSnapshotSchema,
    traceCustomNutrientSnapshotSchema,
    unknownCustomNutrientSnapshotSchema,
  ],
} as const;
export const customFoodDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "brandName", "serving", "nutrients", "notes"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 500 },
    brandName: nullableText(300),
    serving: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["label", "grams"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 200 },
            grams: positiveInputDecimalSchema,
          },
        },
        { type: "null" },
      ],
    },
    nutrients: { type: "array", minItems: 1, maxItems: 256, items: customFoodNutrientSchema },
    notes: nullableText(2_000),
  },
} as const;

const customFoodVersionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "versionNumber",
    "name",
    "brandName",
    "notes",
    "serving",
    "nutrients",
    "provenance",
    "createdAt",
  ],
  properties: {
    id: positiveIdentifierSchema,
    versionNumber: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 500 },
    brandName: nullableText(300),
    notes: nullableText(2_000),
    serving: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "grams"],
          properties: {
            id: positiveIdentifierSchema,
            label: { type: "string", minLength: 1, maxLength: 200 },
            grams: positiveInputDecimalSchema,
          },
        },
        { type: "null" },
      ],
    },
    nutrients: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: customFoodNutrientSnapshotSchema,
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "statement"],
      properties: {
        kind: { type: "string", const: "user_entered" },
        statement: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    createdAt: timestampSchema,
  },
} as const;
export const customFoodSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"],
  properties: {
    id: uuidSchema,
    status: { type: "string", enum: ["active", "archived"] },
    revision: revisionSchema,
    currentVersion: customFoodVersionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
} as const;
export const customFoodResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["customFood"],
      properties: { customFood: customFoodSchema },
    },
  },
} as const;
export const customFoodMutationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "customFood"],
      properties: { replayed: { type: "boolean" }, customFood: customFoodSchema },
    },
  },
} as const;
export const customFoodListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: { data: { type: "array", maxItems: 50, items: customFoodSchema }, page: pageSchema },
} as const;
export const customFoodListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_.-]+$" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;
export const customFoodParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["customFoodId"],
  properties: { customFoodId: uuidSchema },
} as const;
export const createCustomFoodDiaryEntryRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["customFoodVersionId", "portion", "mealSlot", "occurredAt"],
  properties: {
    customFoodVersionId: positiveIdentifierSchema,
    portion: diaryPortionSchema,
    mealSlot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snacks"] },
    occurredAt: timestampSchema,
    position: { type: "integer", minimum: 0, maximum: 1_000_000 },
  },
} as const;

const biometricDimensions = [
  "mass",
  "length",
  "temperature",
  "duration",
  "count",
  "other",
] as const;
export const biometricDefinitionDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "dimension", "canonicalUnit", "notes"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    dimension: { type: "string", enum: biometricDimensions },
    canonicalUnit: { type: "string", minLength: 1, maxLength: 32 },
    notes: nullableText(1_000),
  },
} as const;
export const biometricDefinitionRevisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "notes"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    notes: nullableText(1_000),
  },
} as const;
export const biometricDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "status",
    "name",
    "dimension",
    "canonicalUnit",
    "notes",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    status: { type: "string", enum: ["active", "archived"] },
    name: { type: "string", minLength: 1, maxLength: 120 },
    dimension: { type: "string", enum: biometricDimensions },
    canonicalUnit: { type: "string", minLength: 1, maxLength: 32 },
    notes: nullableText(1_000),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
} as const;
export const biometricDefinitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["definition"],
      properties: { definition: biometricDefinitionSchema },
    },
  },
} as const;
export const biometricDefinitionMutationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "definition"],
      properties: { replayed: { type: "boolean" }, definition: biometricDefinitionSchema },
    },
  },
} as const;
export const biometricDefinitionListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { type: "array", maxItems: 100, items: biometricDefinitionSchema } },
} as const;
export const biometricDefinitionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definitionId"],
  properties: { definitionId: uuidSchema },
} as const;
export const biometricEventDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definitionId", "measuredAt", "value"],
  properties: { definitionId: uuidSchema, measuredAt: timestampSchema, value: exactDecimalSchema },
} as const;
export const biometricEventRevisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: exactDecimalSchema, measuredAt: timestampSchema },
} as const;
const biometricSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "deviceId", "externalId", "externalRevision"],
  properties: {
    kind: { type: "string", enum: biometricSourceKinds },
    deviceId: { anyOf: [uuidSchema, { type: "null" }] },
    externalId: nullableText(200),
    externalRevision: nullableText(200),
  },
} as const;
export const biometricEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "definitionId",
    "measuredAt",
    "localDate",
    "timeZone",
    "value",
    "source",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    definitionId: uuidSchema,
    measuredAt: timestampSchema,
    localDate: localDateSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    value: exactDecimalSchema,
    source: biometricSourceSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
} as const;
export const biometricEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["event"],
      properties: { event: biometricEventSchema },
    },
  },
} as const;
export const biometricEventMutationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "event"],
      properties: {
        replayed: { type: "boolean" },
        event: { anyOf: [biometricEventSchema, { type: "null" }] },
      },
    },
  },
} as const;
export const biometricEventListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", maxItems: 500, items: biometricEventSchema },
    page: pageSchema,
  },
} as const;
export const biometricEventListQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: timestampSchema,
    to: timestampSchema,
    definitionId: uuidSchema,
    cursor: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_.-]+$" },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  },
} as const;
export const biometricEventParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: { eventId: uuidSchema },
} as const;
export const biometricTrendQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["definitionId", "from", "to"],
  properties: { definitionId: uuidSchema, ...boundedDateRangeQuerySchema.properties },
} as const;
export const biometricTrendResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["definition", "timeZone", "from", "to", "bucket", "points"],
      properties: {
        definition: biometricDefinitionSchema,
        timeZone: { type: "string", minLength: 1, maxLength: 63 },
        from: localDateSchema,
        to: localDateSchema,
        bucket: { type: "string", const: "day" },
        points: {
          type: "array",
          maxItems: 366,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "localDate",
              "startsAt",
              "endsAt",
              "count",
              "first",
              "last",
              "minimum",
              "maximum",
            ],
            properties: {
              ...trendBoundsProperties,
              count: { type: "integer", minimum: 1, maximum: 1_000_000 },
              first: exactDecimalSchema,
              last: exactDecimalSchema,
              minimum: exactDecimalSchema,
              maximum: exactDecimalSchema,
            },
          },
        },
      },
    },
  },
} as const;

export const reminderDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "localTime", "daysOfWeek", "timeZone", "channel", "consentGranted"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 120 },
    localTime: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    daysOfWeek: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: { type: "integer", minimum: 1, maximum: 7 },
    },
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    channel: { type: "string", const: "local" },
    consentGranted: { type: "boolean", const: true },
  },
} as const;
export const reminderRevisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "localTime", "daysOfWeek", "timeZone", "status"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 120 },
    localTime: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    daysOfWeek: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: { type: "integer", minimum: 1, maximum: 7 },
    },
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    status: { type: "string", enum: ["active", "paused"] },
  },
} as const;
export const reminderSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "status",
    "label",
    "localTime",
    "daysOfWeek",
    "timeZone",
    "channel",
    "consent",
    "deliveryPolicy",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    status: { type: "string", enum: ["active", "paused", "revoked"] },
    label: { type: "string", minLength: 1, maxLength: 120 },
    localTime: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    daysOfWeek: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: { type: "integer", minimum: 1, maximum: 7 },
    },
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    channel: { type: "string", const: "local" },
    consent: {
      type: "object",
      additionalProperties: false,
      required: ["policyVersion", "grantedAt", "revokedAt"],
      properties: {
        policyVersion: { type: "string", const: REMINDER_CONSENT_POLICY_VERSION },
        grantedAt: timestampSchema,
        revokedAt: nullableTimestampSchema,
      },
    },
    deliveryPolicy: {
      type: "object",
      additionalProperties: false,
      required: ["title", "lockScreenText", "includesHealthDetails"],
      properties: {
        title: { type: "string", const: GENERIC_REMINDER_TITLE },
        lockScreenText: { type: "string", const: GENERIC_REMINDER_LOCK_SCREEN_TEXT },
        includesHealthDetails: { type: "boolean", const: false },
      },
    },
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
} as const;
export const reminderResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["reminder"],
      properties: { reminder: reminderSchema },
    },
  },
} as const;
export const reminderMutationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "reminder"],
      properties: { replayed: { type: "boolean" }, reminder: reminderSchema },
    },
  },
} as const;
export const reminderListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { type: "array", maxItems: 100, items: reminderSchema } },
} as const;
export const reminderParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reminderId"],
  properties: { reminderId: uuidSchema },
} as const;

export const deviceChallengeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["platform"],
  properties: { platform: { type: "string", enum: healthPlatforms } },
} as const;
export const deviceChallengeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["id", "challenge", "platform", "expiresAt"],
      properties: {
        id: uuidSchema,
        challenge: { type: "string", minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
        platform: { type: "string", enum: healthPlatforms },
        expiresAt: timestampSchema,
      },
    },
  },
} as const;
const publicKeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "algorithm", "derBase64"],
  properties: {
    format: { type: "string", const: "spki" },
    algorithm: { type: "string", const: "ES256" },
    derBase64: {
      type: "string",
      minLength: 80,
      maxLength: 512,
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    },
  },
} as const;
export const registerHealthDeviceRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "challengeId",
    "challenge",
    "platform",
    "displayName",
    "publicKey",
    "challengeSignature",
    "attestation",
  ],
  properties: {
    challengeId: uuidSchema,
    challenge: { type: "string", minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
    platform: { type: "string", enum: healthPlatforms },
    displayName: { type: "string", minLength: 1, maxLength: 120 },
    publicKey: publicKeySchema,
    challengeSignature: {
      type: "string",
      minLength: 86,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    attestation: {
      anyOf: [
        { type: "string", minLength: 16, maxLength: 16_384, pattern: "^[A-Za-z0-9_.-]+$" },
        { type: "null" },
      ],
    },
  },
} as const;
export const healthDeviceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "platform",
    "displayName",
    "keyFingerprint",
    "status",
    "attestationStatus",
    "registeredAt",
    "revokedAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    platform: { type: "string", enum: healthPlatforms },
    displayName: { type: "string", minLength: 1, maxLength: 120 },
    keyFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    status: { type: "string", enum: ["active", "revoked"] },
    attestationStatus: { type: "string", enum: ["not_provided", "unverified", "verified"] },
    registeredAt: timestampSchema,
    revokedAt: nullableTimestampSchema,
  },
} as const;
export const healthDeviceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "device"],
      properties: { replayed: { type: "boolean" }, device: healthDeviceSchema },
    },
  },
} as const;
export const healthDeviceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deviceId"],
  properties: { deviceId: uuidSchema },
} as const;
const importUpsertSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation",
    "externalId",
    "externalRevision",
    "definitionCode",
    "measuredAt",
    "recordedTimeZone",
    "value",
    "unit",
  ],
  properties: {
    operation: { type: "string", const: "upsert" },
    externalId: { type: "string", minLength: 1, maxLength: 200 },
    externalRevision: { type: "string", minLength: 1, maxLength: 200 },
    definitionCode: { type: "string", const: "body_weight" },
    measuredAt: timestampSchema,
    recordedTimeZone: { type: "string", minLength: 1, maxLength: 63 },
    value: exactDecimalSchema,
    unit: { type: "string", const: "kg" },
  },
} as const;
const importDeleteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "externalId", "externalRevision"],
  properties: {
    operation: { type: "string", const: "delete" },
    externalId: { type: "string", minLength: 1, maxLength: 200 },
    externalRevision: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
const sourceCursorSchema = {
  type: "string",
  minLength: 16,
  maxLength: 512,
  pattern: "^[A-Za-z0-9_.-]+$",
} as const;
// Canonical positive PostgreSQL bigint, bounded to 9223372036854775807.
const cursorEpochSchema = {
  type: "string",
  pattern:
    "^(?:[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[01][0-9]{17}|92[01][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[01][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-7])$",
} as const;
export const healthImportBatchRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "deviceId",
    "batchId",
    "platform",
    "cursorEpoch",
    "sourceCursor",
    "nextSourceCursor",
    "records",
  ],
  properties: {
    deviceId: uuidSchema,
    batchId: uuidSchema,
    platform: { type: "string", enum: healthPlatforms },
    cursorEpoch: cursorEpochSchema,
    sourceCursor: { anyOf: [sourceCursorSchema, { type: "null" }] },
    nextSourceCursor: sourceCursorSchema,
    records: {
      type: "array",
      minItems: 0,
      maxItems: 1_000,
      items: { oneOf: [importUpsertSchema, importDeleteSchema] },
    },
  },
} as const;
const importConflictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["externalId", "submittedRevision", "currentRevision", "code"],
  properties: {
    externalId: { type: "string", minLength: 1, maxLength: 200 },
    submittedRevision: { type: "string", minLength: 1, maxLength: 200 },
    currentRevision: { type: "string", minLength: 1, maxLength: 200 },
    code: { type: "string", enum: ["STALE_SOURCE_REVISION", "SOURCE_ID_REUSED"] },
  },
} as const;
export const healthImportBatchResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "accepted", "deleted", "duplicates", "conflicts"],
      properties: {
        replayed: { type: "boolean" },
        accepted: { type: "integer", minimum: 0, maximum: 1_000 },
        deleted: { type: "integer", minimum: 0, maximum: 1_000 },
        duplicates: { type: "integer", minimum: 0, maximum: 1_000 },
        conflicts: { type: "array", maxItems: 1_000, items: importConflictSchema },
      },
    },
  },
} as const;
const bodyWeightScopeSchema = {
  type: "array",
  minItems: 1,
  maxItems: 1,
  items: { type: "string", const: "body_weight" },
} as const;
export const platformConsentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "dataTypeCodes", "consentGranted"],
  properties: {
    platform: { type: "string", enum: healthPlatforms },
    dataTypeCodes: bodyWeightScopeSchema,
    consentGranted: { type: "boolean", const: true },
  },
} as const;
const integrationConsentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "dataTypeCodes", "status", "recordedAt"],
  properties: {
    id: uuidSchema,
    dataTypeCodes: bodyWeightScopeSchema,
    status: { type: "string", enum: ["granted", "revoked"] },
    recordedAt: timestampSchema,
  },
} as const;
export const platformIntegrationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "platform",
    "deviceId",
    "cursorEpoch",
    "revision",
    "status",
    "dataTypeCodes",
    "consentGrantedAt",
    "disconnectedAt",
    "lastImportAt",
    "currentSourceCursor",
    "consentHistory",
  ],
  properties: {
    platform: { type: "string", enum: healthPlatforms },
    deviceId: uuidSchema,
    cursorEpoch: cursorEpochSchema,
    revision: revisionSchema,
    status: { type: "string", enum: ["connected", "disconnected"] },
    dataTypeCodes: bodyWeightScopeSchema,
    consentGrantedAt: timestampSchema,
    disconnectedAt: nullableTimestampSchema,
    lastImportAt: nullableTimestampSchema,
    currentSourceCursor: { anyOf: [sourceCursorSchema, { type: "null" }] },
    consentHistory: { type: "array", maxItems: 1_000, items: integrationConsentSchema },
  },
} as const;
export const platformIntegrationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "integration"],
      properties: { replayed: { type: "boolean" }, integration: platformIntegrationSchema },
    },
  },
} as const;
export const platformIntegrationListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { type: "array", maxItems: 2, items: platformIntegrationSchema } },
} as const;
export const platformParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["platform"],
  properties: { platform: { type: "string", enum: healthPlatforms } },
} as const;
export const disconnectPlatformIntegrationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["importedDataDisposition"],
  properties: { importedDataDisposition: { type: "string", enum: ["retain", "delete"] } },
} as const;
export const rebindPlatformIntegrationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deviceId"],
  properties: { deviceId: uuidSchema },
} as const;

export const accountExportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["formats"],
  properties: {
    formats: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: "string", enum: exportFormats },
    },
  },
} as const;
const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "fileName",
    "byteLength",
    "sha256",
    "downloadPath",
    "mediaType",
    "expiresAt",
  ],
  properties: {
    format: { type: "string", enum: exportFormats },
    fileName: { type: "string", pattern: "^[a-zA-Z0-9_.-]{1,120}$" },
    byteLength: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    downloadPath: {
      type: "string",
      pattern: "^/v1/exports/[0-9a-f-]{36}/artifacts/(?:json|csv)$",
      maxLength: 120,
    },
    mediaType: { type: "string", enum: ["application/json", "application/zip"] },
    expiresAt: timestampSchema,
  },
} as const;
const reconciliationEntitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["entity", "sourceCount", "exportedCount", "watermark"],
  properties: {
    entity: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" },
    sourceCount: { type: "integer", minimum: 0 },
    exportedCount: { type: "integer", minimum: 0 },
    watermark: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
export const accountExportJobSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "formats",
    "requestedAt",
    "startedAt",
    "completedAt",
    "expiresAt",
    "artifacts",
    "manifestSha256",
    "reconciliation",
    "failureCode",
  ],
  properties: {
    id: uuidSchema,
    status: { type: "string", enum: jobStatuses },
    formats: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: "string", enum: exportFormats },
    },
    requestedAt: timestampSchema,
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    expiresAt: nullableTimestampSchema,
    artifacts: { type: "array", maxItems: 2, items: artifactSchema },
    manifestSha256: {
      anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
    },
    reconciliation: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["snapshotWatermark", "entities", "reconciled"],
          properties: {
            snapshotWatermark: { type: "string", minLength: 1, maxLength: 200 },
            entities: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: reconciliationEntitySchema,
            },
            reconciled: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    failureCode: {
      anyOf: [{ type: "string", const: "EXPORT_FAILED" }, { type: "null" }],
    },
  },
} as const;
export const accountExportResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "export"],
      properties: { replayed: { type: "boolean" }, export: accountExportJobSchema },
    },
  },
} as const;
export const accountExportParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["exportId"],
  properties: { exportId: uuidSchema },
} as const;
export const accountExportArtifactParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["exportId", "format"],
  properties: { exportId: uuidSchema, format: { type: "string", enum: exportFormats } },
} as const;
export const accountErasureRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: { confirmation: { type: "string", const: "DELETE_MY_ACCOUNT" } },
} as const;
export const accountErasureJobSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "requestedAt",
    "startedAt",
    "completedAt",
    "executeAfter",
    "recentAuthenticationSatisfied",
    "consequences",
    "failureCode",
  ],
  properties: {
    id: uuidSchema,
    status: { type: "string", enum: jobStatuses },
    requestedAt: timestampSchema,
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    executeAfter: timestampSchema,
    recentAuthenticationSatisfied: { type: "boolean", const: true },
    consequences: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: [
        { type: "string", const: "ACCOUNT_ACCESS_REVOKED" },
        { type: "string", const: "PRIVATE_HEALTH_DATA_DELETED" },
        { type: "string", const: "EXPORT_LINKS_REVOKED" },
      ],
      additionalItems: false,
    },
    failureCode: { anyOf: [{ type: "string", const: "ERASURE_FAILED" }, { type: "null" }] },
  },
} as const;
export const accountErasureResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "erasure"],
      properties: { replayed: { type: "boolean" }, erasure: accountErasureJobSchema },
    },
  },
} as const;
export const accountErasureMutationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "erasure", "statusCapability"],
      properties: {
        replayed: { type: "boolean" },
        erasure: accountErasureJobSchema,
        statusCapability: {
          type: "object",
          additionalProperties: false,
          required: ["token", "expiresAt"],
          properties: {
            token: { type: "string", minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
            expiresAt: timestampSchema,
          },
        },
      },
    },
  },
} as const;
export const accountErasureParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["erasureId"],
  properties: { erasureId: uuidSchema },
} as const;
export const reauthenticationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password", "purpose"],
  properties: {
    password: { type: "string", minLength: 12, maxLength: 128 },
    purpose: { type: "string", enum: ["account_export", "account_erasure"] },
  },
} as const;
export const reauthenticationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["reauthenticationToken", "expiresAt"],
      properties: {
        reauthenticationToken: {
          type: "string",
          minLength: 43,
          maxLength: 128,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        expiresAt: timestampSchema,
      },
    },
  },
} as const;

/** Headers covered by the device signature together with SHA-256(canonical request body). */
export const signedDeviceHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: ["x-device-timestamp", "x-device-nonce", "x-device-signature"],
  properties: {
    "x-device-timestamp": timestampSchema,
    "x-device-nonce": {
      type: "string",
      minLength: 22,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    "x-device-signature": {
      type: "string",
      minLength: 86,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
} as const;
