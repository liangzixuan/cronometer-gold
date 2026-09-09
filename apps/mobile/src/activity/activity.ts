import type {
  ActivityDay,
  ActivityEntry,
  ActivityMutationResponse,
  CreateActivityEntryRequest,
  UpdateActivityEntryRequest,
} from "@nutrition-tracker/contracts";

import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
} from "../diary/diary";

export const ACTIVITY_NAME_MAX_CODE_POINTS = 120;
export const ACTIVITY_NAME_MAX_UTF8_BYTES = 480;
export const ACTIVITY_DURATION_MAX_MINUTES = 1_440;
export const ACTIVITY_DAY_MAX_ENTRIES = 64;
export const ACTIVITY_DAY_MAX_DURATION_MINUTES =
  ACTIVITY_DURATION_MAX_MINUTES * ACTIVITY_DAY_MAX_ENTRIES;
export const ACTIVITY_SELF_REPORTED_ENERGY_MAX_KILOCALORIES = "20000";

export const ACTIVITY_ENERGY_POLICY_COPY =
  "Self-reported calories are optional history only. They do not change your nutrition goal, calories remaining, nutrition progress, or energy balance. Logged activities never add burned calories or adjust PAL; if your energy goal uses PAL, ordinary activity is already included.";

export const ACTIVITY_ESTIMATE_POLICY_COPY =
  "The app does not estimate calories from an activity name or duration.";

export const ACTIVITY_ONLINE_POLICY_COPY =
  "Activity changes require an internet connection while this screen is open. They are not queued for later.";

export type ActivityMutation = ActivityMutationResponse["data"];

export interface ActivityEditDraft {
  readonly entry: ActivityEntry;
  readonly name: string;
  readonly durationMinutes: string;
  readonly selfReportedEnergyKilocalories: string;
  readonly localDate: string;
  readonly localTime: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_REVISION = /^[1-9][0-9]{0,18}$/u;
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const OCCURRED_AT =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const ENERGY_DRAFT = /^(?:0|[1-9][0-9]*)(?:\.\d{1,3})?$/u;
const ENERGY_CANONICAL =
  /^(?:20000|[1-9][0-9]{0,3}|1[0-9]{4}|(?:0|[1-9][0-9]{0,3}|1[0-9]{4})\.(?:[0-9]{0,2}[1-9]))$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function hasOnlyPairedSurrogates(value: string): boolean {
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
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

function timeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 63) return false;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
      .timeZone;
    return canonical === value;
  } catch {
    return false;
  }
}

function activityLocalCoordinatesMatch(
  entry: Pick<ActivityEntry, "occurredAt" | "localDate" | "localTime" | "timeZone">,
): boolean {
  try {
    const instant = new Date(entry.occurredAt);
    const parts = new Map(
      new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
        timeZone: entry.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
    const year = parts.get("year");
    const month = parts.get("month");
    const day = parts.get("day");
    const hour = parts.get("hour");
    const minute = parts.get("minute");
    const second = parts.get("second");
    if (!year || !month || !day || !hour || !minute || !second) return false;
    const milliseconds = instant.getUTCMilliseconds();
    const derivedTime = `${hour}:${minute}:${second}${
      milliseconds === 0 ? "" : `.${milliseconds.toString().padStart(3, "0")}`
    }`;
    return (
      entry.localDate === `${year.padStart(4, "0")}-${month}-${day}` &&
      entry.localTime === derivedTime
    );
  } catch {
    return false;
  }
}

function canonicalResponseName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return canonicalActivityName(value) === value;
  } catch {
    return false;
  }
}

function duration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= ACTIVITY_DURATION_MAX_MINUTES
  );
}

function energy(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && ENERGY_CANONICAL.test(value));
}

function entriesUseCanonicalOrder(entries: readonly ActivityEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (!previous || !current) return false;
    const previousInstant = Date.parse(previous.occurredAt);
    const currentInstant = Date.parse(current.occurredAt);
    if (
      previousInstant > currentInstant ||
      (previousInstant === currentInstant && previous.id >= current.id)
    ) {
      return false;
    }
  }
  return true;
}

export function canonicalActivityName(value: string): string {
  if (!hasOnlyPairedSurrogates(value) || /\p{Cc}/u.test(value)) {
    throw new TypeError("Activity names must be valid Unicode text without control characters.");
  }
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new RangeError("Enter an activity name.");
  if ([...normalized].length > ACTIVITY_NAME_MAX_CODE_POINTS) {
    throw new RangeError(
      `Activity names cannot exceed ${ACTIVITY_NAME_MAX_CODE_POINTS} characters.`,
    );
  }
  if (utf8ByteLength(normalized) > ACTIVITY_NAME_MAX_UTF8_BYTES) {
    throw new RangeError(`Activity names cannot exceed ${ACTIVITY_NAME_MAX_UTF8_BYTES} bytes.`);
  }
  return normalized;
}

export function activityDurationFromDraft(value: string): number {
  if (!/^[1-9][0-9]{0,3}$/u.test(value)) {
    throw new RangeError("Enter whole minutes from 1 through 1,440.");
  }
  const parsed = Number(value);
  if (!duration(parsed)) throw new RangeError("Enter whole minutes from 1 through 1,440.");
  return parsed;
}

export function activityEnergyFromDraft(value: string): string | null {
  const draft = value.trim();
  if (!draft) return null;
  if (!ENERGY_DRAFT.test(draft)) {
    throw new RangeError("Enter optional self-reported calories from 0.001 through 20,000.");
  }
  const [whole = "0", rawFraction = ""] = draft.split(".");
  const fraction = rawFraction.replace(/0+$/u, "");
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  if (!ENERGY_CANONICAL.test(canonical)) {
    throw new RangeError("Enter optional self-reported calories from 0.001 through 20,000.");
  }
  return canonical;
}

export function isActivityTimeZoneChangedProblem(status: number, value: unknown): boolean {
  return status === 409 && record(value) && value.code === "ACTIVITY_TIME_ZONE_CHANGED";
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
    !canonicalResponseName(value.name) ||
    !duration(value.durationMinutes) ||
    !energy(value.selfReportedEnergyKilocalories) ||
    !occurredAt(value.occurredAt) ||
    !isLocalDate(value.localDate) ||
    typeof value.localTime !== "string" ||
    !LOCAL_TIME.test(value.localTime) ||
    !timeZone(value.timeZone) ||
    !timestamp(value.createdAt)
  ) {
    throw new TypeError("An activity entry was invalid.");
  }
  const parsed = value as unknown as ActivityEntry;
  if (!activityLocalCoordinatesMatch(parsed)) {
    throw new TypeError("An activity entry had inconsistent local coordinates.");
  }
  return parsed;
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
    !timeZone(data.timeZone) ||
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
    !entriesUseCanonicalOrder(entries) ||
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

function retainedDefaultOccurredAt(
  value: string | undefined,
  localDate: string,
  localTime: string,
  timeZoneValue: string,
): string | null {
  if (!value) return null;
  const captured = new Date(value);
  if (
    !Number.isFinite(captured.getTime()) ||
    localDateInTimeZone(captured, timeZoneValue) !== localDate ||
    localTimeInTimeZone(captured, timeZoneValue) !== localTime
  ) {
    return null;
  }
  return captured.toISOString();
}

export function prepareActivityCreate(
  nameDraft: string,
  durationDraft: string,
  energyDraft: string,
  selectedLocalDate: string,
  localTime: string,
  loadedDay: Pick<ActivityDay, "localDate" | "timeZone">,
  untouchedDefaultOccurredAt?: string,
): { readonly body: CreateActivityEntryRequest; readonly expectedTimeZone: string } {
  if (loadedDay.localDate !== selectedLocalDate) {
    throw new TypeError("Load the selected activity day before adding an entry.");
  }
  const retainedOccurredAt = retainedDefaultOccurredAt(
    untouchedDefaultOccurredAt,
    selectedLocalDate,
    localTime,
    loadedDay.timeZone,
  );
  return {
    body: {
      name: canonicalActivityName(nameDraft),
      durationMinutes: activityDurationFromDraft(durationDraft),
      selfReportedEnergyKilocalories: activityEnergyFromDraft(energyDraft),
      occurredAt:
        retainedOccurredAt ??
        localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone),
    },
    expectedTimeZone: loadedDay.timeZone,
  };
}

export function prepareActivityUpdate(
  draft: ActivityEditDraft,
  currentProfileTimeZone: string,
): {
  readonly body: UpdateActivityEntryRequest;
  readonly expectedTimeZone: string | null;
} {
  const name = canonicalActivityName(draft.name);
  const durationMinutes = activityDurationFromDraft(draft.durationMinutes);
  const selfReportedEnergyKilocalories = activityEnergyFromDraft(
    draft.selfReportedEnergyKilocalories,
  );
  if (!isLocalDate(draft.localDate)) {
    throw new RangeError("Enter a valid activity date in YYYY-MM-DD form.");
  }
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(draft.localTime)) {
    throw new RangeError("Enter a valid activity start time in HH:MM form.");
  }
  const body: {
    name?: string;
    durationMinutes?: number;
    selfReportedEnergyKilocalories?: string | null;
    occurredAt?: string;
  } = {};
  if (name !== draft.entry.name) body.name = name;
  if (durationMinutes !== draft.entry.durationMinutes) body.durationMinutes = durationMinutes;
  if (selfReportedEnergyKilocalories !== draft.entry.selfReportedEnergyKilocalories) {
    body.selfReportedEnergyKilocalories = selfReportedEnergyKilocalories;
  }
  const timeChanged =
    draft.localDate !== draft.entry.localDate ||
    draft.localTime !== draft.entry.localTime.slice(0, 5);
  if (timeChanged) {
    body.occurredAt = localDateTimeToInstant(
      draft.localDate,
      draft.localTime,
      currentProfileTimeZone,
    );
  }
  if (Object.keys(body).length === 0) throw new RangeError("Change at least one activity field.");
  return { body, expectedTimeZone: timeChanged ? currentProfileTimeZone : null };
}

export function activityEntryAccessibilityLabel(entry: ActivityEntry): string {
  const minutes = `${entry.durationMinutes.toLocaleString("en-US")} ${entry.durationMinutes === 1 ? "minute" : "minutes"}`;
  const energyLabel =
    entry.selfReportedEnergyKilocalories === null
      ? "self-reported calories not entered"
      : `${entry.selfReportedEnergyKilocalories} self-reported kilocalories`;
  return `${entry.name}, ${minutes}, ${energyLabel}, started at ${entry.localTime.slice(0, 5)}.`;
}
