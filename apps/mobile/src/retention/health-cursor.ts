import type { HealthImportBatchRequest } from "@nutrition-tracker/contracts";

export interface HealthCursorState {
  readonly version: 1;
  readonly providerCursor: string | null;
  readonly serverDigest: string | null;
  readonly knownRevisions: Readonly<Record<string, string>>;
}

export interface PendingHealthImport {
  readonly fullReconciliation: boolean;
  readonly deletionSemantics: "explicit_only" | "full_snapshot";
  readonly envelope: {
    readonly body: HealthImportBatchRequest;
    readonly headers: {
      readonly "x-device-timestamp": string;
      readonly "x-device-nonce": string;
      readonly "x-device-signature": string;
    };
  };
  readonly nextCursor: HealthCursorState;
}

export interface HealthSyncState {
  readonly version: 2;
  readonly cursor: HealthCursorState;
  readonly pending: PendingHealthImport | null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function parseHealthCursorState(value: string): HealthCursorState {
  const parsed: unknown = JSON.parse(value);
  if (
    !plainRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !== "knownRevisions,providerCursor,serverDigest,version" ||
    parsed.version !== 1 ||
    !(
      parsed.providerCursor === null ||
      (typeof parsed.providerCursor === "string" && parsed.providerCursor.length <= 16_384)
    ) ||
    !(
      parsed.serverDigest === null ||
      (typeof parsed.serverDigest === "string" && /^[0-9a-f]{64}$/u.test(parsed.serverDigest))
    ) ||
    !plainRecord(parsed.knownRevisions)
  ) {
    throw new TypeError("The device health cursor is invalid.");
  }
  const entries = Object.entries(parsed.knownRevisions);
  if (
    entries.length > 10_000 ||
    entries.some(
      ([externalId, revision]) =>
        externalId.length < 1 ||
        externalId.length > 200 ||
        typeof revision !== "string" ||
        revision.length < 1 ||
        revision.length > 200,
    )
  ) {
    throw new TypeError("The device health reconciliation index is invalid.");
  }
  return parsed as unknown as HealthCursorState;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function timestamp(value: unknown): value is string {
  return (
    bounded(value, 64) && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))
  );
}

function timeZone(value: unknown): value is string {
  if (!bounded(value, 63)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function cursorEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]*$/u.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

function parsePendingImport(value: unknown): PendingHealthImport {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["envelope", "nextCursor", "fullReconciliation", "deletionSemantics"]) ||
    typeof value.fullReconciliation !== "boolean" ||
    (value.deletionSemantics !== "explicit_only" && value.deletionSemantics !== "full_snapshot")
  ) {
    throw new TypeError("The pending health import was invalid.");
  }
  const envelope = value.envelope;
  if (!plainRecord(envelope) || !exactKeys(envelope, ["body", "headers"])) {
    throw new TypeError("The pending health import was invalid.");
  }
  const body = envelope.body;
  const headers = envelope.headers;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const digest = /^[0-9a-f]{64}$/u;
  if (
    !plainRecord(body) ||
    !exactKeys(body, [
      "deviceId",
      "batchId",
      "cursorEpoch",
      "platform",
      "sourceCursor",
      "nextSourceCursor",
      "records",
    ]) ||
    !uuid.test(String(body.deviceId)) ||
    !uuid.test(String(body.batchId)) ||
    !cursorEpoch(body.cursorEpoch) ||
    (body.platform !== "apple_healthkit" && body.platform !== "android_health_connect") ||
    !(body.sourceCursor === null || digest.test(String(body.sourceCursor))) ||
    !digest.test(String(body.nextSourceCursor)) ||
    !Array.isArray(body.records) ||
    body.records.length > 1_000 ||
    !plainRecord(headers) ||
    !exactKeys(headers, ["x-device-timestamp", "x-device-nonce", "x-device-signature"]) ||
    !timestamp(headers["x-device-timestamp"]) ||
    !/^[A-Za-z0-9_-]{22,128}$/u.test(String(headers["x-device-nonce"])) ||
    !/^[A-Za-z0-9_-]{86,512}$/u.test(String(headers["x-device-signature"]))
  ) {
    throw new TypeError("The pending health import was invalid.");
  }
  const identities = new Set<string>();
  for (const record of body.records) {
    if (
      !plainRecord(record) ||
      !bounded(record.externalId, 200) ||
      !bounded(record.externalRevision, 200) ||
      identities.has(record.externalId)
    ) {
      throw new TypeError("A pending health-import record was invalid.");
    }
    identities.add(record.externalId);
    if (record.operation === "delete") {
      if (!exactKeys(record, ["operation", "externalId", "externalRevision"])) {
        throw new TypeError("A pending health-import deletion was invalid.");
      }
      continue;
    }
    if (
      record.operation !== "upsert" ||
      !exactKeys(record, [
        "operation",
        "externalId",
        "externalRevision",
        "definitionCode",
        "measuredAt",
        "recordedTimeZone",
        "value",
        "unit",
      ]) ||
      record.definitionCode !== "body_weight" ||
      !timestamp(record.measuredAt) ||
      !timeZone(record.recordedTimeZone) ||
      typeof record.value !== "string" ||
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(record.value) ||
      record.unit !== "kg"
    ) {
      throw new TypeError("A pending health-import upsert was invalid.");
    }
  }
  const nextCursor = parseHealthCursorState(JSON.stringify(value.nextCursor));
  if (
    nextCursor.serverDigest !== body.nextSourceCursor ||
    nextCursor.serverDigest === body.sourceCursor
  ) {
    throw new TypeError("The pending health import did not bind its next cursor.");
  }
  return value as unknown as PendingHealthImport;
}

export function parseHealthSyncState(raw: string): HealthSyncState {
  const value: unknown = JSON.parse(raw);
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["version", "cursor", "pending"]) ||
    value.version !== 2
  ) {
    throw new TypeError("The protected health synchronization state was invalid.");
  }
  const cursor = parseHealthCursorState(JSON.stringify(value.cursor));
  const pending = value.pending === null ? null : parsePendingImport(value.pending);
  if (pending && pending.envelope.body.sourceCursor !== cursor.serverDigest) {
    throw new TypeError("The pending health import did not bind its prior cursor.");
  }
  return { version: 2, cursor, pending };
}
