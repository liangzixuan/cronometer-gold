import {
  type AccountErasureJob,
  type AccountExportJob,
  assertAccountErasureLifecycle,
  assertAccountExportLifecycle,
  type BiometricDefinition,
  type BiometricEvent,
  type BiometricTrendResponse,
  type CustomFood,
  type DeviceChallengeResponse,
  type HealthDevice,
  type HealthImportBatchResponse,
  type NutrientTrendResponse,
  type PlatformIntegration,
  type ReauthenticationResponse,
  type Reminder,
} from "@nutrition-tracker/contracts";

import { parseDiaryNutrient } from "../diary/diary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID = /^[1-9][0-9]{0,19}$/u;
const REVISION = /^[1-9][0-9]*$/u;
const DATE = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function cursorEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REVISION.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

function text(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || text(value, maximum);
}

function timestamp(value: unknown): value is string {
  return (
    text(value, 64, 20) && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))
  );
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
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

function dataEnvelope(value: unknown): Record<string, unknown> {
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The retention response envelope was invalid.");
  }
  return value.data;
}

function parseNutrientIdentity(value: unknown): {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "code", "name", "unit"]) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !text(value.code, 64) ||
    !text(value.name, 200) ||
    !text(value.unit, 32)
  ) {
    throw new TypeError("A nutrient identity was invalid.");
  }
  return value as unknown as ReturnType<typeof parseNutrientIdentity>;
}

function parseCustomFoodNutrient(
  value: unknown,
): CustomFood["currentVersion"]["nutrients"][number] {
  if (!record(value) || !record(value.nutrient)) {
    throw new TypeError("A custom-food nutrient was invalid.");
  }
  parseNutrientIdentity(value.nutrient);
  if (
    value.state === "quantified" &&
    exactKeys(value, ["nutrient", "state", "amountPer100Grams"]) &&
    typeof value.amountPer100Grams === "string" &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value.amountPer100Grams) &&
    value.amountPer100Grams.length <= 200
  ) {
    return value as unknown as CustomFood["currentVersion"]["nutrients"][number];
  }
  if (
    value.state === "trace" &&
    exactKeys(value, ["nutrient", "state", "amountPer100Grams"]) &&
    value.amountPer100Grams === null
  ) {
    return value as unknown as CustomFood["currentVersion"]["nutrients"][number];
  }
  if (
    value.state === "unknown" &&
    exactKeys(value, ["nutrient", "state", "amountPer100Grams", "reason"]) &&
    value.amountPer100Grams === null &&
    ["not_reported", "not_analyzed", "not_applicable", "withheld"].includes(String(value.reason))
  ) {
    return value as unknown as CustomFood["currentVersion"]["nutrients"][number];
  }
  throw new TypeError("A custom-food nutrient was invalid.");
}

function parseCustomFood(value: unknown): CustomFood {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"]) ||
    !UUID.test(String(value.id)) ||
    (value.status !== "active" && value.status !== "archived") ||
    !REVISION.test(String(value.revision)) ||
    !record(value.currentVersion) ||
    !exactKeys(value.currentVersion, [
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
    !UUID.test(String(value.currentVersion.id)) ||
    !Number.isSafeInteger(value.currentVersion.versionNumber) ||
    Number(value.currentVersion.versionNumber) < 1 ||
    !text(value.currentVersion.name, 500) ||
    !nullableText(value.currentVersion.brandName, 300) ||
    !nullableText(value.currentVersion.notes, 2_000) ||
    !Array.isArray(value.currentVersion.nutrients) ||
    value.currentVersion.nutrients.length < 1 ||
    value.currentVersion.nutrients.length > 256 ||
    !record(value.currentVersion.provenance) ||
    !exactKeys(value.currentVersion.provenance, ["kind", "statement"]) ||
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
      !exactKeys(serving, ["id", "label", "grams"]) ||
      !ID.test(String(serving.id)) ||
      !text(serving.label, 200) ||
      typeof serving.grams !== "string" ||
      !/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u.test(serving.grams))
  ) {
    throw new TypeError("A custom-food serving was invalid.");
  }
  value.currentVersion.nutrients.map(parseCustomFoodNutrient);
  return value as unknown as CustomFood;
}

function parseDefinition(value: unknown): BiometricDefinition {
  if (
    !record(value) ||
    !exactKeys(value, [
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
    !UUID.test(String(value.id)) ||
    !REVISION.test(String(value.revision)) ||
    (value.status !== "active" && value.status !== "archived") ||
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
    !exactKeys(value, [
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
    !UUID.test(String(value.id)) ||
    !REVISION.test(String(value.revision)) ||
    !UUID.test(String(value.definitionId)) ||
    !timestamp(value.measuredAt) ||
    !localDate(value.localDate) ||
    !timeZone(value.timeZone) ||
    typeof value.value !== "string" ||
    !DECIMAL.test(value.value) ||
    !record(value.source) ||
    !exactKeys(value.source, ["kind", "deviceId", "externalId", "externalRevision"]) ||
    !["manual", "apple_healthkit", "android_health_connect"].includes(String(value.source.kind)) ||
    !(value.source.deviceId === null || UUID.test(String(value.source.deviceId))) ||
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
    !exactKeys(value, [
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
    !UUID.test(String(value.id)) ||
    !REVISION.test(String(value.revision)) ||
    !["active", "paused", "revoked"].includes(String(value.status)) ||
    !text(value.label, 120) ||
    typeof value.localTime !== "string" ||
    !TIME.test(value.localTime) ||
    !Array.isArray(value.daysOfWeek) ||
    value.daysOfWeek.length < 1 ||
    value.daysOfWeek.length > 7 ||
    new Set(value.daysOfWeek).size !== value.daysOfWeek.length ||
    value.daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7) ||
    !timeZone(value.timeZone) ||
    value.channel !== "local" ||
    !record(value.consent) ||
    !exactKeys(value.consent, ["policyVersion", "grantedAt", "revokedAt"]) ||
    value.consent.policyVersion !== "local-reminders-v1" ||
    !timestamp(value.consent.grantedAt) ||
    !nullableTimestamp(value.consent.revokedAt) ||
    !record(value.deliveryPolicy) ||
    !exactKeys(value.deliveryPolicy, ["title", "lockScreenText", "includesHealthDetails"]) ||
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

function parseIntegration(value: unknown): PlatformIntegration {
  if (
    !record(value) ||
    !exactKeys(value, [
      "platform",
      "deviceId",
      "revision",
      "cursorEpoch",
      "status",
      "dataTypeCodes",
      "consentGrantedAt",
      "disconnectedAt",
      "lastImportAt",
      "currentSourceCursor",
      "consentHistory",
    ]) ||
    !["apple_healthkit", "android_health_connect"].includes(String(value.platform)) ||
    !UUID.test(String(value.deviceId)) ||
    !REVISION.test(String(value.revision)) ||
    !cursorEpoch(value.cursorEpoch) ||
    !["connected", "disconnected"].includes(String(value.status)) ||
    !Array.isArray(value.dataTypeCodes) ||
    value.dataTypeCodes.length !== 1 ||
    value.dataTypeCodes[0] !== "body_weight" ||
    !timestamp(value.consentGrantedAt) ||
    !nullableTimestamp(value.disconnectedAt) ||
    !nullableTimestamp(value.lastImportAt) ||
    !(
      value.currentSourceCursor === null ||
      (text(value.currentSourceCursor, 512, 16) &&
        /^[A-Za-z0-9_.-]+$/u.test(value.currentSourceCursor))
    ) ||
    !Array.isArray(value.consentHistory) ||
    value.consentHistory.length > 1_000
  ) {
    throw new TypeError("A platform-health integration was invalid.");
  }
  for (const consent of value.consentHistory) {
    if (
      !record(consent) ||
      !exactKeys(consent, ["id", "dataTypeCodes", "status", "recordedAt"]) ||
      !UUID.test(String(consent.id)) ||
      !Array.isArray(consent.dataTypeCodes) ||
      consent.dataTypeCodes.length !== 1 ||
      consent.dataTypeCodes[0] !== "body_weight" ||
      (consent.status !== "granted" && consent.status !== "revoked") ||
      !timestamp(consent.recordedAt)
    ) {
      throw new TypeError("A platform-health consent record was invalid.");
    }
  }
  return value as unknown as PlatformIntegration;
}

export function parseNutrientTrend(value: unknown): NutrientTrendResponse["data"] {
  const data = dataEnvelope(value);
  if (
    !exactKeys(data, [
      "nutrient",
      "timeZone",
      "from",
      "to",
      "bucket",
      "watermarkRevision",
      "points",
    ]) ||
    !record(data.nutrient) ||
    !timeZone(data.timeZone) ||
    !localDate(data.from) ||
    !localDate(data.to) ||
    data.bucket !== "day" ||
    !REVISION.test(String(data.watermarkRevision)) ||
    !Array.isArray(data.points) ||
    data.points.length > 366
  ) {
    throw new TypeError("A nutrient trend was invalid.");
  }
  parseNutrientIdentity(data.nutrient);
  const points = data.points.map((point) => {
    if (
      !record(point) ||
      !exactKeys(point, ["localDate", "startsAt", "endsAt", "aggregate"]) ||
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
  return { ...(data as unknown as Omit<NutrientTrendResponse["data"], "points">), points };
}

export function parseBiometricTrend(value: unknown): BiometricTrendResponse["data"] {
  const data = dataEnvelope(value);
  if (
    !exactKeys(data, ["definition", "timeZone", "from", "to", "bucket", "points"]) ||
    !timeZone(data.timeZone) ||
    !localDate(data.from) ||
    !localDate(data.to) ||
    data.bucket !== "day" ||
    !Array.isArray(data.points) ||
    data.points.length > 366
  ) {
    throw new TypeError("A biometric trend was invalid.");
  }
  const definition = parseDefinition(data.definition);
  const points = data.points.map((point) => {
    if (
      !record(point) ||
      !exactKeys(point, [
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
      ![point.first, point.last, point.minimum, point.maximum].every(
        (item) => typeof item === "string" && DECIMAL.test(item),
      )
    ) {
      throw new TypeError("A biometric trend point was invalid.");
    }
    return point as unknown as BiometricTrendResponse["data"]["points"][number];
  });
  return {
    definition,
    timeZone: data.timeZone,
    from: data.from,
    to: data.to,
    bucket: "day",
    points,
  };
}

export function parseCustomFoodList(value: unknown): {
  readonly items: readonly CustomFood[];
  readonly nextCursor: string | null;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 50 ||
    !record(value.page) ||
    !exactKeys(value.page, ["nextCursor"]) ||
    !(value.page.nextCursor === null || text(value.page.nextCursor, 512))
  ) {
    throw new TypeError("The custom-food page was invalid.");
  }
  return { items: value.data.map(parseCustomFood), nextCursor: value.page.nextCursor };
}

export function parseCustomFoodResponse(value: unknown): CustomFood {
  const data = dataEnvelope(value);
  if (exactKeys(data, ["customFood"])) return parseCustomFood(data.customFood);
  if (exactKeys(data, ["replayed", "customFood"]) && typeof data.replayed === "boolean") {
    return parseCustomFood(data.customFood);
  }
  throw new TypeError("The custom-food response was invalid.");
}

export function parseDefinitions(value: unknown): readonly BiometricDefinition[] {
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 100
  ) {
    throw new TypeError("The biometric definitions were invalid.");
  }
  return value.data.map(parseDefinition);
}

export function parseDefinitionResponse(value: unknown): BiometricDefinition {
  const data = dataEnvelope(value);
  if (exactKeys(data, ["definition"])) return parseDefinition(data.definition);
  if (exactKeys(data, ["replayed", "definition"]) && typeof data.replayed === "boolean") {
    return parseDefinition(data.definition);
  }
  throw new TypeError("The biometric-definition response was invalid.");
}

export function parseEventList(value: unknown): {
  readonly items: readonly BiometricEvent[];
  readonly nextCursor: string | null;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 500 ||
    !record(value.page) ||
    !exactKeys(value.page, ["nextCursor"]) ||
    !(
      value.page.nextCursor === null ||
      (text(value.page.nextCursor, 512) && /^[A-Za-z0-9_.-]+$/u.test(value.page.nextCursor))
    )
  ) {
    throw new TypeError("The biometric-event page was invalid.");
  }
  return { items: value.data.map(parseEvent), nextCursor: value.page.nextCursor };
}

export function parseEventResponse(value: unknown): BiometricEvent | null {
  const data = dataEnvelope(value);
  if (exactKeys(data, ["event"])) return parseEvent(data.event);
  if (exactKeys(data, ["replayed", "event"]) && typeof data.replayed === "boolean") {
    return data.event === null ? null : parseEvent(data.event);
  }
  throw new TypeError("The biometric-event response was invalid.");
}

export function parseReminders(value: unknown): readonly Reminder[] {
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 100
  ) {
    throw new TypeError("The reminders were invalid.");
  }
  return value.data.map(parseReminder);
}

export function parseReminderResponse(value: unknown): Reminder {
  const data = dataEnvelope(value);
  if (exactKeys(data, ["reminder"])) return parseReminder(data.reminder);
  if (exactKeys(data, ["replayed", "reminder"]) && typeof data.replayed === "boolean") {
    return parseReminder(data.reminder);
  }
  throw new TypeError("The reminder response was invalid.");
}

export function parseIntegrations(value: unknown): readonly PlatformIntegration[] {
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 2
  ) {
    throw new TypeError("The platform integrations were invalid.");
  }
  return value.data.map(parseIntegration);
}

export function parseIntegrationResponse(value: unknown): PlatformIntegration {
  const data = dataEnvelope(value);
  if (!exactKeys(data, ["replayed", "integration"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The platform-integration response was invalid.");
  }
  return parseIntegration(data.integration);
}

export function parseDeviceChallenge(value: unknown): DeviceChallengeResponse["data"] {
  const data = dataEnvelope(value);
  if (
    !exactKeys(data, ["id", "challenge", "platform", "expiresAt"]) ||
    !UUID.test(String(data.id)) ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(String(data.challenge)) ||
    !["apple_healthkit", "android_health_connect"].includes(String(data.platform)) ||
    !timestamp(data.expiresAt)
  ) {
    throw new TypeError("The device challenge was invalid.");
  }
  return data as unknown as DeviceChallengeResponse["data"];
}

function parseHealthDevice(value: unknown): HealthDevice {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "revision",
      "platform",
      "displayName",
      "keyFingerprint",
      "status",
      "attestationStatus",
      "registeredAt",
      "revokedAt",
    ]) ||
    !UUID.test(String(value.id)) ||
    !REVISION.test(String(value.revision)) ||
    !["apple_healthkit", "android_health_connect"].includes(String(value.platform)) ||
    !text(value.displayName, 120) ||
    !/^[0-9a-f]{64}$/u.test(String(value.keyFingerprint)) ||
    !["active", "revoked"].includes(String(value.status)) ||
    !["not_provided", "unverified", "verified"].includes(String(value.attestationStatus)) ||
    !timestamp(value.registeredAt) ||
    !nullableTimestamp(value.revokedAt)
  ) {
    throw new TypeError("The registered health device was invalid.");
  }
  return value as unknown as HealthDevice;
}

export function parseHealthDeviceResponse(value: unknown): HealthDevice {
  const data = dataEnvelope(value);
  if (!exactKeys(data, ["replayed", "device"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The health-device response was invalid.");
  }
  return parseHealthDevice(data.device);
}

export function parseHealthImportResponse(value: unknown): HealthImportBatchResponse {
  const data = dataEnvelope(value);
  if (
    !exactKeys(data, ["replayed", "accepted", "deleted", "duplicates", "conflicts"]) ||
    typeof data.replayed !== "boolean" ||
    !Number.isSafeInteger(data.accepted) ||
    Number(data.accepted) < 0 ||
    !Number.isSafeInteger(data.deleted) ||
    Number(data.deleted) < 0 ||
    !Number.isSafeInteger(data.duplicates) ||
    Number(data.duplicates) < 0 ||
    !Array.isArray(data.conflicts) ||
    data.conflicts.length > 1_000
  ) {
    throw new TypeError("The health-import response was invalid.");
  }
  for (const conflict of data.conflicts) {
    if (
      !record(conflict) ||
      !exactKeys(conflict, ["externalId", "submittedRevision", "currentRevision", "code"]) ||
      !text(conflict.externalId, 200) ||
      !text(conflict.submittedRevision, 200) ||
      !text(conflict.currentRevision, 200) ||
      !["STALE_SOURCE_REVISION", "SOURCE_ID_REUSED"].includes(String(conflict.code))
    ) {
      throw new TypeError("A health-import conflict was invalid.");
    }
  }
  return { data: data as unknown as HealthImportBatchResponse["data"] };
}

function parseExportJob(value: unknown): AccountExportJob {
  if (
    !record(value) ||
    !exactKeys(value, [
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
    !UUID.test(String(value.id)) ||
    !["queued", "running", "completed", "failed"].includes(String(value.status)) ||
    !Array.isArray(value.formats) ||
    value.formats.length < 1 ||
    value.formats.length > 2 ||
    new Set(value.formats).size !== value.formats.length ||
    value.formats.some((format) => format !== "json" && format !== "csv") ||
    !timestamp(value.requestedAt) ||
    !nullableTimestamp(value.startedAt) ||
    !nullableTimestamp(value.completedAt) ||
    !nullableTimestamp(value.expiresAt) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 2 ||
    !(value.manifestSha256 === null || /^[0-9a-f]{64}$/u.test(String(value.manifestSha256))) ||
    !(value.failureCode === null || value.failureCode === "EXPORT_FAILED")
  ) {
    throw new TypeError("The account export was invalid.");
  }
  for (const artifact of value.artifacts) {
    if (
      !record(artifact) ||
      !exactKeys(artifact, [
        "format",
        "fileName",
        "byteLength",
        "sha256",
        "downloadPath",
        "mediaType",
        "expiresAt",
      ]) ||
      (artifact.format !== "json" && artifact.format !== "csv") ||
      !text(artifact.fileName, 240) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(String(artifact.byteLength)) ||
      !/^[0-9a-f]{64}$/u.test(String(artifact.sha256)) ||
      !/^\/v1\/exports\/[0-9a-f-]+\/artifacts\/(?:json|csv)$/iu.test(
        String(artifact.downloadPath),
      ) ||
      !["application/json", "application/zip"].includes(String(artifact.mediaType)) ||
      !timestamp(artifact.expiresAt)
    ) {
      throw new TypeError("An account-export artifact was invalid.");
    }
  }
  if (value.reconciliation !== null) {
    if (
      !record(value.reconciliation) ||
      !exactKeys(value.reconciliation, ["snapshotWatermark", "entities", "reconciled"]) ||
      !text(value.reconciliation.snapshotWatermark, 200) ||
      !Array.isArray(value.reconciliation.entities) ||
      value.reconciliation.entities.length > 100 ||
      typeof value.reconciliation.reconciled !== "boolean"
    ) {
      throw new TypeError("The account-export reconciliation was invalid.");
    }
    for (const entity of value.reconciliation.entities) {
      if (
        !record(entity) ||
        !exactKeys(entity, ["entity", "sourceCount", "exportedCount", "watermark"]) ||
        !text(entity.entity, 120) ||
        !Number.isSafeInteger(entity.sourceCount) ||
        Number(entity.sourceCount) < 0 ||
        !Number.isSafeInteger(entity.exportedCount) ||
        Number(entity.exportedCount) < 0 ||
        !text(entity.watermark, 200)
      ) {
        throw new TypeError("An account-export entity reconciliation was invalid.");
      }
    }
  }
  const job = value as unknown as AccountExportJob;
  assertAccountExportLifecycle(job);
  return job;
}

function parseErasureJob(value: unknown): AccountErasureJob {
  if (
    !record(value) ||
    !exactKeys(value, [
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
    !UUID.test(String(value.id)) ||
    !["queued", "running", "completed", "failed"].includes(String(value.status)) ||
    !timestamp(value.requestedAt) ||
    !nullableTimestamp(value.startedAt) ||
    !nullableTimestamp(value.completedAt) ||
    !timestamp(value.executeAfter) ||
    value.recentAuthenticationSatisfied !== true ||
    !Array.isArray(value.consequences) ||
    value.consequences.join(",") !==
      "ACCOUNT_ACCESS_REVOKED,PRIVATE_HEALTH_DATA_DELETED,EXPORT_LINKS_REVOKED" ||
    !(value.failureCode === null || value.failureCode === "ERASURE_FAILED")
  ) {
    throw new TypeError("The account erasure was invalid.");
  }
  const job = value as unknown as AccountErasureJob;
  assertAccountErasureLifecycle(job);
  return job;
}

export function parseExportResponse(value: unknown): AccountExportJob {
  const data = dataEnvelope(value);
  if (!exactKeys(data, ["replayed", "export"]) || typeof data.replayed !== "boolean") {
    throw new TypeError("The account-export response was invalid.");
  }
  return parseExportJob(data.export);
}

export function parseErasureResponse(value: unknown): {
  readonly job: AccountErasureJob;
  readonly statusCapability: { readonly token: string; readonly expiresAt: string } | null;
} {
  const data = dataEnvelope(value);
  if (exactKeys(data, ["replayed", "erasure"]) && typeof data.replayed === "boolean") {
    return { job: parseErasureJob(data.erasure), statusCapability: null };
  }
  if (
    exactKeys(data, ["replayed", "erasure", "statusCapability"]) &&
    typeof data.replayed === "boolean" &&
    record(data.statusCapability) &&
    exactKeys(data.statusCapability, ["token", "expiresAt"]) &&
    /^[A-Za-z0-9_-]{43,128}$/u.test(String(data.statusCapability.token)) &&
    timestamp(data.statusCapability.expiresAt)
  ) {
    return {
      job: parseErasureJob(data.erasure),
      statusCapability: data.statusCapability as unknown as {
        readonly token: string;
        readonly expiresAt: string;
      },
    };
  }
  throw new TypeError("The account-erasure response was invalid.");
}

export function parseReauthentication(value: unknown): ReauthenticationResponse["data"] {
  const data = dataEnvelope(value);
  if (
    !exactKeys(data, ["reauthenticationToken", "expiresAt"]) ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(String(data.reauthenticationToken)) ||
    !timestamp(data.expiresAt)
  ) {
    throw new TypeError("The reauthentication response was invalid.");
  }
  return data as unknown as ReauthenticationResponse["data"];
}
