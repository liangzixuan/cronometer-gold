import type { UpdateUserProfileRequest } from "@nutrition-tracker/contracts";
import {
  canonicalIanaTimeZone,
  canonicalPositiveDecimal,
  decimal,
} from "@nutrition-tracker/domain";

function measurement(
  value: string | null,
  field: string,
  minimum: number,
  maximum: number,
): string | null {
  if (value === null) return value;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value)) {
    throw new RangeError(`${field} has invalid precision`);
  }
  const canonical = canonicalPositiveDecimal(value, field);
  const parsed = decimal(canonical, field);
  if (parsed.lt(minimum) || parsed.gt(maximum)) throw new RangeError(`${field} is out of range`);
  return canonical;
}

function birthDate(value: string | null, now: Date): string | null {
  if (value === null) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("birthDate is invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("birthDate is invalid");
  }
  const today = now.toISOString().slice(0, 10);
  if (value > today) throw new RangeError("birthDate cannot be in the future");
  return value;
}

/** Normalize the complete public profile patch before any persistence adapter is called. */
export function normalizeProfilePatch(
  patch: UpdateUserProfileRequest,
  now: Date = new Date(),
): UpdateUserProfileRequest {
  try {
    const displayName = patch.displayName?.normalize("NFKC").trim();
    if (displayName !== undefined && Buffer.byteLength(displayName, "utf8") > 300) {
      throw new RangeError("displayName is too long");
    }
    const locale =
      patch.locale === undefined ? undefined : Intl.getCanonicalLocales(patch.locale)[0];
    if (locale !== undefined && (locale.length < 2 || locale.length > 35)) {
      throw new RangeError("locale is invalid");
    }
    const timeZone =
      patch.timeZone === undefined ? undefined : canonicalIanaTimeZone(patch.timeZone);
    return {
      ...patch,
      ...(patch.baselineWeightKg === undefined
        ? {}
        : { baselineWeightKg: measurement(patch.baselineWeightKg, "baselineWeightKg", 1, 1000) }),
      ...(patch.birthDate === undefined ? {} : { birthDate: birthDate(patch.birthDate, now) }),
      ...(patch.displayName === undefined ? {} : { displayName: displayName || null }),
      ...(patch.heightCm === undefined
        ? {}
        : { heightCm: measurement(patch.heightCm, "heightCm", 30, 300) }),
      ...(locale === undefined ? {} : { locale }),
      ...(timeZone === undefined ? {} : { timeZone }),
    };
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new RangeError("Profile patch is invalid");
  }
}
