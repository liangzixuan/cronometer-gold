export const mealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
export type MealSlot = (typeof mealSlots)[number];
export type NutrientCompleteness = "complete" | "partial" | "unknown";

export interface ProfileSummary {
  readonly displayName: string | null;
  readonly locale: string;
  readonly timeZone: string;
  readonly unitSystem: string;
  readonly revision: string;
  readonly [field: string]: unknown;
}

export interface SessionSummary {
  readonly user: { readonly id: string; readonly email: string; readonly emailVerified: boolean };
  readonly profile: ProfileSummary;
  readonly expiresAt?: string;
}

export interface DiaryNutrient {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: NutrientCompleteness;
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasonCounts: {
    readonly not_reported: number;
    readonly not_analyzed: number;
    readonly not_applicable: number;
    readonly withheld: number;
  };
}

export interface DiaryEntry {
  readonly id: string;
  readonly revision: string;
  readonly foodVersionId: string;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
        readonly servingLabel: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly food: { readonly name: string; readonly brandName: string | null };
  readonly source: {
    readonly code: string;
    readonly releaseId: string;
    readonly displayName: string;
    readonly licenseExpression: string;
    readonly attributionRequired: boolean;
    readonly attributionText: string;
  };
  readonly mealSlot: MealSlot;
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly localTime: string;
  readonly position: number;
  readonly nutrients: readonly DiaryNutrient[];
}

export interface DiaryDay {
  readonly id: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly status: "open" | "locked";
  readonly revision: string;
  readonly entries: readonly DiaryEntry[];
  readonly totals: readonly DiaryNutrient[];
  readonly updatedAt: string | null;
}

export interface DiaryMutationResult {
  readonly replayed: boolean;
  readonly entry: DiaryEntry | null;
  readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const API_POSITIVE_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;
const API_RESOLVED_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.\d{1,9})?)?$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 1_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && DECIMAL.test(value);
}

function positiveApiDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && API_POSITIVE_DECIMAL.test(value);
}

function positiveResolvedDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 37 && API_RESOLVED_DECIMAL.test(value);
}

function isMeal(value: unknown): value is MealSlot {
  return mealSlots.some((meal) => meal === value);
}

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  if (Number(match[1]) < 1) return false;
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    check.getUTCFullYear() === Number(match[1]) &&
    check.getUTCMonth() === Number(match[2]) - 1 &&
    check.getUTCDate() === Number(match[3])
  );
}

export function isSupportedTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function currentLocalDate(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function currentLocalTime(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function shiftLocalDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days))
    throw new RangeError("Invalid local date.");
  const [year, month, day] = localDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function zonedParts(instant: Date, timeZone: string): readonly number[] {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  return [
    parts.get("year") ?? 0,
    parts.get("month") ?? 0,
    parts.get("day") ?? 0,
    parts.get("hour") ?? 0,
    parts.get("minute") ?? 0,
  ];
}

export function localDateInTimeZone(now: Date, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone)) throw new RangeError("Invalid diary time zone.");
  const [year, month, day] = zonedParts(now, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function localTimeInTimeZone(now: Date, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone)) throw new RangeError("Invalid diary time zone.");
  const values = zonedParts(now, timeZone);
  return `${String(values[3]).padStart(2, "0")}:${String(values[4]).padStart(2, "0")}`;
}

/** Preserve the real current instant, including the second DST fold occurrence. */
export function quickAddOccurredAt(localDate: string, timeZone: string, now = new Date()): string {
  return localDate === localDateInTimeZone(now, timeZone)
    ? now.toISOString()
    : localDateTimeToInstant(localDate, "12:00", timeZone);
}

export interface QuickAddOperation {
  readonly intentKey: string;
  readonly operationId: string;
  readonly body: {
    readonly foodVersionId: string;
    readonly portion: {
      readonly kind: "serving";
      readonly servingId: string;
      readonly amount: "1";
    };
    readonly mealSlot: MealSlot;
    readonly occurredAt: string;
  };
}

/** Retain both identity and bytes after an ambiguous response so retry cannot duplicate the entry. */
export function prepareQuickAddOperation(
  pendingByIntent: ReadonlyMap<string, QuickAddOperation>,
  input: {
    readonly foodVersionId: string;
    readonly servingId: string;
    readonly localDate: string;
    readonly mealSlot: MealSlot;
    readonly timeZone: string;
  },
  now: Date,
  operationIdFactory: () => string,
): QuickAddOperation {
  const intentKey = JSON.stringify([
    input.foodVersionId,
    input.servingId,
    input.localDate,
    input.mealSlot,
  ]);
  const pending = pendingByIntent.get(intentKey);
  if (pending) return pending;
  return {
    intentKey,
    operationId: operationIdFactory(),
    body: {
      foodVersionId: input.foodVersionId,
      portion: { kind: "serving", servingId: input.servingId, amount: "1" },
      mealSlot: input.mealSlot,
      occurredAt: quickAddOccurredAt(input.localDate, input.timeZone, now),
    },
  };
}

export function localDateTimeToInstant(
  localDate: string,
  localTime: string,
  timeZone: string,
): string {
  if (
    !isLocalDate(localDate) ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(localTime) ||
    !isSupportedTimeZone(timeZone)
  ) {
    throw new RangeError("Invalid local diary date, time, or time zone.");
  }
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const desiredParts = [year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0];
  const desired = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actualParts = zonedParts(new Date(candidate), timeZone);
    const actual = Date.UTC(
      actualParts[0] ?? 0,
      (actualParts[1] ?? 1) - 1,
      actualParts[2],
      actualParts[3],
      actualParts[4],
    );
    const delta = desired - actual;
    if (delta === 0) break;
    candidate += delta;
  }
  if (
    zonedParts(new Date(candidate), timeZone).some((part, index) => part !== desiredParts[index])
  ) {
    throw new RangeError("That local time does not exist in the diary time zone.");
  }
  return new Date(candidate).toISOString();
}

export function defaultMealForTime(now = new Date()): MealSlot {
  return defaultMealForHour(now.getHours());
}

export function defaultMealForHour(hour: number): MealSlot {
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snacks";
}

export function mealLabel(meal: MealSlot): string {
  return meal === "snacks" ? "Snacks" : `${meal[0]?.toUpperCase()}${meal.slice(1)}`;
}

export function isPositiveDecimal(value: string): boolean {
  return value.length <= 19 && API_POSITIVE_DECIMAL.test(value);
}

export function createOperationId(generator: () => string): string {
  const value = generator();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError("The secure UUID generator returned an invalid operation identifier.");
  }
  return value;
}

function parseNutrient(value: unknown): DiaryNutrient {
  if (
    !record(value) ||
    !text(value.nutrientId, 64) ||
    !text(value.code, 100) ||
    !text(value.name, 200) ||
    !text(value.unit, 32) ||
    !decimal(value.knownAmount) ||
    !["complete", "partial", "unknown"].includes(String(value.completeness)) ||
    typeof value.isExact !== "boolean" ||
    !Number.isSafeInteger(value.contributorCount) ||
    !Number.isSafeInteger(value.quantifiedCount) ||
    !Number.isSafeInteger(value.traceCount) ||
    !Number.isSafeInteger(value.unknownCount) ||
    Number(value.contributorCount) < 1 ||
    Number(value.quantifiedCount) < 0 ||
    Number(value.traceCount) < 0 ||
    Number(value.unknownCount) < 0 ||
    Number(value.quantifiedCount) + Number(value.traceCount) + Number(value.unknownCount) !==
      Number(value.contributorCount)
  )
    throw new TypeError("A diary nutrient was invalid.");
  const unknownReasonCounts = parseUnknownReasonCounts(value.unknownReasonCounts);
  const expectedCompleteness =
    Number(value.unknownCount) === 0
      ? "complete"
      : Number(value.unknownCount) === Number(value.contributorCount)
        ? "unknown"
        : "partial";
  if (
    Object.values(unknownReasonCounts).reduce((sum, count) => sum + count, 0) !==
      Number(value.unknownCount) ||
    value.completeness !== expectedCompleteness ||
    value.isExact !== (Number(value.traceCount) === 0 && Number(value.unknownCount) === 0)
  ) {
    throw new TypeError("Diary nutrient completeness was inconsistent.");
  }
  return {
    nutrientId: value.nutrientId,
    code: value.code,
    name: value.name,
    unit: value.unit,
    knownAmount: value.knownAmount,
    completeness: value.completeness as NutrientCompleteness,
    isExact: value.isExact,
    contributorCount: Number(value.contributorCount),
    quantifiedCount: Number(value.quantifiedCount),
    traceCount: Number(value.traceCount),
    unknownCount: Number(value.unknownCount),
    unknownReasonCounts,
  };
}

function parseUnknownReasonCounts(value: unknown): DiaryNutrient["unknownReasonCounts"] {
  const reasons = ["not_reported", "not_analyzed", "not_applicable", "withheld"] as const;
  if (
    !record(value) ||
    Object.keys(value).length !== reasons.length ||
    !reasons.every((reason) => Number.isSafeInteger(value[reason]) && Number(value[reason]) >= 0)
  ) {
    throw new TypeError("Diary unknown-reason counts were invalid.");
  }
  return {
    not_reported: Number(value.not_reported),
    not_analyzed: Number(value.not_analyzed),
    not_applicable: Number(value.not_applicable),
    withheld: Number(value.withheld),
  };
}

function parsePortion(value: unknown): DiaryEntry["portion"] {
  if (!record(value)) throw new TypeError("A diary portion was invalid.");
  if (
    value.kind === "serving" &&
    typeof value.servingId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value.servingId) &&
    positiveApiDecimal(value.amount) &&
    text(value.servingLabel, 300)
  )
    return {
      kind: "serving",
      servingId: value.servingId,
      amount: value.amount,
      servingLabel: value.servingLabel,
    };
  if (value.kind === "grams" && positiveApiDecimal(value.grams))
    return { kind: "grams", grams: value.grams };
  throw new TypeError("A diary portion was invalid.");
}

function parseEntry(value: unknown): DiaryEntry {
  if (
    !record(value) ||
    !text(value.id, 64) ||
    !/^[1-9]\d*$/u.test(String(value.revision)) ||
    !(typeof value.foodVersionId === "string" && /^[1-9][0-9]{0,19}$/u.test(value.foodVersionId)) ||
    !record(value.food) ||
    !text(value.food.name, 500) ||
    !(value.food.brandName === null || text(value.food.brandName, 300)) ||
    !isMeal(value.mealSlot) ||
    !record(value.source) ||
    !(typeof value.source.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/u.test(value.source.code)) ||
    !(typeof value.source.releaseId === "string" && UUID.test(value.source.releaseId)) ||
    !text(value.source.displayName, 200) ||
    !text(value.source.licenseExpression, 256) ||
    typeof value.source.attributionRequired !== "boolean" ||
    !text(value.source.attributionText, 2_000) ||
    !positiveResolvedDecimal(value.resolvedGrams) ||
    !text(value.occurredAt, 64) ||
    !isLocalDate(value.localDate) ||
    !text(value.timeZone, 63) ||
    typeof value.localTime !== "string" ||
    !TIME.test(value.localTime) ||
    !Number.isSafeInteger(value.position) ||
    !Array.isArray(value.nutrients) ||
    value.nutrients.length > 256
  )
    throw new TypeError("A diary entry was invalid.");
  const portion = parsePortion(value.portion);
  return {
    id: value.id,
    revision: String(value.revision),
    foodVersionId: value.foodVersionId,
    portion,
    food: { name: value.food.name, brandName: value.food.brandName },
    source: {
      code: value.source.code,
      releaseId: value.source.releaseId,
      displayName: value.source.displayName,
      licenseExpression: value.source.licenseExpression,
      attributionRequired: value.source.attributionRequired,
      attributionText: value.source.attributionText,
    },
    mealSlot: value.mealSlot,
    resolvedGrams: value.resolvedGrams,
    occurredAt: value.occurredAt,
    localDate: value.localDate,
    timeZone: value.timeZone,
    localTime: value.localTime,
    position: Number(value.position),
    nutrients: value.nutrients.map(parseNutrient),
  };
}

export function parseSession(value: unknown): SessionSummary {
  if (
    !record(value) ||
    !record(value.data) ||
    !record(value.data.user) ||
    !text(value.data.user.id, 64) ||
    !text(value.data.user.email, 254) ||
    typeof value.data.user.emailVerified !== "boolean" ||
    !record(value.data.profile) ||
    !text(value.data.profile.locale, 35) ||
    !text(value.data.profile.timeZone, 63) ||
    !text(value.data.profile.unitSystem, 30) ||
    !/^\d+$/u.test(String(value.data.profile.revision)) ||
    !(value.data.profile.displayName === null || text(value.data.profile.displayName, 100)) ||
    !(value.data.expiresAt === undefined || text(value.data.expiresAt, 64))
  )
    throw new TypeError("The session response was invalid.");
  return {
    user: {
      id: value.data.user.id,
      email: value.data.user.email,
      emailVerified: value.data.user.emailVerified,
    },
    profile: {
      ...value.data.profile,
      displayName: value.data.profile.displayName,
      locale: value.data.profile.locale,
      timeZone: value.data.profile.timeZone,
      unitSystem: value.data.profile.unitSystem,
      revision: String(value.data.profile.revision),
    },
    ...(typeof value.data.expiresAt === "string" ? { expiresAt: value.data.expiresAt } : {}),
  };
}

export function parseAuthResponse(value: unknown): {
  readonly session: SessionSummary;
  readonly accessToken: string;
  readonly expiresAt: string;
} {
  const session = parseSession(value);
  if (
    !record(value) ||
    !record(value.data) ||
    !(
      typeof value.data.accessToken === "string" &&
      /^[A-Za-z0-9_-]{43,128}$/u.test(value.data.accessToken)
    ) ||
    !text(value.data.expiresAt, 64)
  )
    throw new TypeError("The authentication response was invalid.");
  return { session, accessToken: value.data.accessToken, expiresAt: value.data.expiresAt };
}

export function parseDiaryDay(value: unknown): DiaryDay {
  if (
    !record(value) ||
    !record(value.data) ||
    !(value.data.id === null || text(value.data.id, 64)) ||
    !isLocalDate(value.data.localDate) ||
    !text(value.data.timeZone, 63) ||
    !["open", "locked"].includes(String(value.data.status)) ||
    !/^\d+$/u.test(String(value.data.revision)) ||
    !Array.isArray(value.data.entries) ||
    value.data.entries.length > 50 ||
    !Array.isArray(value.data.totals) ||
    value.data.totals.length > 256 ||
    !(value.data.updatedAt === null || text(value.data.updatedAt, 64))
  )
    throw new TypeError("The diary response was invalid.");
  return {
    id: value.data.id,
    localDate: value.data.localDate,
    timeZone: value.data.timeZone,
    status: value.data.status as "open" | "locked",
    revision: String(value.data.revision),
    entries: value.data.entries.map(parseEntry),
    totals: value.data.totals.map(parseNutrient),
    updatedAt: value.data.updatedAt,
  };
}

export function parseDiaryMutation(value: unknown): DiaryMutationResult {
  if (
    !record(value) ||
    !record(value.data) ||
    typeof value.data.replayed !== "boolean" ||
    !(value.data.entry === null || record(value.data.entry)) ||
    !Array.isArray(value.data.affectedDays) ||
    value.data.affectedDays.length < 1 ||
    value.data.affectedDays.length > 2
  )
    throw new TypeError("The diary mutation response was invalid.");
  const affectedDays = value.data.affectedDays.map((day) => {
    if (!record(day) || !isLocalDate(day.localDate) || !/^[1-9]\d*$/u.test(String(day.revision)))
      throw new TypeError("An affected diary day was invalid.");
    return { localDate: day.localDate, revision: String(day.revision) };
  });
  return {
    replayed: value.data.replayed,
    entry: value.data.entry === null ? null : parseEntry(value.data.entry),
    affectedDays,
  };
}

export function nutrientDisplay(nutrient: DiaryNutrient): {
  readonly amount: string;
  readonly qualification: string;
} {
  if (nutrient.completeness === "unknown")
    return {
      amount: "Unknown",
      qualification: `0/${nutrient.contributorCount} contributions quantified`,
    };
  if (nutrient.completeness === "partial")
    return {
      amount: `≥ ${nutrient.knownAmount} ${nutrient.unit}`,
      qualification: `Partial · ${nutrient.quantifiedCount}/${nutrient.contributorCount} quantified`,
    };
  if (nutrient.traceCount > 0 || !nutrient.isExact)
    return {
      amount: `≥ ${nutrient.knownAmount} ${nutrient.unit}`,
      qualification:
        nutrient.traceCount > 0
          ? "Complete coverage · includes trace values"
          : "Complete coverage · estimated",
    };
  return {
    amount: `${nutrient.knownAmount} ${nutrient.unit}`,
    qualification: "Complete coverage · quantified",
  };
}

export function entryEnergyDisplay(entry: DiaryEntry): string {
  const energy = entry.nutrients.find((nutrient) =>
    ["energy", "ENERGY", "ENERGY_KCAL", "CALORIES", "energy_kcal"].includes(nutrient.code),
  );
  return energy ? nutrientDisplay(energy).amount : "Energy unknown";
}
