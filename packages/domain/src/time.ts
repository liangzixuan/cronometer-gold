import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";

const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

export interface DiaryLocalCoordinates {
  /** Canonical UTC instant suitable for PostgreSQL timestamptz. */
  readonly occurredAt: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly localTime: string;
}

/**
 * Parse the deliberately narrow RFC 3339 profile accepted at write boundaries.
 * JavaScript's Date parser alone is insufficient because it normalizes invalid
 * calendar dates such as February 30 instead of rejecting them.
 */
export function canonicalRfc3339Instant(value: string, field = "instant"): string {
  const match = RFC3339_INSTANT.exec(value);
  if (!match) throw invalidInstant(field, value);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const calendarCheck = new Date(0);
  calendarCheck.setUTCHours(0, 0, 0, 0);
  calendarCheck.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw invalidInstant(field, value);
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalidInstant(field, value);
  return parsed.toISOString();
}

/** Validate and canonicalize an IANA time-zone identifier through the runtime TZDB. */
export function canonicalIanaTimeZone(value: string): string {
  const candidate = value.trim();
  domainInvariant(
    candidate.length > 0 && candidate.length <= 63,
    "INVALID_TIME_ZONE",
    "timeZone must be a non-empty IANA identifier",
    { timeZone: value },
  );
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch (cause) {
    throw new DomainError("INVALID_TIME_ZONE", "timeZone must be a supported IANA identifier", {
      timeZone: value,
      cause: cause instanceof Error ? cause.name : "RangeError",
    });
  }
}

/** Derive the diary day from an instant and the persisted profile time zone. */
export function deriveDiaryLocalCoordinates(
  occurredAt: string,
  timeZone: string,
): DiaryLocalCoordinates {
  const canonicalInstant = canonicalRfc3339Instant(occurredAt, "occurredAt");
  const canonicalZone = canonicalIanaTimeZone(timeZone);
  const instant = new Date(canonicalInstant);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone: canonicalZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const month = requiredPart(values, "month");
  const day = requiredPart(values, "day");
  const hour = requiredPart(values, "hour");
  const minute = requiredPart(values, "minute");
  const second = requiredPart(values, "second");
  const localMonth = /^\d{2}$/.test(month) ? Number(month) : Number.NaN;
  // An IANA offset can move an instant by at most one calendar day. Infer the
  // local year only at the December/January boundary so this remains stable
  // across ICU releases that omit the requested localized era part.
  let localYear = instant.getUTCFullYear();
  const utcMonth = instant.getUTCMonth() + 1;
  if (utcMonth === 1 && localMonth === 12) localYear -= 1;
  if (utcMonth === 12 && localMonth === 1) localYear += 1;
  if (
    !Number.isSafeInteger(localMonth) ||
    localMonth < 1 ||
    localMonth > 12 ||
    localYear < 1 ||
    localYear > 9999
  ) {
    throw new DomainError(
      "INVALID_DATE",
      "occurredAt resolves outside the supported local calendar range",
      { occurredAt: canonicalInstant, timeZone: canonicalZone },
    );
  }
  const year = String(localYear).padStart(4, "0");
  const milliseconds = instant.getUTCMilliseconds();

  return deepFreeze({
    occurredAt: canonicalInstant,
    timeZone: canonicalZone,
    localDate: `${year}-${month}-${day}`,
    localTime: `${hour}:${minute}:${second}${
      milliseconds === 0 ? "" : `.${milliseconds.toString().padStart(3, "0")}`
    }`,
  });
}

function requiredPart(parts: ReadonlyMap<string, string>, field: string): string {
  const value = parts.get(field);
  if (!value) {
    throw new DomainError("INVALID_TIME_ZONE", "Unable to derive local diary coordinates", {
      field,
    });
  }
  return value;
}

function invalidInstant(field: string, value: string): DomainError {
  return new DomainError("INVALID_DATE", `${field} must be a valid RFC 3339 instant`, {
    field,
    value,
  });
}
