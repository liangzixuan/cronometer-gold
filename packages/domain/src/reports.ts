import { canonicalNonNegativeDecimal, canonicalPositiveDecimal, decimal } from "./decimal.js";
import { domainInvariant } from "./errors.js";
import { canonicalLocalDate } from "./retention.js";

export const MAX_NUTRITION_REPORT_DAYS = 31;

function utcCalendarDate(localDate: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year ?? 0, (month ?? 1) - 1, day ?? 1);
  return result;
}

function calendarDateString(value: Date): string {
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Validates and returns the inclusive number of profile-local report days. */
export function assertNutritionReportRange(fromLocalDate: string, toLocalDate: string): number {
  const from = canonicalLocalDate(fromLocalDate, "fromLocalDate");
  const to = canonicalLocalDate(toLocalDate, "toLocalDate");
  domainInvariant(
    from >= "0002-01-01" && to <= "9998-12-31",
    "INVALID_DATE",
    "Nutrition report dates must leave room for exact time-zone day boundaries",
    { fromLocalDate, toLocalDate },
  );
  const days =
    Math.round((utcCalendarDate(to).getTime() - utcCalendarDate(from).getTime()) / 86_400_000) + 1;
  domainInvariant(
    days >= 1 && days <= MAX_NUTRITION_REPORT_DAYS,
    "INVALID_DATE",
    "Nutrition report range must contain between 1 and 31 days",
    { fromLocalDate, toLocalDate },
  );
  return days;
}

export function nutritionReportLocalDates(
  fromLocalDate: string,
  toLocalDate: string,
): readonly string[] {
  const days = assertNutritionReportRange(fromLocalDate, toLocalDate);
  const cursor = utcCalendarDate(fromLocalDate);
  return Object.freeze(
    Array.from({ length: days }, (_, index) => {
      if (index > 0) cursor.setUTCDate(cursor.getUTCDate() + 1);
      return calendarDateString(cursor);
    }),
  );
}

/** Chooses a positive shared scale without coercing exact decimal amounts to binary floats. */
export function nutritionReportScale(amounts: readonly (string | null)[]): string {
  let maximum = decimal(0);
  for (const amount of amounts) {
    if (amount === null) continue;
    const candidate = decimal(canonicalNonNegativeDecimal(amount, "report scale amount"));
    if (candidate.gt(maximum)) maximum = candidate;
  }
  return canonicalPositiveDecimal(maximum.isZero() ? 1 : maximum, "report chart scale");
}

/** Returns a presentation-only decimal percentage bounded to 0..100. */
export function nutritionReportScalePercent(amount: string, scaleMaximum: string): string {
  const value = decimal(canonicalNonNegativeDecimal(amount, "report chart amount"));
  const scale = decimal(canonicalPositiveDecimal(scaleMaximum, "report chart scale"));
  const percent = value.mul(100).div(scale);
  domainInvariant(
    percent.lte(100),
    "INVALID_DECIMAL",
    "Report chart amount must not exceed its declared scale",
    { amount, scaleMaximum },
  );
  return canonicalNonNegativeDecimal(
    percent.toDecimalPlaces(3).toFixed(),
    "report chart percentage",
  );
}
