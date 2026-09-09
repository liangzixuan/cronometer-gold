import { canonicalDecimal, decimal } from "./decimal.js";
import { domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import { canonicalRfc3339Instant, deriveDiaryLocalCoordinates } from "./time.js";

/** Operational product bounds, not exercise or medical guidance. */
export const MAX_ACTIVITY_NAME_CODE_POINTS = 120;
export const MAX_ACTIVITY_NAME_UTF8_BYTES = 480;
export const MAX_ACTIVITY_DURATION_MINUTES = 1_440;
export const MAX_ACTIVITY_ENTRIES_PER_DAY = 64;
export const MAX_ACTIVITY_DAY_DURATION_MINUTES =
  MAX_ACTIVITY_DURATION_MINUTES * MAX_ACTIVITY_ENTRIES_PER_DAY;
export const MAX_ACTIVITY_SELF_REPORTED_ENERGY_KILOCALORIES = "20000";
export const MAX_ACTIVITY_ENERGY_DECIMAL_PLACES = 3;

export type ActivityRevisionOperation = "create" | "delete" | "update";

export interface ActivityEntryRevisionInput {
  readonly revisionId: string;
  readonly entryId: string;
  readonly revisionNumber: number;
  readonly supersedesRevisionId: string | null;
  readonly operation: ActivityRevisionOperation;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories?: string | null;
  readonly occurredAt: string;
  readonly timeZone: string;
  /** Supplied by the application clock; this pure package never reads time. */
  readonly capturedAt: string;
}

export interface ActivityEntryRevision {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly entryId: string;
  readonly revisionNumber: number;
  readonly supersedesRevisionId: string | null;
  readonly operation: ActivityRevisionOperation;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly capturedAt: string;
}

export function canonicalActivityName(value: string): string {
  domainInvariant(
    !/\p{Cc}/u.test(value) && hasOnlyPairedSurrogates(value),
    "INVALID_ACTIVITY",
    "name must not contain control characters or invalid Unicode",
  );
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  domainInvariant(normalized.length > 0, "INVALID_ACTIVITY", "name is required");
  domainInvariant(
    [...normalized].length <= MAX_ACTIVITY_NAME_CODE_POINTS,
    "INVALID_ACTIVITY",
    `name must contain at most ${MAX_ACTIVITY_NAME_CODE_POINTS} Unicode characters`,
  );
  domainInvariant(
    utf8ByteLength(normalized) <= MAX_ACTIVITY_NAME_UTF8_BYTES,
    "INVALID_ACTIVITY",
    `name must use at most ${MAX_ACTIVITY_NAME_UTF8_BYTES} UTF-8 bytes`,
  );
  return normalized;
}

export function canonicalActivityDurationMinutes(value: number): number {
  domainInvariant(
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_ACTIVITY_DURATION_MINUTES,
    "INVALID_ACTIVITY",
    `durationMinutes must be an integer from 1 through ${MAX_ACTIVITY_DURATION_MINUTES}`,
    { durationMinutes: value },
  );
  return value;
}

export function canonicalActivitySelfReportedEnergyKilocalories(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const parsed = decimal(value, "selfReportedEnergyKilocalories");
  domainInvariant(
    parsed.gt(0) && parsed.lte(MAX_ACTIVITY_SELF_REPORTED_ENERGY_KILOCALORIES),
    "INVALID_ACTIVITY",
    `selfReportedEnergyKilocalories must be greater than zero and at most ${MAX_ACTIVITY_SELF_REPORTED_ENERGY_KILOCALORIES}`,
  );
  domainInvariant(
    parsed.decimalPlaces() <= MAX_ACTIVITY_ENERGY_DECIMAL_PLACES,
    "INVALID_ACTIVITY",
    `selfReportedEnergyKilocalories may contain at most ${MAX_ACTIVITY_ENERGY_DECIMAL_PLACES} decimal places`,
  );
  return canonicalDecimal(parsed, "selfReportedEnergyKilocalories");
}

/**
 * Build one immutable activity revision. The start instant determines its local-day bucket.
 * These fields are informational and never alter nutrition goals or energy balance.
 */
export function createActivityEntryRevision(
  input: ActivityEntryRevisionInput,
): ActivityEntryRevision {
  validateRequiredText("revisionId", input.revisionId);
  validateRequiredText("entryId", input.entryId);
  domainInvariant(
    Number.isSafeInteger(input.revisionNumber) && input.revisionNumber > 0,
    "INVALID_ACTIVITY",
    "revisionNumber must be a positive safe integer",
  );
  if (input.operation === "create") {
    domainInvariant(
      input.revisionNumber === 1 && input.supersedesRevisionId === null,
      "INVALID_ACTIVITY",
      "A create revision must be revision 1 and supersede nothing",
    );
  } else {
    domainInvariant(
      input.revisionNumber > 1 && input.supersedesRevisionId !== null,
      "INVALID_ACTIVITY",
      "An update or delete revision must supersede an earlier revision",
    );
    validateRequiredText("supersedesRevisionId", input.supersedesRevisionId);
    domainInvariant(
      input.supersedesRevisionId !== input.revisionId,
      "INVALID_ACTIVITY",
      "An activity revision cannot supersede itself",
    );
  }

  const coordinates = deriveDiaryLocalCoordinates(input.occurredAt, input.timeZone);
  return deepFreeze({
    schemaVersion: 1,
    revisionId: input.revisionId,
    entryId: input.entryId,
    revisionNumber: input.revisionNumber,
    supersedesRevisionId: input.supersedesRevisionId,
    operation: input.operation,
    name: canonicalActivityName(input.name),
    durationMinutes: canonicalActivityDurationMinutes(input.durationMinutes),
    selfReportedEnergyKilocalories: canonicalActivitySelfReportedEnergyKilocalories(
      input.selfReportedEnergyKilocalories,
    ),
    occurredAt: coordinates.occurredAt,
    localDate: coordinates.localDate,
    localTime: coordinates.localTime,
    timeZone: coordinates.timeZone,
    capturedAt: canonicalRfc3339Instant(input.capturedAt, "capturedAt"),
  });
}

/** Exact bounded sum for the durations attached to one profile-local start day. */
export function sumActivityDurationMinutes(durations: readonly number[]): number {
  domainInvariant(
    durations.length <= MAX_ACTIVITY_ENTRIES_PER_DAY,
    "INVALID_ACTIVITY",
    `An activity day may contain at most ${MAX_ACTIVITY_ENTRIES_PER_DAY} active entries`,
  );
  return durations.reduce((sum, duration) => sum + canonicalActivityDurationMinutes(duration), 0);
}

function validateRequiredText(field: string, value: string): void {
  domainInvariant(value.trim().length > 0, "INVALID_ACTIVITY", `${field} is required`);
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
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
}
