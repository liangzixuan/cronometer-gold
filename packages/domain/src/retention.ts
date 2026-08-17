import type { DecimalInput, DecimalString } from "./decimal.js";
import { canonicalDecimal, canonicalPositiveDecimal } from "./decimal.js";
import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import { canonicalIanaTimeZone, canonicalRfc3339Instant } from "./time.js";

export const MAX_TREND_DAYS = 366;
export const MAX_CUSTOM_FOOD_SERVINGS = 50;
export const MAX_CUSTOM_FOOD_NUTRIENTS = 256;
export const MAX_BIOMETRIC_PAGE_SIZE = 200;

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ReminderDstPolicy = "earliest_offset_skip_gap";

export interface ReminderOccurrenceInput {
  readonly after: string;
  readonly daysOfWeek: readonly IsoWeekday[];
  readonly localTime: string;
  readonly timeZone: string;
}

export interface ReminderOccurrence {
  readonly instant: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly dstPolicy: ReminderDstPolicy;
}

/** Strict public calendar date; PostgreSQL and JavaScript do not support year zero. */
export function canonicalLocalDate(value: string, field = "localDate"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw invalidDate(field, value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    year > 9999 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw invalidDate(field, value);
  }
  return value;
}

export function canonicalReminderLocalTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new DomainError("INVALID_DATE", "localTime must use 24-hour HH:mm", { value });
  }
  return value;
}

export function canonicalIsoWeekdays(values: readonly number[]): readonly IsoWeekday[] {
  const result = [...new Set(values)].sort((left, right) => left - right);
  domainInvariant(
    result.length > 0 &&
      result.length === values.length &&
      result.every((value) => Number.isInteger(value) && value >= 1 && value <= 7),
    "INVALID_DATE",
    "daysOfWeek must contain unique ISO weekdays 1 through 7",
  );
  return deepFreeze(result as IsoWeekday[]);
}

/**
 * Find the next exact wall-clock occurrence. Ambiguous fall-back times choose
 * the earlier instant; spring-forward gaps are skipped. The explicit policy is
 * persisted with each schedule so future TZDB changes remain explainable.
 */
export function nextReminderOccurrence(input: ReminderOccurrenceInput): ReminderOccurrence {
  const after = canonicalRfc3339Instant(input.after, "after");
  const timeZone = canonicalIanaTimeZone(input.timeZone);
  const localTime = canonicalReminderLocalTime(input.localTime);
  const weekdays = new Set(canonicalIsoWeekdays(input.daysOfWeek));
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "short",
    year: "numeric",
  });
  const afterMs = new Date(after).getTime();
  const afterParts = zonedParts(formatter, afterMs);
  const firstLocalDay = utcCalendarDate(afterParts.localDate);
  // Resolve one wall-clock day at a time. For an ambiguous fall-back minute we
  // deliberately select the first matching instant and, if it was already
  // missed, skip the entire wall occurrence instead of firing at its duplicate.
  for (let dayOffset = 0; dayOffset < 15; dayOffset += 1) {
    const calendar = new Date(firstLocalDay.getTime());
    calendar.setUTCDate(calendar.getUTCDate() + dayOffset);
    const localDate = calendarDateString(calendar);
    const weekday = calendar.getUTCDay() === 0 ? 7 : calendar.getUTCDay();
    if (!weekdays.has(weekday as IsoWeekday)) continue;
    const approximate = calendar.getTime();
    let earliest: number | null = null;
    for (
      let candidate = approximate - 15 * 3_600_000;
      candidate <= approximate + 39 * 3_600_000;
      candidate += 60_000
    ) {
      const parts = zonedParts(formatter, candidate);
      if (parts.localDate === localDate && parts.localTime === localTime) {
        earliest = candidate;
        break;
      }
    }
    // No match means the wall minute was skipped by a forward offset change.
    if (earliest === null || earliest <= afterMs) continue;
    return deepFreeze({
      dstPolicy: "earliest_offset_skip_gap",
      instant: new Date(earliest).toISOString(),
      localDate,
      localTime,
      timeZone,
    });
  }
  throw new DomainError("INVALID_DATE", "Unable to resolve a reminder occurrence", {
    after,
    localTime,
    timeZone,
  });
}

function zonedParts(
  formatter: Intl.DateTimeFormat,
  instant: number,
): { localDate: string; localTime: string } {
  const parts = new Map(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  if (!year || !month || !day || !hour || !minute) {
    throw new DomainError("INVALID_DATE", "Unable to resolve reminder wall-clock coordinates");
  }
  return {
    localDate: canonicalLocalDate(`${year.padStart(4, "0")}-${month}-${day}`),
    localTime: `${hour}:${minute}`,
  };
}

function utcCalendarDate(localDate: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year ?? 0, (month ?? 1) - 1, day ?? 1);
  return result;
}

function calendarDateString(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(
    value.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function canonicalRetentionDecimal(
  value: DecimalInput,
  field: string,
  options: { readonly allowZero?: boolean; readonly maxLength?: number } = {},
): DecimalString {
  const canonical = options.allowZero
    ? canonicalDecimal(value, field)
    : canonicalPositiveDecimal(value, field);
  domainInvariant(
    canonical.length <= (options.maxLength ?? 160),
    "INVALID_DECIMAL",
    `${field} exceeds the supported precision`,
    { field },
  );
  if (options.allowZero) {
    domainInvariant(!canonical.startsWith("-"), "INVALID_DECIMAL", `${field} cannot be negative`, {
      field,
    });
  }
  return canonical;
}

export function assertTrendRange(fromLocalDate: string, toLocalDate: string): number {
  const from = canonicalLocalDate(fromLocalDate, "fromLocalDate");
  const to = canonicalLocalDate(toLocalDate, "toLocalDate");
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
  domainInvariant(
    days >= 1 && days <= MAX_TREND_DAYS,
    "INVALID_DATE",
    `Trend range must contain between 1 and ${MAX_TREND_DAYS} days`,
    { fromLocalDate, toLocalDate },
  );
  return days;
}

function invalidDate(field: string, value: string): DomainError {
  return new DomainError("INVALID_DATE", `${field} must be a valid YYYY-MM-DD date`, {
    field,
    value,
  });
}
