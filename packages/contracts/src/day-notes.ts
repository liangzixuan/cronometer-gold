import { diaryNotePatchSchema, MAX_DIARY_NOTE_INPUT_CODE_POINTS } from "./diary.js";

export interface DayNote {
  readonly ownerUserId: string;
  readonly localDate: string;
  readonly id: string | null;
  readonly revision: string;
  readonly note: string | null;
  readonly recordedTimeZone: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}
export interface DayNoteResponse {
  readonly data: DayNote;
}
export interface PutDayNoteRequest {
  readonly note: string | null;
}
export interface DayNoteReceipt {
  readonly protocol: "diary-day-note-v1";
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly localDate: string;
  readonly expectedRevision: string;
  readonly expectedProfileTimeZone: string;
  readonly resultRevision: string;
}
export interface DayNoteMutationResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly note: DayNote;
    readonly receipt: DayNoteReceipt;
  };
}
export interface DayNoteWriteIdentity {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly localDate: string;
  readonly expectedRevision: string;
  readonly expectedProfileTimeZone: string;
  readonly note: string | null;
  readonly noteId: string | null;
}
export interface DayNoteOwnerHeaders {
  readonly "x-expected-owner-user-id": string;
}
export interface DayNoteWriteHeaders extends DayNoteOwnerHeaders {
  readonly "x-expected-profile-time-zone": string;
  readonly "idempotency-key": string;
  readonly "if-match": string;
}
const uuid = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;
const date = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const revision = { type: "string", pattern: "^(?:0|[1-9][0-9]*)$", maxLength: 19 } as const;
const positiveRevision = { ...revision, pattern: "^[1-9][0-9]*$" } as const;
const zone = { type: "string", minLength: 1, maxLength: 63 } as const;
const instant = { type: "string", format: "date-time" } as const;
const noteKeys = [
  "ownerUserId",
  "localDate",
  "id",
  "revision",
  "note",
  "recordedTimeZone",
  "createdAt",
  "updatedAt",
] as const;
export const dayNoteSchema = {
  $id: "DayNote",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: noteKeys,
      properties: {
        ownerUserId: uuid,
        localDate: date,
        revision: { type: "string", const: "0" },
        id: { type: "null" },
        note: { type: "null" },
        recordedTimeZone: { type: "null" },
        createdAt: { type: "null" },
        updatedAt: { type: "null" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: noteKeys,
      properties: {
        ownerUserId: uuid,
        localDate: date,
        revision: positiveRevision,
        id: uuid,
        note: diaryNotePatchSchema,
        recordedTimeZone: zone,
        createdAt: instant,
        updatedAt: instant,
      },
    },
  ],
} as const;
export const dayNoteResponseSchema = {
  $id: "DayNoteResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: dayNoteSchema },
} as const;
export const putDayNoteRequestSchema = {
  $id: "PutDayNoteRequest",
  type: "object",
  additionalProperties: false,
  required: ["note"],
  properties: { note: diaryNotePatchSchema },
} as const;
const receiptKeys = [
  "protocol",
  "operationId",
  "ownerUserId",
  "localDate",
  "expectedRevision",
  "expectedProfileTimeZone",
  "resultRevision",
] as const;
export const dayNoteReceiptSchema = {
  type: "object",
  additionalProperties: false,
  required: receiptKeys,
  properties: {
    protocol: { const: "diary-day-note-v1" },
    operationId: uuid,
    ownerUserId: uuid,
    localDate: date,
    expectedRevision: revision,
    expectedProfileTimeZone: zone,
    resultRevision: positiveRevision,
  },
} as const;
export const dayNoteMutationResponseSchema = {
  $id: "DayNoteMutationResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "note", "receipt"],
      properties: {
        replayed: { type: "boolean" },
        note: dayNoteSchema,
        receipt: dayNoteReceiptSchema,
      },
    },
  },
} as const;
export const dayNoteOwnerHeadersSchema = {
  type: "object",
  required: ["x-expected-owner-user-id"],
  properties: { "x-expected-owner-user-id": uuid },
} as const;
export const dayNoteWriteHeadersSchema = {
  type: "object",
  required: ["x-expected-owner-user-id", "x-expected-profile-time-zone", "idempotency-key"],
  properties: {
    ...dayNoteOwnerHeadersSchema.properties,
    "x-expected-profile-time-zone": zone,
    "idempotency-key": uuid,
    "if-match": { type: "string" },
  },
} as const;
export const dayNoteDateParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: { date },
} as const;

function invalid(): never {
  throw new TypeError("Invalid private day note response");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    return invalid();
  return result;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && new RegExp(uuid.pattern).test(value);
}
function isRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}
function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !new RegExp(date.pattern).test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function isZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 63) return false;
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value
    );
  } catch {
    return false;
  }
}
function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
export function isDayNoteText(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !value || value.includes("\u0000")) return false;
  let count = 0;
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    if ((code >= 0xd800 && code <= 0xdfff) || ++count > MAX_DIARY_NOTE_INPUT_CODE_POINTS)
      return false;
  }
  return true;
}
function parseNote(value: unknown): DayNote {
  const item = closed(value, noteKeys);
  if (
    !isUuid(item.ownerUserId) ||
    !isDate(item.localDate) ||
    !isRevision(item.revision) ||
    !isDayNoteText(item.note)
  )
    return invalid();
  if (item.revision === "0") {
    if (
      [item.id, item.note, item.recordedTimeZone, item.createdAt, item.updatedAt].some(
        (part) => part !== null,
      )
    )
      return invalid();
  } else if (
    !isUuid(item.id) ||
    !isZone(item.recordedTimeZone) ||
    !isInstant(item.createdAt) ||
    !isInstant(item.updatedAt) ||
    item.createdAt > item.updatedAt
  )
    return invalid();
  return item as unknown as DayNote;
}
export function parseDayNoteResponse(value: unknown): DayNoteResponse {
  return { data: parseNote(closed(value, ["data"]).data) };
}
export function parseDayNoteMutationResponse(value: unknown): DayNoteMutationResponse {
  const data = closed(closed(value, ["data"]).data, ["replayed", "note", "receipt"]);
  const note = parseNote(data.note);
  const receipt = closed(data.receipt, receiptKeys);
  if (
    typeof data.replayed !== "boolean" ||
    receipt.protocol !== "diary-day-note-v1" ||
    !isUuid(receipt.operationId) ||
    !isUuid(receipt.ownerUserId) ||
    !isDate(receipt.localDate) ||
    !isRevision(receipt.expectedRevision) ||
    !isRevision(receipt.resultRevision) ||
    !isZone(receipt.expectedProfileTimeZone)
  )
    return invalid();
  if (
    note.id === null ||
    note.ownerUserId !== receipt.ownerUserId ||
    note.localDate !== receipt.localDate ||
    note.revision !== receipt.resultRevision ||
    BigInt(receipt.resultRevision) !== BigInt(receipt.expectedRevision) + 1n ||
    note.recordedTimeZone !== receipt.expectedProfileTimeZone
  )
    return invalid();
  return { data: { replayed: data.replayed, note, receipt: receipt as unknown as DayNoteReceipt } };
}
export function matchesDayNoteMutation(
  response: DayNoteMutationResponse,
  identity: DayNoteWriteIdentity,
): boolean {
  try {
    const { note, receipt } = parseDayNoteMutationResponse(response).data;
    return (
      receipt.operationId === identity.operationId &&
      receipt.ownerUserId === identity.ownerUserId &&
      receipt.localDate === identity.localDate &&
      receipt.expectedRevision === identity.expectedRevision &&
      receipt.expectedProfileTimeZone === identity.expectedProfileTimeZone &&
      note.note === identity.note &&
      (identity.expectedRevision === "0"
        ? identity.noteId === null
        : identity.noteId !== null && note.id === identity.noteId)
    );
  } catch {
    return false;
  }
}
