export interface HydrationLocalMinuteCandidate {
  /** Exact UTC instant at second zero of the chosen local minute. */
  readonly occurredAt: string;
  /** Positive east of UTC; historical IANA offsets can include seconds. */
  readonly utcOffsetSeconds: number;
  readonly utcOffsetLabel: string;
}

export type HydrationLocalMinuteResolution =
  | {
      readonly kind: "invalid";
      readonly reason: "date" | "time" | "time-zone" | "range";
      readonly candidates: readonly [];
    }
  | { readonly kind: "gap"; readonly timeZone: string; readonly candidates: readonly [] }
  | {
      readonly kind: "unique";
      readonly timeZone: string;
      readonly candidates: readonly [HydrationLocalMinuteCandidate];
    }
  | {
      readonly kind: "ambiguous";
      readonly timeZone: string;
      readonly candidates: readonly [
        HydrationLocalMinuteCandidate,
        HydrationLocalMinuteCandidate,
        ...HydrationLocalMinuteCandidate[],
      ];
    };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

type Coordinates = readonly [number, number, number, number, number, number];

/** Date.UTC interprets years 0–99 as 1900–1999; civil input must not use that shortcut. */
function civilMilliseconds([year, month, day, hour, minute, second]: Coordinates): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function coordinates(formatter: Intl.DateTimeFormat, milliseconds: number): Coordinates {
  const instant = new Date(milliseconds);
  const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const month = Number(parts.get("month"));
  // Infer the year at the UTC/local December boundary, as the domain time helper
  // does. This avoids Intl's era/year presentation for the supported-range edges.
  let year = instant.getUTCFullYear();
  const utcMonth = instant.getUTCMonth() + 1;
  if (utcMonth === 1 && month === 12) year -= 1;
  if (utcMonth === 12 && month === 1) year += 1;
  return [
    year,
    month,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
  ];
}

function offsetLabel(seconds: number): string {
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3_600);
  const minutes = Math.floor((absolute % 3_600) / 60);
  const remainder = absolute % 60;
  const sign = seconds < 0 ? "−" : "+";
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${
    remainder === 0 ? "" : `:${String(remainder).padStart(2, "0")}`
  }`;
}

/**
 * Resolve a deliberately selected hydration minute using the runtime IANA TZDB.
 * Returns every matching occurrence, earliest first; the caller must explicitly
 * select an ambiguous occurrence. This never chooses a fold or normalizes a gap.
 * Existing instants should bypass this resolver for amount-only corrections.
 */
export function resolveHydrationLocalMinute(
  localDate: string,
  localTime: string,
  timeZone: string,
): HydrationLocalMinuteResolution {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  const year = Number(dateMatch?.[1]);
  const month = Number(dateMatch?.[2]);
  const day = Number(dateMatch?.[3]);
  const calendar = new Date(civilMilliseconds([year, month, day, 0, 0, 0]));
  if (
    !dateMatch ||
    year < 1 ||
    year > 9999 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day
  ) {
    return { kind: "invalid", reason: "date", candidates: [] };
  }
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(localTime);
  if (!timeMatch) return { kind: "invalid", reason: "time", candidates: [] };
  const wanted: Coordinates = [year, month, day, Number(timeMatch[1]), Number(timeMatch[2]), 0];
  const desired = civilMilliseconds(wanted);
  let formatter: Intl.DateTimeFormat;
  let canonicalZone: string;
  try {
    const candidate = timeZone.trim();
    if (candidate.length === 0 || candidate.length > 63) {
      return { kind: "invalid", reason: "time-zone", candidates: [] };
    }
    formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: candidate,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    canonicalZone = formatter.resolvedOptions().timeZone;
  } catch {
    return { kind: "invalid", reason: "time-zone", candidates: [] };
  }

  // The domain's supported IANA offsets move an instant by at most one day.
  // Enumerate offsets over that entire UTC window, including historical seconds.
  // One-minute probes avoid an assumed one-hour DST transition; refine changed
  // intervals to seconds so a transition within a minute does not hide an offset.
  const offsets = new Set<number>();
  const offsetAt = (instant: number): number => {
    const offset = civilMilliseconds(coordinates(formatter, instant)) - instant;
    offsets.add(offset);
    return offset;
  };
  let previousOffset = offsetAt(desired - DAY);
  for (let instant = desired - DAY + MINUTE; instant <= desired + DAY; instant += MINUTE) {
    const offset = offsetAt(instant);
    if (offset !== previousOffset) {
      for (let second = instant - MINUTE + SECOND; second < instant; second += SECOND) {
        offsetAt(second);
      }
    }
    previousOffset = offset;
  }

  const candidates: HydrationLocalMinuteCandidate[] = [];
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > DAY) continue;
    const instant = desired - offset;
    if (coordinates(formatter, instant).some((part, index) => part !== wanted[index])) continue;
    const date = new Date(instant);
    // Hydration's transport is limited to a four-digit, nonzero UTC year too.
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
      return { kind: "invalid", reason: "range", candidates: [] };
    }
    const utcOffsetSeconds = offset / SECOND;
    candidates.push({
      occurredAt: date.toISOString(),
      utcOffsetSeconds,
      utcOffsetLabel: offsetLabel(utcOffsetSeconds),
    });
  }
  candidates.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const [first, second, ...remaining] = candidates;
  if (!first) return { kind: "gap", timeZone: canonicalZone, candidates: [] };
  if (!second) return { kind: "unique", timeZone: canonicalZone, candidates: [first] };
  return { kind: "ambiguous", timeZone: canonicalZone, candidates: [first, second, ...remaining] };
}
