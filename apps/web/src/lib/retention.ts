import {
  type DiaryNutrient,
  localTimeInTimeZone,
  type MealSlot,
  parseDiaryNutrient,
} from "./diary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/u;
const REVISION = /^[1-9][0-9]*$/u;
const LOCAL_DATE = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const EXACT_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const POSITIVE_INPUT_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;

export type JobStatus = "queued" | "running" | "completed" | "failed";
export type HealthPlatform = "apple_healthkit" | "android_health_connect";

export interface NutrientTrend {
  readonly nutrient: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly unit: string;
  };
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly watermarkRevision: string;
  readonly points: readonly {
    readonly localDate: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly aggregate: DiaryNutrient | null;
  }[];
}

export type CustomFoodNutrient =
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
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: number;
    readonly name: string;
    readonly brandName: string | null;
    readonly notes: string | null;
    readonly serving: {
      readonly id: string;
      readonly label: string;
      readonly grams: string;
    } | null;
    readonly nutrients: readonly CustomFoodNutrientSnapshot[];
    readonly provenance: { readonly kind: "user_entered"; readonly statement: string };
    readonly createdAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface BiometricEvent {
  readonly id: string;
  readonly revision: string;
  readonly definitionId: string;
  readonly measuredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly value: string;
  readonly source: {
    readonly kind: "manual" | HealthPlatform;
    readonly deviceId: string | null;
    readonly externalId: string | null;
    readonly externalRevision: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BiometricTrend {
  readonly definition: BiometricDefinition;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly {
    readonly localDate: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly count: number;
    readonly first: string;
    readonly last: string;
    readonly minimum: string;
    readonly maximum: string;
  }[];
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
    readonly policyVersion: "local-reminders-v1";
    readonly grantedAt: string;
    readonly revokedAt: string | null;
  };
  readonly deliveryPolicy: {
    readonly title: "Nutrition Tracker";
    readonly lockScreenText: "Time to check in.";
    readonly includesHealthDetails: false;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformIntegration {
  readonly platform: HealthPlatform;
  readonly deviceId: string;
  readonly cursorEpoch: string;
  readonly revision: string;
  readonly status: "connected" | "disconnected";
  readonly dataTypeCodes: readonly ["body_weight"];
  readonly consentGrantedAt: string;
  readonly disconnectedAt: string | null;
  readonly lastImportAt: string | null;
  readonly currentSourceCursor: string | null;
  readonly consentHistory: readonly {
    readonly id: string;
    readonly dataTypeCodes: readonly ["body_weight"];
    readonly status: "granted" | "revoked";
    readonly recordedAt: string;
  }[];
}

export interface AccountExportJob {
  readonly id: string;
  readonly status: JobStatus;
  readonly formats: readonly ("json" | "csv")[];
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly artifacts: readonly {
    readonly format: "json" | "csv";
    readonly fileName: string;
    readonly byteLength: string;
    readonly sha256: string;
    readonly downloadPath: string;
    readonly mediaType: "application/json" | "application/zip";
    readonly expiresAt: string;
  }[];
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

export interface AccountErasureJob {
  readonly id: string;
  readonly status: JobStatus;
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === allowed.length &&
    actual.every((key, index) => key === [...allowed].sort()[index])
  );
}

function text(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || text(value, maximum);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && value.includes("T");
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function exactDecimal(value: unknown, maximum = 160): value is string {
  return typeof value === "string" && value.length <= maximum && EXACT_DECIMAL.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && REVISION.test(value);
}

function cursorEpoch(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  );
}

function timeZone(value: unknown): value is string {
  if (!text(value, 63)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function dataValue(value: unknown): unknown {
  if (!record(value) || !keys(value, ["data"])) {
    throw new TypeError("The retention service returned an invalid envelope.");
  }
  return value.data;
}

function envelope(value: unknown): Record<string, unknown> {
  const data = dataValue(value);
  if (!record(data)) throw new TypeError("The retention service returned an invalid envelope.");
  return data;
}

function parseNutrientIdentity(value: unknown): value is CustomFoodNutrientSnapshot["nutrient"] {
  return (
    record(value) &&
    keys(value, ["id", "code", "name", "unit"]) &&
    typeof value.id === "string" &&
    POSITIVE_ID.test(value.id) &&
    text(value.code, 64) &&
    text(value.name, 200) &&
    text(value.unit, 32)
  );
}

function parseCustomFoodNutrientSnapshot(value: unknown): CustomFoodNutrientSnapshot {
  if (!record(value) || !parseNutrientIdentity(value.nutrient)) {
    throw new TypeError("A custom-food nutrient snapshot was invalid.");
  }
  if (
    value.state === "quantified" &&
    keys(value, ["nutrient", "state", "amountPer100Grams"]) &&
    exactDecimal(value.amountPer100Grams, 200) &&
    !String(value.amountPer100Grams).startsWith("-")
  ) {
    return value as unknown as CustomFoodNutrientSnapshot;
  }
  if (
    value.state === "trace" &&
    keys(value, ["nutrient", "state", "amountPer100Grams"]) &&
    value.amountPer100Grams === null
  ) {
    return value as unknown as CustomFoodNutrientSnapshot;
  }
  if (
    value.state === "unknown" &&
    keys(value, ["nutrient", "state", "amountPer100Grams", "reason"]) &&
    value.amountPer100Grams === null &&
    ["not_reported", "not_analyzed", "not_applicable", "withheld"].includes(String(value.reason))
  ) {
    return value as unknown as CustomFoodNutrientSnapshot;
  }
  throw new TypeError("A custom-food nutrient snapshot was invalid.");
}

function parseCustomFood(value: unknown): CustomFood {
  if (
    !record(value) ||
    !keys(value, ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"]) ||
    !uuid(value.id) ||
    !["active", "archived"].includes(String(value.status)) ||
    !revision(value.revision) ||
    !record(value.currentVersion) ||
    !keys(value.currentVersion, [
      "id",
      "versionNumber",
      "name",
      "brandName",
      "notes",
      "serving",
      "nutrients",
      "provenance",
      "createdAt",
    ]) ||
    !uuid(value.currentVersion.id) ||
    !Number.isSafeInteger(value.currentVersion.versionNumber) ||
    Number(value.currentVersion.versionNumber) < 1 ||
    !text(value.currentVersion.name, 500) ||
    !nullableText(value.currentVersion.brandName, 300) ||
    !nullableText(value.currentVersion.notes, 2_000) ||
    !Array.isArray(value.currentVersion.nutrients) ||
    value.currentVersion.nutrients.length < 1 ||
    value.currentVersion.nutrients.length > 256 ||
    !record(value.currentVersion.provenance) ||
    !keys(value.currentVersion.provenance, ["kind", "statement"]) ||
    value.currentVersion.provenance.kind !== "user_entered" ||
    !text(value.currentVersion.provenance.statement, 500) ||
    !timestamp(value.currentVersion.createdAt) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  ) {
    throw new TypeError("A custom food was invalid.");
  }
  const serving = value.currentVersion.serving;
  if (
    serving !== null &&
    (!record(serving) ||
      !keys(serving, ["id", "label", "grams"]) ||
      !POSITIVE_ID.test(String(serving.id)) ||
      !text(serving.label, 200) ||
      !isPositiveInputDecimal(serving.grams))
  ) {
    throw new TypeError("A custom-food serving was invalid.");
  }
  value.currentVersion.nutrients.map(parseCustomFoodNutrientSnapshot);
  return value as unknown as CustomFood;
}

function parseDefinition(value: unknown): BiometricDefinition {
  if (
    !record(value) ||
    !keys(value, [
      "id",
      "revision",
      "status",
      "name",
      "dimension",
      "canonicalUnit",
      "notes",
      "createdAt",
      "updatedAt",
    ]) ||
    !uuid(value.id) ||
    !revision(value.revision) ||
    !["active", "archived"].includes(String(value.status)) ||
    !text(value.name, 120) ||
    !["mass", "length", "temperature", "duration", "count", "other"].includes(
      String(value.dimension),
    ) ||
    !text(value.canonicalUnit, 32) ||
    !nullableText(value.notes, 1_000) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  ) {
    throw new TypeError("A biometric definition was invalid.");
  }
  return value as unknown as BiometricDefinition;
}

function parseEvent(value: unknown): BiometricEvent {
  if (
    !record(value) ||
    !keys(value, [
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
    ]) ||
    !uuid(value.id) ||
    !revision(value.revision) ||
    !uuid(value.definitionId) ||
    !timestamp(value.measuredAt) ||
    !localDate(value.localDate) ||
    !timeZone(value.timeZone) ||
    !exactDecimal(value.value) ||
    !record(value.source) ||
    !keys(value.source, ["kind", "deviceId", "externalId", "externalRevision"]) ||
    !["manual", "apple_healthkit", "android_health_connect"].includes(String(value.source.kind)) ||
    !(value.source.deviceId === null || uuid(value.source.deviceId)) ||
    !nullableText(value.source.externalId, 200) ||
    !nullableText(value.source.externalRevision, 200) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  ) {
    throw new TypeError("A biometric event was invalid.");
  }
  return value as unknown as BiometricEvent;
}

function parseReminder(value: unknown): Reminder {
  if (
    !record(value) ||
    !keys(value, [
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
    ]) ||
    !uuid(value.id) ||
    !revision(value.revision) ||
    !["active", "paused", "revoked"].includes(String(value.status)) ||
    !text(value.label, 120) ||
    typeof value.localTime !== "string" ||
    !LOCAL_TIME.test(value.localTime) ||
    !Array.isArray(value.daysOfWeek) ||
    value.daysOfWeek.length < 1 ||
    value.daysOfWeek.length > 7 ||
    new Set(value.daysOfWeek).size !== value.daysOfWeek.length ||
    !value.daysOfWeek.every(
      (day) => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7,
    ) ||
    !timeZone(value.timeZone) ||
    value.channel !== "local" ||
    !record(value.consent) ||
    !keys(value.consent, ["policyVersion", "grantedAt", "revokedAt"]) ||
    value.consent.policyVersion !== "local-reminders-v1" ||
    !timestamp(value.consent.grantedAt) ||
    !nullableTimestamp(value.consent.revokedAt) ||
    !record(value.deliveryPolicy) ||
    !keys(value.deliveryPolicy, ["title", "lockScreenText", "includesHealthDetails"]) ||
    value.deliveryPolicy.title !== "Nutrition Tracker" ||
    value.deliveryPolicy.lockScreenText !== "Time to check in." ||
    value.deliveryPolicy.includesHealthDetails !== false ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  ) {
    throw new TypeError("A reminder was invalid.");
  }
  return value as unknown as Reminder;
}

export function parseNutrientTrend(value: unknown): NutrientTrend {
  const data = envelope(value);
  if (
    !keys(data, ["nutrient", "timeZone", "from", "to", "bucket", "watermarkRevision", "points"]) ||
    !record(data.nutrient) ||
    !keys(data.nutrient, ["id", "code", "name", "unit"]) ||
    !POSITIVE_ID.test(String(data.nutrient.id)) ||
    !text(data.nutrient.code, 64) ||
    !text(data.nutrient.name, 200) ||
    !text(data.nutrient.unit, 32) ||
    !timeZone(data.timeZone) ||
    !localDate(data.from) ||
    !localDate(data.to) ||
    data.bucket !== "day" ||
    !revision(data.watermarkRevision) ||
    !Array.isArray(data.points) ||
    data.points.length > 366
  ) {
    throw new TypeError("A nutrient trend was invalid.");
  }
  const points = data.points.map((point) => {
    if (
      !record(point) ||
      !keys(point, ["localDate", "startsAt", "endsAt", "aggregate"]) ||
      !localDate(point.localDate) ||
      !timestamp(point.startsAt) ||
      !timestamp(point.endsAt)
    ) {
      throw new TypeError("A nutrient trend point was invalid.");
    }
    return {
      localDate: point.localDate,
      startsAt: point.startsAt,
      endsAt: point.endsAt,
      aggregate: point.aggregate === null ? null : parseDiaryNutrient(point.aggregate),
    };
  });
  return { ...(data as unknown as Omit<NutrientTrend, "points">), points };
}

export interface RetentionPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function parseCustomFoodList(value: unknown): RetentionPage<CustomFood> {
  if (
    !record(value) ||
    !keys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 50
  ) {
    throw new TypeError("The custom-food list was invalid.");
  }
  if (
    !record(value.page) ||
    !keys(value.page, ["nextCursor"]) ||
    !(value.page.nextCursor === null || text(value.page.nextCursor, 512))
  ) {
    throw new TypeError("The custom-food page was invalid.");
  }
  return { items: value.data.map(parseCustomFood), nextCursor: value.page.nextCursor };
}

export function parseCustomFoodMutation(value: unknown): CustomFood {
  const data = envelope(value);
  if (!keys(data, ["replayed", "customFood"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The custom-food mutation was invalid.");
  }
  return parseCustomFood(data.customFood);
}

export function parseCustomFoodResponse(value: unknown): CustomFood {
  const data = envelope(value);
  if (!keys(data, ["customFood"])) throw new TypeError("The custom-food response was invalid.");
  return parseCustomFood(data.customFood);
}

export function parseBiometricDefinitions(value: unknown): readonly BiometricDefinition[] {
  const data = dataValue(value);
  if (!Array.isArray(data) || data.length > 100)
    throw new TypeError("The biometric definitions were invalid.");
  return data.map(parseDefinition);
}

export function parseBiometricDefinitionResponse(value: unknown): BiometricDefinition {
  const data = envelope(value);
  if (keys(data, ["definition"])) return parseDefinition(data.definition);
  if (keys(data, ["replayed", "definition"]) && typeof data.replayed === "boolean") {
    return parseDefinition(data.definition);
  }
  throw new TypeError("The biometric-definition response was invalid.");
}

export function parseBiometricEvents(value: unknown): RetentionPage<BiometricEvent> {
  if (
    !record(value) ||
    !keys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 500
  ) {
    throw new TypeError("The biometric events were invalid.");
  }
  if (
    !record(value.page) ||
    !keys(value.page, ["nextCursor"]) ||
    !(
      value.page.nextCursor === null ||
      (text(value.page.nextCursor, 512) && /^[A-Za-z0-9_.-]+$/u.test(value.page.nextCursor))
    )
  ) {
    throw new TypeError("The biometric-event page was invalid.");
  }
  return { items: value.data.map(parseEvent), nextCursor: value.page.nextCursor };
}

export function parseBiometricMutation(value: unknown): BiometricEvent | null {
  const data = envelope(value);
  if (!keys(data, ["replayed", "event"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The biometric mutation was invalid.");
  }
  return data.event === null ? null : parseEvent(data.event);
}

export function biometricEventLocalTimeUnchanged(
  event: Pick<BiometricEvent, "measuredAt" | "localDate" | "timeZone">,
  localDateInput: string,
  localTimeInput: string,
): boolean {
  if (!localDate(localDateInput) || !LOCAL_TIME.test(localTimeInput)) return false;
  return (
    event.localDate === localDateInput &&
    localTimeInTimeZone(new Date(event.measuredAt), event.timeZone).slice(0, 5) === localTimeInput
  );
}

export function parseBiometricTrend(value: unknown): BiometricTrend {
  const data = envelope(value);
  if (
    !keys(data, ["definition", "timeZone", "from", "to", "bucket", "points"]) ||
    !timeZone(data.timeZone) ||
    !localDate(data.from) ||
    !localDate(data.to) ||
    data.bucket !== "day" ||
    !Array.isArray(data.points) ||
    data.points.length > 366
  ) {
    throw new TypeError("The biometric trend was invalid.");
  }
  const definition = parseDefinition(data.definition);
  const points = data.points.map((point) => {
    if (
      !record(point) ||
      !keys(point, [
        "localDate",
        "startsAt",
        "endsAt",
        "count",
        "first",
        "last",
        "minimum",
        "maximum",
      ]) ||
      !localDate(point.localDate) ||
      !timestamp(point.startsAt) ||
      !timestamp(point.endsAt) ||
      !Number.isSafeInteger(point.count) ||
      Number(point.count) < 1 ||
      !exactDecimal(point.first) ||
      !exactDecimal(point.last) ||
      !exactDecimal(point.minimum) ||
      !exactDecimal(point.maximum)
    )
      throw new TypeError("A biometric trend point was invalid.");
    return point as unknown as BiometricTrend["points"][number];
  });
  return { definition, timeZone: data.timeZone, from: data.from, to: data.to, points };
}

export function parseReminders(value: unknown): readonly Reminder[] {
  const data = dataValue(value);
  if (!Array.isArray(data) || data.length > 100) throw new TypeError("The reminders were invalid.");
  return data.map(parseReminder);
}

export function parseReminderMutation(value: unknown): Reminder {
  const data = envelope(value);
  if (!keys(data, ["replayed", "reminder"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The reminder mutation was invalid.");
  }
  return parseReminder(data.reminder);
}

export function parseReminderResponse(value: unknown): Reminder {
  const data = envelope(value);
  if (keys(data, ["reminder"])) return parseReminder(data.reminder);
  if (keys(data, ["replayed", "reminder"]) && typeof data.replayed === "boolean") {
    return parseReminder(data.reminder);
  }
  throw new TypeError("The reminder response was invalid.");
}

export function parseIntegrations(value: unknown): readonly PlatformIntegration[] {
  const data = dataValue(value);
  if (!Array.isArray(data) || data.length > 2)
    throw new TypeError("The health integrations were invalid.");
  return data.map((integration) => {
    if (
      !record(integration) ||
      !keys(integration, [
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
      ]) ||
      !["apple_healthkit", "android_health_connect"].includes(String(integration.platform)) ||
      !uuid(integration.deviceId) ||
      !cursorEpoch(integration.cursorEpoch) ||
      !revision(integration.revision) ||
      !["connected", "disconnected"].includes(String(integration.status)) ||
      !Array.isArray(integration.dataTypeCodes) ||
      integration.dataTypeCodes.length !== 1 ||
      integration.dataTypeCodes[0] !== "body_weight" ||
      !timestamp(integration.consentGrantedAt) ||
      !nullableTimestamp(integration.disconnectedAt) ||
      !nullableTimestamp(integration.lastImportAt) ||
      !(
        integration.currentSourceCursor === null ||
        (text(integration.currentSourceCursor, 512, 16) &&
          /^[A-Za-z0-9_.-]+$/u.test(integration.currentSourceCursor))
      ) ||
      !Array.isArray(integration.consentHistory) ||
      integration.consentHistory.length > 1_000
    )
      throw new TypeError("A health integration was invalid.");
    for (const consent of integration.consentHistory) {
      if (
        !record(consent) ||
        !keys(consent, ["id", "dataTypeCodes", "status", "recordedAt"]) ||
        !uuid(consent.id) ||
        !Array.isArray(consent.dataTypeCodes) ||
        consent.dataTypeCodes.length !== 1 ||
        consent.dataTypeCodes[0] !== "body_weight" ||
        !["granted", "revoked"].includes(String(consent.status)) ||
        !timestamp(consent.recordedAt)
      )
        throw new TypeError("A health integration consent event was invalid.");
    }
    return integration as unknown as PlatformIntegration;
  });
}

export function parseIntegrationMutation(value: unknown): PlatformIntegration {
  const data = envelope(value);
  if (!keys(data, ["replayed", "integration"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The health-integration response was invalid.");
  }
  const parsed = parseIntegrations({ data: [data.integration] });
  const integration = parsed[0];
  if (!integration) throw new TypeError("The health-integration response was invalid.");
  return integration;
}

export function parseReauthentication(value: unknown): {
  readonly reauthenticationToken: string;
  readonly expiresAt: string;
} {
  const data = envelope(value);
  if (
    !keys(data, ["reauthenticationToken", "expiresAt"]) ||
    typeof data.reauthenticationToken !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(data.reauthenticationToken) ||
    !timestamp(data.expiresAt)
  )
    throw new TypeError("The reauthentication response was invalid.");
  return {
    reauthenticationToken: data.reauthenticationToken,
    expiresAt: data.expiresAt,
  };
}

function safeDownloadPath(value: unknown, exportId: string, format: string): value is string {
  return value === `/v1/exports/${exportId}/artifacts/${format}`;
}

export function parseExportJob(value: unknown): AccountExportJob {
  const data = envelope(value);
  if (
    !keys(data, ["replayed", "export"]) ||
    typeof data.replayed !== "boolean" ||
    !record(data.export)
  ) {
    throw new TypeError("The export response was invalid.");
  }
  const job = data.export;
  if (
    !keys(job, [
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
    ]) ||
    !uuid(job.id) ||
    !["queued", "running", "completed", "failed"].includes(String(job.status)) ||
    !Array.isArray(job.formats) ||
    job.formats.length < 1 ||
    job.formats.length > 2 ||
    !job.formats.every((format) => format === "json" || format === "csv") ||
    !timestamp(job.requestedAt) ||
    !nullableTimestamp(job.startedAt) ||
    !nullableTimestamp(job.completedAt) ||
    !nullableTimestamp(job.expiresAt) ||
    !Array.isArray(job.artifacts) ||
    job.artifacts.length > 2 ||
    !(
      job.manifestSha256 === null ||
      (typeof job.manifestSha256 === "string" && /^[0-9a-f]{64}$/u.test(job.manifestSha256))
    ) ||
    !(job.failureCode === null || job.failureCode === "EXPORT_FAILED")
  )
    throw new TypeError("The export job was invalid.");
  for (const artifact of job.artifacts) {
    if (
      !record(artifact) ||
      !keys(artifact, [
        "format",
        "fileName",
        "byteLength",
        "sha256",
        "downloadPath",
        "mediaType",
        "expiresAt",
      ]) ||
      !["json", "csv"].includes(String(artifact.format)) ||
      typeof artifact.fileName !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,120}$/u.test(artifact.fileName) ||
      typeof artifact.byteLength !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(artifact.byteLength) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !safeDownloadPath(artifact.downloadPath, String(job.id), String(artifact.format)) ||
      artifact.mediaType !==
        (artifact.format === "json" ? "application/json" : "application/zip") ||
      !timestamp(artifact.expiresAt)
    )
      throw new TypeError("An export artifact was invalid.");
  }
  if (job.reconciliation !== null) {
    if (
      !record(job.reconciliation) ||
      !keys(job.reconciliation, ["snapshotWatermark", "entities", "reconciled"]) ||
      !text(job.reconciliation.snapshotWatermark, 200) ||
      !Array.isArray(job.reconciliation.entities) ||
      job.reconciliation.entities.length < 1 ||
      job.reconciliation.entities.length > 100 ||
      typeof job.reconciliation.reconciled !== "boolean"
    ) {
      throw new TypeError("Export reconciliation was invalid.");
    }
    for (const entity of job.reconciliation.entities) {
      if (
        !record(entity) ||
        !keys(entity, ["entity", "sourceCount", "exportedCount", "watermark"]) ||
        typeof entity.entity !== "string" ||
        !/^[a-z][a-z0-9_]{0,62}$/u.test(entity.entity) ||
        !Number.isSafeInteger(entity.sourceCount) ||
        Number(entity.sourceCount) < 0 ||
        !Number.isSafeInteger(entity.exportedCount) ||
        Number(entity.exportedCount) < 0 ||
        !text(entity.watermark, 200)
      )
        throw new TypeError("Export reconciliation counts were invalid.");
    }
  }
  return job as unknown as AccountExportJob;
}

function parseErasureValue(value: unknown): AccountErasureJob {
  if (!record(value)) throw new TypeError("The erasure response was invalid.");
  const job = value;
  if (
    !keys(job, [
      "id",
      "status",
      "requestedAt",
      "startedAt",
      "completedAt",
      "executeAfter",
      "recentAuthenticationSatisfied",
      "consequences",
      "failureCode",
    ]) ||
    !uuid(job.id) ||
    !["queued", "running", "completed", "failed"].includes(String(job.status)) ||
    !timestamp(job.requestedAt) ||
    !nullableTimestamp(job.startedAt) ||
    !nullableTimestamp(job.completedAt) ||
    !timestamp(job.executeAfter) ||
    job.recentAuthenticationSatisfied !== true ||
    !Array.isArray(job.consequences) ||
    job.consequences.length !== 3 ||
    job.consequences[0] !== "ACCOUNT_ACCESS_REVOKED" ||
    job.consequences[1] !== "PRIVATE_HEALTH_DATA_DELETED" ||
    job.consequences[2] !== "EXPORT_LINKS_REVOKED" ||
    !(job.failureCode === null || job.failureCode === "ERASURE_FAILED")
  )
    throw new TypeError("The erasure job was invalid.");
  return job as unknown as AccountErasureJob;
}

export function parseErasureJob(value: unknown): AccountErasureJob {
  const data = envelope(value);
  if (!keys(data, ["replayed", "erasure"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The erasure response was invalid.");
  }
  return parseErasureValue(data.erasure);
}

export function parseErasureMutation(value: unknown): {
  readonly job: AccountErasureJob;
  readonly statusCapability: { readonly token: string; readonly expiresAt: string };
} {
  const data = envelope(value);
  if (
    !keys(data, ["replayed", "erasure", "statusCapability"]) ||
    typeof data.replayed !== "boolean" ||
    !record(data.statusCapability) ||
    !keys(data.statusCapability, ["token", "expiresAt"]) ||
    typeof data.statusCapability.token !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(data.statusCapability.token) ||
    !timestamp(data.statusCapability.expiresAt)
  ) {
    throw new TypeError("The erasure mutation response was invalid.");
  }
  return {
    job: parseErasureValue(data.erasure),
    statusCapability: {
      token: data.statusCapability.token,
      expiresAt: data.statusCapability.expiresAt,
    },
  };
}

export function isPositiveInputDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && POSITIVE_INPUT_DECIMAL.test(value);
}

export function isSignedExactDecimal(value: unknown): value is string {
  return exactDecimal(value);
}

export function trendAggregateLabel(aggregate: DiaryNutrient | null): string {
  if (aggregate === null) return "No data";
  return aggregate.isExact
    ? `${aggregate.knownAmount} ${aggregate.unit} · exact`
    : `At least ${aggregate.knownAmount} ${aggregate.unit} · ${aggregate.completeness}`;
}

export function repeatRequestBody(input: {
  readonly occurredAt: string;
  readonly mealSlot?: MealSlot;
  readonly position?: number;
}): Record<string, unknown> {
  if (!timestamp(input.occurredAt)) throw new TypeError("A valid repeat time is required.");
  return {
    occurredAt: input.occurredAt,
    ...(input.mealSlot ? { mealSlot: input.mealSlot } : {}),
    ...(input.position === undefined ? {} : { position: input.position }),
  };
}

export function operationId(generator: () => string = () => crypto.randomUUID()): string {
  const value = generator();
  if (!uuid(value)) throw new TypeError("A valid operation identifier is required.");
  return value;
}
