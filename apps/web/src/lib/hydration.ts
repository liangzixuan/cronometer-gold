import { isLocalDate } from "./diary";

export const HYDRATION_ENTRY_MAX_MILLILITERS = 20_000;
export const HYDRATION_DAY_MAX_ENTRIES = 64;
export const HYDRATION_DAY_MAX_MILLILITERS = 100_000;

export interface HydrationEntry {
  readonly id: string;
  readonly revision: string;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface HydrationDay {
  readonly localDate: string;
  readonly timeZone: string;
  readonly revision: string;
  readonly entries: readonly HydrationEntry[];
  readonly totalMilliliters: number;
  readonly updatedAt: string | null;
}

export interface HydrationMutation {
  readonly replayed: boolean;
  readonly entry: HydrationEntry | null;
  readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
}

export interface HydrationCreateBody {
  readonly amountMilliliters: number;
  readonly occurredAt: string;
}

export type HydrationUpdateBody =
  | { readonly amountMilliliters: number; readonly occurredAt?: string }
  | { readonly amountMilliliters?: number; readonly occurredAt: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_REVISION = /^[1-9][0-9]{0,18}$/u;
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const OCCURRED_AT =
  /^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
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
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function amount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= HYDRATION_ENTRY_MAX_MILLILITERS
  );
}

export function hydrationAmountFromDraft(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new RangeError("Enter a whole number of milliliters from 1 to 20,000.");
  }
  const parsed = Number(value);
  if (!amount(parsed)) {
    throw new RangeError("Enter a whole number of milliliters from 1 to 20,000.");
  }
  return parsed;
}

export function parseHydrationEntry(value: unknown): HydrationEntry {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "revision",
      "amountMilliliters",
      "occurredAt",
      "localDate",
      "localTime",
      "timeZone",
      "createdAt",
    ]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !revision(value.revision, true) ||
    !amount(value.amountMilliliters) ||
    !occurredAt(value.occurredAt) ||
    !isLocalDate(value.localDate) ||
    typeof value.localTime !== "string" ||
    !LOCAL_TIME.test(value.localTime) ||
    !timeZone(value.timeZone) ||
    !timestamp(value.createdAt)
  ) {
    throw new TypeError("A hydration entry was invalid.");
  }
  return value as unknown as HydrationEntry;
}

export function parseHydrationDay(value: unknown): HydrationDay {
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The hydration response envelope was invalid.");
  }
  const data = value.data;
  if (
    !exactKeys(data, [
      "localDate",
      "timeZone",
      "revision",
      "entries",
      "totalMilliliters",
      "updatedAt",
    ]) ||
    !isLocalDate(data.localDate) ||
    !timeZone(data.timeZone) ||
    !revision(data.revision) ||
    !Array.isArray(data.entries) ||
    data.entries.length > HYDRATION_DAY_MAX_ENTRIES ||
    !Number.isSafeInteger(data.totalMilliliters) ||
    Number(data.totalMilliliters) < 0 ||
    Number(data.totalMilliliters) > HYDRATION_DAY_MAX_MILLILITERS ||
    !(data.updatedAt === null || timestamp(data.updatedAt))
  ) {
    throw new TypeError("The hydration day was invalid.");
  }
  const entries = data.entries.map(parseHydrationEntry);
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    entries.some((entry) => entry.localDate !== data.localDate) ||
    entries.reduce((sum, entry) => sum + entry.amountMilliliters, 0) !== data.totalMilliliters ||
    (data.updatedAt === null &&
      (data.revision !== "0" || entries.length !== 0 || data.totalMilliliters !== 0))
  ) {
    throw new TypeError("The hydration day was inconsistent.");
  }
  return {
    localDate: data.localDate,
    timeZone: data.timeZone,
    revision: data.revision,
    entries,
    totalMilliliters: data.totalMilliliters,
    updatedAt: data.updatedAt,
  };
}

export function parseHydrationMutation(value: unknown): HydrationMutation {
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The hydration mutation envelope was invalid.");
  }
  const data = value.data;
  if (
    !exactKeys(data, ["replayed", "entry", "affectedDays"]) ||
    typeof data.replayed !== "boolean" ||
    !Array.isArray(data.affectedDays) ||
    data.affectedDays.length < 1 ||
    data.affectedDays.length > 2
  ) {
    throw new TypeError("The hydration mutation was invalid.");
  }
  const affectedDays = data.affectedDays.map((item) => {
    if (
      !record(item) ||
      !exactKeys(item, ["localDate", "revision"]) ||
      !isLocalDate(item.localDate) ||
      !revision(item.revision, true)
    ) {
      throw new TypeError("A hydration mutation day was invalid.");
    }
    return { localDate: item.localDate, revision: item.revision };
  });
  if (new Set(affectedDays.map((item) => item.localDate)).size !== affectedDays.length) {
    throw new TypeError("The hydration mutation days were duplicated.");
  }
  return {
    replayed: data.replayed,
    entry: data.entry === null ? null : parseHydrationEntry(data.entry),
    affectedDays,
  };
}

export function parseHydrationCreateBody(value: unknown): HydrationCreateBody {
  if (
    !record(value) ||
    !exactKeys(value, ["amountMilliliters", "occurredAt"]) ||
    !amount(value.amountMilliliters) ||
    !occurredAt(value.occurredAt)
  ) {
    throw new TypeError("The hydration entry request was invalid.");
  }
  return {
    amountMilliliters: value.amountMilliliters,
    occurredAt: value.occurredAt,
  };
}

export function parseHydrationUpdateBody(value: unknown): HydrationUpdateBody {
  if (
    !record(value) ||
    Object.keys(value).length < 1 ||
    Object.keys(value).length > 2 ||
    Object.keys(value).some((key) => key !== "amountMilliliters" && key !== "occurredAt") ||
    ("amountMilliliters" in value && !amount(value.amountMilliliters)) ||
    ("occurredAt" in value && !occurredAt(value.occurredAt))
  ) {
    throw new TypeError("The hydration entry update was invalid.");
  }
  return value as HydrationUpdateBody;
}

export function hydrationEntryAccessibilityLabel(entry: HydrationEntry): string {
  return `${entry.amountMilliliters.toLocaleString("en-US")} milliliters at ${entry.localTime.slice(0, 5)}.`;
}
