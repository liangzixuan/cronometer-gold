import { isLocalDate, localDateInTimeZone } from "./diary";

export const ACTIVITY_NAME_MAX_CODE_POINTS = 120;
export const ACTIVITY_NAME_MAX_UTF8_BYTES = 480;
export const ACTIVITY_DURATION_MAX_MINUTES = 1_440;
export const ACTIVITY_DAY_MAX_ENTRIES = 64;
export const ACTIVITY_DAY_MAX_DURATION_MINUTES =
  ACTIVITY_DURATION_MAX_MINUTES * ACTIVITY_DAY_MAX_ENTRIES;
export const ACTIVITY_ENERGY_MAX_KILOCALORIES = "20000";

export interface ActivityEntry {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface ActivityDay {
  readonly localDate: string;
  readonly timeZone: string;
  readonly revision: string;
  readonly entries: readonly ActivityEntry[];
  readonly totalDurationMinutes: number;
  readonly updatedAt: string | null;
}

export interface ActivityMutation {
  readonly replayed: boolean;
  readonly entry: ActivityEntry | null;
  readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
}

export interface ActivityCreateBody {
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
}

export interface ActivityUpdateBody {
  readonly name?: string;
  readonly durationMinutes?: number;
  readonly selfReportedEnergyKilocalories?: string | null;
  readonly occurredAt?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_REVISION = /^[1-9][0-9]{0,18}$/u;
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const OCCURRED_AT =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const ENERGY_DRAFT = /^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function onlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function canonicalActivityNameFromDraft(value: string): string {
  if (/\p{Cc}/u.test(value) || !onlyPairedSurrogates(value)) {
    throw new RangeError("Activity name cannot contain control characters.");
  }
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    [...normalized].length > ACTIVITY_NAME_MAX_CODE_POINTS ||
    new TextEncoder().encode(normalized).length > ACTIVITY_NAME_MAX_UTF8_BYTES
  ) {
    throw new RangeError("Enter an activity name from 1 to 120 characters.");
  }
  return normalized;
}

export function activityDurationFromDraft(value: string): number {
  if (!/^[1-9][0-9]{0,3}$/u.test(value)) {
    throw new RangeError("Enter whole minutes from 1 to 1,440.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ACTIVITY_DURATION_MAX_MINUTES) {
    throw new RangeError("Enter whole minutes from 1 to 1,440.");
  }
  return parsed;
}

export function activityEnergyFromDraft(value: string): string | null {
  if (value.trim() === "") return null;
  if (!ENERGY_DRAFT.test(value)) {
    throw new RangeError("Enter up to 20,000 calories with no more than 3 decimal places.");
  }
  const [whole = "0", rawFraction = ""] = value.split(".");
  const scaled = BigInt(whole) * 1_000n + BigInt(rawFraction.padEnd(3, "0"));
  if (scaled < 1n || scaled > 20_000_000n) {
    throw new RangeError("Enter up to 20,000 calories with no more than 3 decimal places.");
  }
  const fraction = rawFraction.replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function canonicalActivityName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return canonicalActivityNameFromDraft(value) === value;
  } catch {
    return false;
  }
}

function activityDuration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= ACTIVITY_DURATION_MAX_MINUTES
  );
}

function canonicalActivityEnergy(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return activityEnergyFromDraft(value) === value;
  } catch {
    return false;
  }
}

function revision(value: unknown, positive = false): value is string {
  return (
    typeof value === "string" &&
    (positive ? POSITIVE_REVISION : REVISION).test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    RFC3339.test(value) &&
    isLocalDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
}

function occurredAt(value: unknown): value is string {
  return timestamp(value) && OCCURRED_AT.test(value);
}

function canonicalTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 63) return false;
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value
    );
  } catch {
    return false;
  }
}

function localTimeForInstant(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (!hour || !minute || !second) return "";
  const milliseconds = instant.getUTCMilliseconds();
  return `${hour}:${minute}:${second}${
    milliseconds === 0 ? "" : `.${milliseconds.toString().padStart(3, "0")}`
  }`;
}

function activityCoordinatesMatch(value: Record<string, unknown>): boolean {
  if (
    typeof value.occurredAt !== "string" ||
    typeof value.localDate !== "string" ||
    typeof value.localTime !== "string" ||
    typeof value.timeZone !== "string"
  ) {
    return false;
  }
  const instant = new Date(value.occurredAt);
  return (
    localDateInTimeZone(instant, value.timeZone) === value.localDate &&
    localTimeForInstant(instant, value.timeZone) === value.localTime
  );
}

export function parseActivityEntry(value: unknown): ActivityEntry {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "revision",
      "name",
      "durationMinutes",
      "selfReportedEnergyKilocalories",
      "occurredAt",
      "localDate",
      "localTime",
      "timeZone",
      "createdAt",
    ]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !revision(value.revision, true) ||
    !canonicalActivityName(value.name) ||
    !activityDuration(value.durationMinutes) ||
    !(
      value.selfReportedEnergyKilocalories === null ||
      canonicalActivityEnergy(value.selfReportedEnergyKilocalories)
    ) ||
    !occurredAt(value.occurredAt) ||
    !isLocalDate(value.localDate) ||
    typeof value.localTime !== "string" ||
    !LOCAL_TIME.test(value.localTime) ||
    !canonicalTimeZone(value.timeZone) ||
    !timestamp(value.createdAt) ||
    !activityCoordinatesMatch(value)
  ) {
    throw new TypeError("An activity entry was invalid.");
  }
  return value as unknown as ActivityEntry;
}

function activityEntriesAreOrdered(entries: readonly ActivityEntry[]): boolean {
  return entries.every((entry, index) => {
    const previous = entries[index - 1];
    return (
      !previous ||
      previous.occurredAt < entry.occurredAt ||
      (previous.occurredAt === entry.occurredAt && previous.id < entry.id)
    );
  });
}

export function parseActivityDay(value: unknown): ActivityDay {
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The activity response envelope was invalid.");
  }
  const data = value.data;
  if (
    !exactKeys(data, [
      "localDate",
      "timeZone",
      "revision",
      "entries",
      "totalDurationMinutes",
      "updatedAt",
    ]) ||
    !isLocalDate(data.localDate) ||
    !canonicalTimeZone(data.timeZone) ||
    !revision(data.revision) ||
    !Array.isArray(data.entries) ||
    data.entries.length > ACTIVITY_DAY_MAX_ENTRIES ||
    !Number.isSafeInteger(data.totalDurationMinutes) ||
    Number(data.totalDurationMinutes) < 0 ||
    Number(data.totalDurationMinutes) > ACTIVITY_DAY_MAX_DURATION_MINUTES ||
    !(data.updatedAt === null || timestamp(data.updatedAt))
  ) {
    throw new TypeError("The activity day was invalid.");
  }
  const entries = data.entries.map(parseActivityEntry);
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    !activityEntriesAreOrdered(entries) ||
    entries.some((entry) => entry.localDate !== data.localDate) ||
    entries.reduce((sum, entry) => sum + entry.durationMinutes, 0) !== data.totalDurationMinutes ||
    (data.updatedAt === null &&
      (data.revision !== "0" || entries.length !== 0 || data.totalDurationMinutes !== 0))
  ) {
    throw new TypeError("The activity day was inconsistent.");
  }
  return {
    localDate: data.localDate,
    timeZone: data.timeZone,
    revision: data.revision,
    entries,
    totalDurationMinutes: data.totalDurationMinutes,
    updatedAt: data.updatedAt,
  };
}

export function parseActivityMutation(value: unknown): ActivityMutation {
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The activity mutation envelope was invalid.");
  }
  const data = value.data;
  if (
    !exactKeys(data, ["replayed", "entry", "affectedDays"]) ||
    typeof data.replayed !== "boolean" ||
    !Array.isArray(data.affectedDays) ||
    data.affectedDays.length < 1 ||
    data.affectedDays.length > 2
  ) {
    throw new TypeError("The activity mutation was invalid.");
  }
  const affectedDays = data.affectedDays.map((item) => {
    if (
      !record(item) ||
      !exactKeys(item, ["localDate", "revision"]) ||
      !isLocalDate(item.localDate) ||
      !revision(item.revision, true)
    ) {
      throw new TypeError("An activity mutation day was invalid.");
    }
    return { localDate: item.localDate, revision: item.revision };
  });
  if (new Set(affectedDays.map((item) => item.localDate)).size !== affectedDays.length) {
    throw new TypeError("The activity mutation days were duplicated.");
  }
  return {
    replayed: data.replayed,
    entry: data.entry === null ? null : parseActivityEntry(data.entry),
    affectedDays,
  };
}

export function parseActivityCreateBody(value: unknown): ActivityCreateBody {
  if (
    !record(value) ||
    !exactKeys(value, [
      "name",
      "durationMinutes",
      "selfReportedEnergyKilocalories",
      "occurredAt",
    ]) ||
    !canonicalActivityName(value.name) ||
    !activityDuration(value.durationMinutes) ||
    !(
      value.selfReportedEnergyKilocalories === null ||
      canonicalActivityEnergy(value.selfReportedEnergyKilocalories)
    ) ||
    !occurredAt(value.occurredAt)
  ) {
    throw new TypeError("The activity entry request was invalid.");
  }
  return value as unknown as ActivityCreateBody;
}

export function parseActivityUpdateBody(value: unknown): ActivityUpdateBody {
  if (
    !record(value) ||
    Object.keys(value).length < 1 ||
    Object.keys(value).length > 4 ||
    Object.keys(value).some(
      (key) =>
        key !== "name" &&
        key !== "durationMinutes" &&
        key !== "selfReportedEnergyKilocalories" &&
        key !== "occurredAt",
    ) ||
    ("name" in value && !canonicalActivityName(value.name)) ||
    ("durationMinutes" in value && !activityDuration(value.durationMinutes)) ||
    ("selfReportedEnergyKilocalories" in value &&
      !(
        value.selfReportedEnergyKilocalories === null ||
        canonicalActivityEnergy(value.selfReportedEnergyKilocalories)
      )) ||
    ("occurredAt" in value && !occurredAt(value.occurredAt))
  ) {
    throw new TypeError("The activity entry update was invalid.");
  }
  return value as ActivityUpdateBody;
}

export type ActivityMutationExpectation =
  | {
      readonly kind: "create";
      readonly sourceLocalDate: string;
      readonly request: ActivityCreateBody;
    }
  | {
      readonly kind: "update";
      readonly entryId: string;
      readonly sourceLocalDate: string;
      readonly request: ActivityUpdateBody;
    }
  | {
      readonly kind: "delete";
      readonly entryId: string;
      readonly sourceLocalDate: string;
    };

/** Validate mutation meaning against the browser's exact request, not only its envelope shape. */
export function assertActivityMutationSemantics(
  mutation: ActivityMutation,
  expectation: ActivityMutationExpectation,
): void {
  if (!isLocalDate(expectation.sourceLocalDate)) {
    throw new TypeError("The activity mutation expectation was invalid.");
  }
  if (expectation.kind === "delete") {
    if (
      mutation.entry !== null ||
      mutation.affectedDays.length !== 1 ||
      mutation.affectedDays[0]?.localDate !== expectation.sourceLocalDate
    ) {
      throw new TypeError("The activity delete response was inconsistent.");
    }
    return;
  }
  const entry = mutation.entry;
  if (!entry || (expectation.kind === "update" && entry.id !== expectation.entryId)) {
    throw new TypeError("The activity mutation returned the wrong entry.");
  }
  for (const [key, requested] of Object.entries(expectation.request)) {
    if (entry[key as keyof ActivityEntry] !== requested) {
      throw new TypeError("The activity mutation did not match the requested fields.");
    }
  }
  const expectedDates =
    expectation.kind === "create"
      ? [entry.localDate]
      : [...new Set([expectation.sourceLocalDate, entry.localDate])].sort();
  const actualDates = mutation.affectedDays.map((item) => item.localDate).sort();
  if (
    expectation.sourceLocalDate !==
      (expectation.kind === "create" ? entry.localDate : expectation.sourceLocalDate) ||
    actualDates.length !== expectedDates.length ||
    actualDates.some((value, index) => value !== expectedDates[index])
  ) {
    throw new TypeError("The activity mutation returned inconsistent affected days.");
  }
}

export function activityEntryAccessibilityLabel(entry: ActivityEntry): string {
  const energy = entry.selfReportedEnergyKilocalories
    ? `, ${entry.selfReportedEnergyKilocalories} self-reported kilocalories`
    : ", no calorie estimate";
  return `${entry.name}, ${entry.durationMinutes.toLocaleString("en-US")} minutes${energy}, at ${entry.localTime.slice(0, 5)}.`;
}
