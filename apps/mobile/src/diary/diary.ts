export const mealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
export const DIARY_PAGE_SIZE = 20;
export const DIARY_DAY_MAX_ENTRIES = 50;
export const DIARY_CURSOR_MAX_LENGTH = 512;
export type MealSlot = (typeof mealSlots)[number];
export type NutrientCompleteness = "complete" | "partial" | "unknown";

export interface DiaryGroup {
  readonly mealSlot: MealSlot;
  readonly label: string;
}

export const defaultDiaryGroups: readonly DiaryGroup[] = [
  { mealSlot: "breakfast", label: "Breakfast" },
  { mealSlot: "lunch", label: "Lunch" },
  { mealSlot: "dinner", label: "Dinner" },
  { mealSlot: "snacks", label: "Snacks" },
];

export const MAX_DIARY_GROUP_LABEL_LENGTH = 40;
export const MAX_DIARY_GROUP_LABEL_BYTES = 120;

export interface ProfileSummary {
  readonly displayName: string | null;
  readonly locale: string;
  readonly timeZone: string;
  readonly unitSystem: string;
  readonly revision: string;
  readonly diaryGroups: readonly DiaryGroup[];
  readonly [field: string]: unknown;
}

export interface SessionSummary {
  readonly user: { readonly id: string; readonly email: string; readonly emailVerified: boolean };
  readonly profile: ProfileSummary;
  readonly expiresAt?: string;
}

export interface ProfileSessionUpdate {
  readonly initiatingSessionEpoch: number;
  readonly initiatingUserId: string;
  readonly profile: ProfileSummary;
}

function comparableRevision(value: string): string {
  if (!/^\d+$/u.test(value)) throw new TypeError("The profile revision was invalid.");
  return value.replace(/^0+(?=\d)/u, "");
}

/** Compare parsed decimal revisions without narrowing them through JavaScript numbers. */
export function profileRevisionIsOlder(candidate: string, current: string): boolean {
  const candidateRevision = comparableRevision(candidate);
  const currentRevision = comparableRevision(current);
  return (
    candidateRevision.length < currentRevision.length ||
    (candidateRevision.length === currentRevision.length && candidateRevision < currentRevision)
  );
}

export function acceptProfileSessionUpdate(
  currentSession: SessionSummary | null,
  currentSessionEpoch: number,
  update: ProfileSessionUpdate,
): SessionSummary | null {
  if (
    currentSessionEpoch !== update.initiatingSessionEpoch ||
    currentSession?.user.id !== update.initiatingUserId ||
    profileRevisionIsOlder(update.profile.revision, currentSession.profile.revision)
  ) {
    return currentSession;
  }
  return { ...currentSession, profile: update.profile };
}

export function profileRequestIdentityMatches(
  currentOwnerUserId: string,
  currentSessionEpoch: number,
  initiatingOwnerUserId: string,
  initiatingSessionEpoch: number,
): boolean {
  return (
    currentOwnerUserId === initiatingOwnerUserId && currentSessionEpoch === initiatingSessionEpoch
  );
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

export interface DiarySource {
  readonly code: string;
  readonly releaseId: string;
  readonly displayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
}

interface DiaryEntryCommon {
  readonly id: string;
  readonly revision: string;
  readonly mealSlot: MealSlot;
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly localTime: string;
  readonly position: number;
  readonly nutrients: readonly DiaryNutrient[];
  /** Private owner-authored text, returned exactly as entered. */
  readonly note: string | null;
}

interface DiaryFoodEntryCommon extends DiaryEntryCommon {
  readonly entryKind: "food";
  readonly foodVersionId: string;
  readonly recipeVersionId: null;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
        readonly servingLabel: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly food: { readonly name: string; readonly brandName: string | null };
  readonly recipe: null;
}

export interface DiaryPublicFoodEntry extends DiaryFoodEntryCommon {
  readonly source: DiarySource;
  readonly foodProvenance: { readonly kind: "public"; readonly source: DiarySource };
}

export interface DiaryPrivateCustomFoodEntry extends DiaryFoodEntryCommon {
  readonly source: null;
  readonly foodProvenance: {
    readonly kind: "private_custom";
    readonly customFoodId: string;
    readonly customFoodVersionNumber: number;
  };
}

export type DiaryFoodEntry = DiaryPublicFoodEntry | DiaryPrivateCustomFoodEntry;

export interface DiaryRecipeEntry extends DiaryEntryCommon {
  readonly entryKind: "recipe";
  readonly foodVersionId: null;
  readonly recipeVersionId: string;
  readonly portion:
    | { readonly kind: "serving"; readonly amount: string; readonly servingLabel: string }
    | { readonly kind: "grams"; readonly grams: string };
  readonly food: null;
  readonly source: null;
  readonly sources: readonly DiarySource[];
  readonly recipe: {
    readonly id: string;
    readonly name: string;
    readonly versionNumber: number;
    readonly yieldGrams: string;
    readonly yieldSource: "measured" | "estimated";
    readonly servingCount: string | null;
    readonly servingLabel: string | null;
    readonly calculationVersion: string;
    readonly retentionPolicy: {
      readonly code: "identity-retention-default";
      readonly version: "1";
      readonly assumption: string;
    };
    readonly warnings: readonly {
      readonly code: string;
      readonly message: string;
      readonly nutrientIds: readonly string[];
    }[];
  };
}

export type DiaryEntry = DiaryFoodEntry | DiaryRecipeEntry;

export interface DiaryDay {
  readonly id: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly status: "open" | "locked";
  readonly revision: string;
  readonly orderDigest: string;
  readonly entries: readonly DiaryEntry[];
  readonly totals: readonly DiaryNutrient[];
  readonly updatedAt: string | null;
}

export interface DiaryPageMetadata {
  readonly nextCursor: string | null;
  readonly totalEntries: number;
}

export interface DiaryPage {
  readonly data: DiaryDay;
  readonly page: DiaryPageMetadata;
  readonly legacy: boolean;
}

export interface DiaryEditorOrigin {
  readonly entryId: string;
  readonly originEntryRevision: string;
  readonly originLocalDate: string;
  readonly originTimeZone: string;
  readonly originDayRevision: string;
}

export interface DiaryUnauthorizedSingleFlight {
  readonly run: (action: () => Promise<void>) => Promise<void>;
}

export interface DiaryMutationResult {
  readonly replayed: boolean;
  readonly entry: DiaryEntry | null;
  readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
}

export type DiaryOrderCanonicalGroups = readonly (readonly [
  MealSlot,
  readonly (readonly [string, string, number])[],
])[];

export interface DiaryReorderPlan {
  readonly groups: Readonly<Record<MealSlot, readonly number[]>>;
  readonly baselineCanonicalGroups: DiaryOrderCanonicalGroups;
  readonly resultCanonicalGroups: DiaryOrderCanonicalGroups;
}

export interface DiaryReorderDigestEvidence {
  readonly expectedOrderDigest: string;
  readonly expectedResultOrderDigest: string;
}

export class DiaryOrderBaselineMismatchError extends TypeError {
  constructor() {
    super("The diary order digest did not match the complete loaded day.");
    this.name = "DiaryOrderBaselineMismatchError";
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const API_POSITIVE_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;
const API_RESOLVED_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,17})(?:\.[0-9]+)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.\d{1,9})?)?$/u;
export const MAX_DIARY_NOTE_LENGTH = 2_000;
const MAX_LEGACY_DIARY_NOTE_LENGTH = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 1_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function aggregateOutputDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && DECIMAL.test(value);
}

function positiveApiDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && API_POSITIVE_DECIMAL.test(value);
}

function positiveResolvedDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && API_RESOLVED_DECIMAL.test(value);
}

function isMeal(value: unknown): value is MealSlot {
  return mealSlots.some((meal) => meal === value);
}

function isWellFormedUnicode(value: string): boolean {
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
    const codePoint = scalar.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function normalizeDiaryGroupLabel(value: string): string {
  if (!isWellFormedUnicode(value)) {
    throw new TypeError("Diary group names must be valid Unicode text.");
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new RangeError("Every diary group needs a name.");
  if (/\p{Cc}|\p{Cf}/u.test(normalized)) {
    throw new TypeError("Diary group names cannot contain control or formatting characters.");
  }
  if ([...normalized].length > MAX_DIARY_GROUP_LABEL_LENGTH) {
    throw new RangeError(
      `Diary group names cannot exceed ${MAX_DIARY_GROUP_LABEL_LENGTH} characters.`,
    );
  }
  if (utf8ByteLength(normalized) > MAX_DIARY_GROUP_LABEL_BYTES) {
    throw new RangeError(`Diary group names cannot exceed ${MAX_DIARY_GROUP_LABEL_BYTES} bytes.`);
  }
  return normalized;
}

export function normalizeDiaryGroups(groups: readonly DiaryGroup[]): readonly DiaryGroup[] {
  if (groups.length !== mealSlots.length) {
    throw new RangeError("Exactly four diary groups are required.");
  }
  const seenSlots = new Set<MealSlot>();
  const seenLabels = new Set<string>();
  const normalized = groups.map((group) => {
    if (!isMeal(group.mealSlot) || seenSlots.has(group.mealSlot)) {
      throw new TypeError("Every canonical diary group must appear exactly once.");
    }
    const label = normalizeDiaryGroupLabel(group.label);
    const folded = label.toLowerCase();
    if (seenLabels.has(folded)) {
      throw new RangeError("Diary group names must be unique.");
    }
    seenSlots.add(group.mealSlot);
    seenLabels.add(folded);
    return { mealSlot: group.mealSlot, label };
  });
  return normalized;
}

export function parseDiaryGroups(value: unknown): readonly DiaryGroup[] {
  if (!Array.isArray(value) || value.length !== mealSlots.length) {
    throw new TypeError("The diary group response was invalid.");
  }
  const groups = value.map((item) => {
    if (
      !record(item) ||
      Object.keys(item).length !== 2 ||
      !("mealSlot" in item) ||
      !("label" in item) ||
      !isMeal(item.mealSlot) ||
      typeof item.label !== "string"
    ) {
      throw new TypeError("The diary group response was invalid.");
    }
    return { mealSlot: item.mealSlot, label: item.label };
  });
  try {
    const normalized = normalizeDiaryGroups(groups);
    if (normalized.some((group, index) => group.label !== groups[index]?.label)) {
      throw new TypeError("The diary group response was not normalized.");
    }
    return normalized;
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "The diary group response was not normalized."
    ) {
      throw error;
    }
    throw new TypeError("The diary group response was invalid.");
  }
}

export function diaryGroupLabel(groups: readonly DiaryGroup[], mealSlot: MealSlot): string {
  return groups.find((group) => group.mealSlot === mealSlot)?.label ?? mealLabel(mealSlot);
}

export function moveDiaryGroup(
  groups: readonly DiaryGroup[],
  mealSlot: MealSlot,
  direction: -1 | 1,
): readonly DiaryGroup[] {
  const index = groups.findIndex((group) => group.mealSlot === mealSlot);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= groups.length) return groups;
  const next = [...groups];
  const current = next[index];
  const adjacent = next[destination];
  if (!current || !adjacent) return groups;
  next[index] = adjacent;
  next[destination] = current;
  return next;
}

export function resetDiaryGroups(): readonly DiaryGroup[] {
  return defaultDiaryGroups.map((group) => ({ ...group }));
}

/** Preserve note bytes exactly; an empty draft is the explicit clear operation. */
export function diaryNoteFromDraft(value: string): string | null {
  if (value.length === 0) return null;
  if (value.includes("\u0000") || !isWellFormedUnicode(value)) {
    throw new TypeError("A private diary note must be valid Unicode text without U+0000.");
  }
  if ([...value].length > MAX_DIARY_NOTE_LENGTH) {
    throw new RangeError("A private diary note cannot exceed 2,000 characters.");
  }
  return value;
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

export function parseDiaryNutrient(value: unknown): DiaryNutrient {
  if (
    !record(value) ||
    !text(value.nutrientId, 64) ||
    !text(value.code, 100) ||
    !text(value.name, 200) ||
    !text(value.unit, 32) ||
    !aggregateOutputDecimal(value.knownAmount) ||
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

function exactEntryKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function hasOwnNote(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "note");
}

function exactEntryKeysWithOptionalNote(
  value: Record<string, unknown>,
  expectedWithoutNote: readonly string[],
): boolean {
  return exactEntryKeys(
    value,
    hasOwnNote(value) ? [...expectedWithoutNote, "note"] : expectedWithoutNote,
  );
}

/** Tolerate legacy or optional responses without a populated note; new writes remain capped. */
function parseDiaryResponseNote(value: Record<string, unknown>): string | null {
  if (!hasOwnNote(value) || value.note === null) return null;
  if (
    typeof value.note !== "string" ||
    [...value.note].length > MAX_LEGACY_DIARY_NOTE_LENGTH ||
    value.note.includes("\u0000") ||
    !isWellFormedUnicode(value.note)
  ) {
    throw new TypeError("A diary entry note was invalid.");
  }
  return value.note.length === 0 ? null : value.note;
}

function parseSource(value: unknown): DiarySource {
  if (
    !record(value) ||
    !exactEntryKeys(value, [
      "code",
      "releaseId",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
    ]) ||
    !(typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/u.test(value.code)) ||
    !(typeof value.releaseId === "string" && UUID.test(value.releaseId)) ||
    !text(value.displayName, 200) ||
    !text(value.licenseExpression, 256) ||
    typeof value.attributionRequired !== "boolean" ||
    !text(value.attributionText, 2_000)
  )
    throw new TypeError("Diary source provenance was invalid.");
  return {
    code: value.code,
    releaseId: value.releaseId,
    displayName: value.displayName,
    licenseExpression: value.licenseExpression,
    attributionRequired: value.attributionRequired,
    attributionText: value.attributionText,
  };
}

function parseFoodPortion(value: unknown): DiaryFoodEntry["portion"] {
  if (!record(value)) throw new TypeError("A diary portion was invalid.");
  if (
    value.kind === "serving" &&
    exactEntryKeys(value, ["kind", "servingId", "amount", "servingLabel"]) &&
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
  if (
    value.kind === "grams" &&
    exactEntryKeys(value, ["kind", "grams"]) &&
    positiveApiDecimal(value.grams)
  )
    return { kind: "grams", grams: value.grams };
  throw new TypeError("A diary portion was invalid.");
}

function parseRecipePortion(value: unknown): DiaryRecipeEntry["portion"] {
  if (!record(value)) throw new TypeError("A recipe diary portion was invalid.");
  if (
    value.kind === "serving" &&
    exactEntryKeys(value, ["kind", "amount", "servingLabel"]) &&
    positiveApiDecimal(value.amount) &&
    text(value.servingLabel, 100)
  )
    return { kind: "serving", amount: value.amount, servingLabel: value.servingLabel };
  if (
    value.kind === "grams" &&
    exactEntryKeys(value, ["kind", "grams"]) &&
    positiveApiDecimal(value.grams)
  )
    return { kind: "grams", grams: value.grams };
  throw new TypeError("A recipe diary portion was invalid.");
}

function parseRecipeSnapshot(value: unknown): DiaryRecipeEntry["recipe"] {
  const warningCodes = new Set([
    "ESTIMATED_YIELD",
    "PARTIAL_NUTRIENT_DATA",
    "RETENTION_FACTORS_DEFAULTED",
    "YIELD_ABOVE_INPUT_MASS",
    "YIELD_BELOW_HALF_INPUT_MASS",
  ]);
  if (
    !record(value) ||
    !exactEntryKeys(value, [
      "id",
      "name",
      "versionNumber",
      "yieldGrams",
      "yieldSource",
      "servingCount",
      "servingLabel",
      "calculationVersion",
      "retentionPolicy",
      "warnings",
    ]) ||
    !(typeof value.id === "string" && UUID.test(value.id)) ||
    !text(value.name, 200) ||
    !Number.isSafeInteger(value.versionNumber) ||
    Number(value.versionNumber) < 1 ||
    !positiveResolvedDecimal(value.yieldGrams) ||
    !["measured", "estimated"].includes(String(value.yieldSource)) ||
    !(value.servingCount === null || positiveApiDecimal(value.servingCount)) ||
    !(value.servingLabel === null || text(value.servingLabel, 100)) ||
    (value.servingCount === null) !== (value.servingLabel === null) ||
    !text(value.calculationVersion, 100) ||
    !record(value.retentionPolicy) ||
    !exactEntryKeys(value.retentionPolicy, ["code", "version", "assumption"]) ||
    value.retentionPolicy.code !== "identity-retention-default" ||
    value.retentionPolicy.version !== "1" ||
    !text(value.retentionPolicy.assumption, 500) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 5 ||
    !value.warnings.every(
      (warning) =>
        record(warning) &&
        exactEntryKeys(warning, ["code", "message", "nutrientIds"]) &&
        typeof warning.code === "string" &&
        warningCodes.has(warning.code) &&
        text(warning.message, 500) &&
        Array.isArray(warning.nutrientIds) &&
        warning.nutrientIds.length <= 256 &&
        warning.nutrientIds.every((id) => typeof id === "string" && /^[1-9][0-9]{0,19}$/u.test(id)),
    )
  )
    throw new TypeError("A recipe diary snapshot was invalid.");
  return value as unknown as DiaryRecipeEntry["recipe"];
}

function parseEntry(value: unknown): DiaryEntry {
  if (
    !record(value) ||
    !text(value.id, 64) ||
    !/^[1-9]\d*$/u.test(String(value.revision)) ||
    !isMeal(value.mealSlot) ||
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
  const note = parseDiaryResponseNote(value);
  const common = {
    id: value.id,
    revision: String(value.revision),
    mealSlot: value.mealSlot,
    resolvedGrams: value.resolvedGrams,
    occurredAt: value.occurredAt,
    localDate: value.localDate,
    timeZone: value.timeZone,
    localTime: value.localTime,
    position: Number(value.position),
    nutrients: value.nutrients.map(parseDiaryNutrient),
    note,
  };
  if (
    value.entryKind === "food" &&
    exactEntryKeysWithOptionalNote(value, [
      "id",
      "revision",
      "entryKind",
      "foodVersionId",
      "recipeVersionId",
      "portion",
      "food",
      "recipe",
      "source",
      "foodProvenance",
      "mealSlot",
      "resolvedGrams",
      "occurredAt",
      "localDate",
      "localTime",
      "timeZone",
      "position",
      "nutrients",
    ]) &&
    typeof value.foodVersionId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value.foodVersionId) &&
    value.recipeVersionId === null &&
    record(value.food) &&
    exactEntryKeys(value.food, ["name", "brandName"]) &&
    text(value.food.name, 500) &&
    (value.food.brandName === null || text(value.food.brandName, 300)) &&
    value.recipe === null
  ) {
    const entry = {
      ...common,
      entryKind: "food" as const,
      foodVersionId: value.foodVersionId,
      recipeVersionId: null,
      portion: parseFoodPortion(value.portion),
      food: { name: value.food.name, brandName: value.food.brandName },
      recipe: null,
    };
    if (value.source === null) {
      if (
        !record(value.foodProvenance) ||
        !exactEntryKeys(value.foodProvenance, [
          "kind",
          "customFoodId",
          "customFoodVersionNumber",
        ]) ||
        value.foodProvenance.kind !== "private_custom" ||
        !(
          typeof value.foodProvenance.customFoodId === "string" &&
          UUID.test(value.foodProvenance.customFoodId)
        ) ||
        !Number.isSafeInteger(value.foodProvenance.customFoodVersionNumber) ||
        Number(value.foodProvenance.customFoodVersionNumber) < 1
      )
        throw new TypeError("Private custom-food provenance was invalid.");
      return {
        ...entry,
        source: null,
        foodProvenance: {
          kind: "private_custom",
          customFoodId: value.foodProvenance.customFoodId,
          customFoodVersionNumber: Number(value.foodProvenance.customFoodVersionNumber),
        },
      };
    }
    const source = parseSource(value.source);
    if (
      !record(value.foodProvenance) ||
      !exactEntryKeys(value.foodProvenance, ["kind", "source"]) ||
      value.foodProvenance.kind !== "public" ||
      JSON.stringify(parseSource(value.foodProvenance.source)) !== JSON.stringify(source)
    )
      throw new TypeError("Public food provenance was invalid.");
    return { ...entry, source, foodProvenance: { kind: "public", source } };
  }
  if (
    value.entryKind === "recipe" &&
    exactEntryKeysWithOptionalNote(value, [
      "id",
      "revision",
      "entryKind",
      "foodVersionId",
      "recipeVersionId",
      "portion",
      "food",
      "recipe",
      "sources",
      "source",
      "mealSlot",
      "resolvedGrams",
      "occurredAt",
      "localDate",
      "localTime",
      "timeZone",
      "position",
      "nutrients",
    ]) &&
    value.foodVersionId === null &&
    typeof value.recipeVersionId === "string" &&
    UUID.test(value.recipeVersionId) &&
    value.food === null &&
    value.source === null &&
    Array.isArray(value.sources) &&
    value.sources.length >= 1 &&
    value.sources.length <= 256
  ) {
    const sources = value.sources.map(parseSource);
    if (
      new Set(sources.map((source) => `${source.code}\u0000${source.releaseId}`)).size !==
      sources.length
    )
      throw new TypeError("Recipe diary sources were duplicated.");
    return {
      ...common,
      entryKind: "recipe",
      foodVersionId: null,
      recipeVersionId: value.recipeVersionId,
      portion: parseRecipePortion(value.portion),
      food: null,
      recipe: parseRecipeSnapshot(value.recipe),
      sources,
      source: null,
    };
  }
  throw new TypeError("A diary entry discriminant was invalid.");
}

export function parseProfile(value: unknown): ProfileSummary {
  if (
    !record(value) ||
    !text(value.locale, 35) ||
    !text(value.timeZone, 63) ||
    !text(value.unitSystem, 30) ||
    !/^\d+$/u.test(String(value.revision)) ||
    !(value.displayName === null || text(value.displayName, 100))
  )
    throw new TypeError("The profile response was invalid.");
  const diaryGroups = Object.hasOwn(value, "diaryGroups")
    ? parseDiaryGroups(value.diaryGroups)
    : resetDiaryGroups();
  return {
    ...value,
    displayName: value.displayName,
    locale: value.locale,
    timeZone: value.timeZone,
    unitSystem: value.unitSystem,
    revision: String(value.revision),
    diaryGroups,
  };
}

export function parseProfileResponse(value: unknown): ProfileSummary {
  if (!record(value) || !record(value.data) || !record(value.data.profile)) {
    throw new TypeError("The profile response was invalid.");
  }
  return parseProfile(value.data.profile);
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
    !(value.data.expiresAt === undefined || text(value.data.expiresAt, 64))
  )
    throw new TypeError("The session response was invalid.");
  let profile: ProfileSummary;
  try {
    profile = parseProfile(value.data.profile);
  } catch {
    throw new TypeError("The session response was invalid.");
  }
  return {
    user: {
      id: value.data.user.id,
      email: value.data.user.email,
      emailVerified: value.data.user.emailVerified,
    },
    profile,
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
    typeof value.data.orderDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.data.orderDigest) ||
    !Array.isArray(value.data.entries) ||
    value.data.entries.length > DIARY_DAY_MAX_ENTRIES ||
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
    orderDigest: value.data.orderDigest,
    entries: value.data.entries.map(parseEntry),
    totals: value.data.totals.map(parseDiaryNutrient),
    updatedAt: value.data.updatedAt,
  };
}

function cursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DIARY_CURSOR_MAX_LENGTH &&
    /^d1\.[A-Za-z0-9_-]+$/u.test(value)
  );
}

function uniqueEntryIds(entries: readonly DiaryEntry[]): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length;
}

function completePageShape(page: DiaryPage): boolean {
  const loaded = page.data.entries.length;
  return (
    uniqueEntryIds(page.data.entries) &&
    loaded <= page.page.totalEntries &&
    page.page.totalEntries <= DIARY_DAY_MAX_ENTRIES &&
    (page.page.nextCursor === null
      ? loaded === page.page.totalEntries
      : loaded > 0 && loaded < page.page.totalEntries)
  );
}

export function parseDiaryPage(value: unknown): DiaryPage {
  const data = parseDiaryDay(value);
  if (!record(value) || !("page" in value)) {
    if (!record(value) || Object.keys(value).length !== 1 || !("data" in value)) {
      throw new TypeError("The legacy diary response was invalid.");
    }
    const legacy = {
      data,
      page: { nextCursor: null, totalEntries: data.entries.length },
      legacy: true,
    } satisfies DiaryPage;
    if (!completePageShape(legacy)) throw new TypeError("The diary response was invalid.");
    return legacy;
  }
  if (
    Object.keys(value).some((key) => key !== "data" && key !== "page") ||
    !record(value.page) ||
    Object.keys(value.page).some((key) => key !== "nextCursor" && key !== "totalEntries") ||
    !(value.page.nextCursor === null || cursor(value.page.nextCursor)) ||
    !Number.isSafeInteger(value.page.totalEntries) ||
    Number(value.page.totalEntries) < 0 ||
    Number(value.page.totalEntries) > DIARY_DAY_MAX_ENTRIES ||
    data.entries.length > DIARY_PAGE_SIZE ||
    data.entries.length > Number(value.page.totalEntries) ||
    (value.page.nextCursor !== null && data.entries.length === 0) ||
    !uniqueEntryIds(data.entries)
  ) {
    throw new TypeError("The diary page response was invalid.");
  }
  return {
    data,
    page: {
      nextCursor: value.page.nextCursor,
      totalEntries: Number(value.page.totalEntries),
    },
    legacy: false,
  };
}

function sameTotals(left: readonly DiaryNutrient[], right: readonly DiaryNutrient[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeDiaryPages(current: DiaryPage | null, incoming: DiaryPage): DiaryPage {
  if (current === null) {
    if (!completePageShape(incoming)) {
      throw new TypeError("The first diary page was incomplete or inconsistent.");
    }
    return incoming;
  }
  if (
    current.page.nextCursor === null ||
    current.data.id !== incoming.data.id ||
    current.data.localDate !== incoming.data.localDate ||
    current.data.timeZone !== incoming.data.timeZone ||
    current.data.status !== incoming.data.status ||
    current.data.revision !== incoming.data.revision ||
    current.data.orderDigest !== incoming.data.orderDigest ||
    current.data.updatedAt !== incoming.data.updatedAt ||
    current.page.totalEntries !== incoming.page.totalEntries ||
    !sameTotals(current.data.totals, incoming.data.totals) ||
    incoming.legacy ||
    (incoming.data.entries.length === 0 && incoming.page.nextCursor !== null)
  ) {
    throw new TypeError("The diary pages did not describe the same day snapshot.");
  }
  const entries = [...current.data.entries, ...incoming.data.entries];
  const merged: DiaryPage = {
    data: { ...current.data, entries },
    page: incoming.page,
    legacy: false,
  };
  if (!completePageShape(merged)) {
    throw new TypeError("The diary pages overlapped or exceeded the day total.");
  }
  return merged;
}

export function diaryPagePath(localDate: string, nextCursor?: string | null): string {
  if (!isLocalDate(localDate) || (nextCursor != null && !cursor(nextCursor))) {
    throw new TypeError("The diary page request was invalid.");
  }
  const query = new URLSearchParams({ date: localDate, limit: String(DIARY_PAGE_SIZE) });
  if (nextCursor != null) query.set("cursor", nextCursor);
  return `/v1/diary?${query.toString()}`;
}

function incrementDecimalRevision(value: string): string {
  if (!/^[1-9]\d*$/u.test(value)) throw new TypeError("The diary entry revision was invalid.");
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = Number(digits[index]) + carry;
    digits[index] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }
  if (carry === 1) digits.unshift("1");
  return digits.join("");
}

function canonicalMealEntries(day: DiaryDay, mealSlot: MealSlot): readonly DiaryEntry[] {
  return day.entries
    .filter((entry) => entry.mealSlot === mealSlot)
    .sort((left, right) => {
      const leftOccurredAt = Date.parse(left.occurredAt);
      const rightOccurredAt = Date.parse(right.occurredAt);
      if (!Number.isFinite(leftOccurredAt) || !Number.isFinite(rightOccurredAt)) {
        throw new TypeError("A diary entry occurrence instant was invalid.");
      }
      return (
        left.position - right.position ||
        leftOccurredAt - rightOccurredAt ||
        left.id.localeCompare(right.id)
      );
    });
}

export function buildDiaryReorderPlan(
  day: DiaryDay,
  entryId: string,
  direction: "up" | "down",
): DiaryReorderPlan | null {
  const selected = day.entries.find((entry) => entry.id === entryId);
  if (!selected) return null;
  const baselineBySlot = Object.fromEntries(
    mealSlots.map((slot) => [slot, canonicalMealEntries(day, slot)]),
  ) as Record<MealSlot, readonly DiaryEntry[]>;
  const baseline = baselineBySlot[selected.mealSlot];
  const from = baseline.findIndex((entry) => entry.id === entryId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= baseline.length) return null;
  const desiredBySlot: Record<MealSlot, readonly DiaryEntry[]> = { ...baselineBySlot };
  const desired = [...baseline];
  const fromEntry = desired[from];
  const toEntry = desired[to];
  if (!fromEntry || !toEntry) return null;
  desired[from] = toEntry;
  desired[to] = fromEntry;
  desiredBySlot[selected.mealSlot] = desired;
  const permutation = (slot: MealSlot): readonly number[] => {
    const baselineIndex = new Map(
      baselineBySlot[slot].map((entry, index) => [entry.id, index] as const),
    );
    return desiredBySlot[slot].map((entry) => {
      const index = baselineIndex.get(entry.id);
      if (index === undefined) throw new TypeError("The diary reorder baseline was inconsistent.");
      return index;
    });
  };
  const groups: Readonly<Record<MealSlot, readonly number[]>> = {
    breakfast: permutation("breakfast"),
    lunch: permutation("lunch"),
    dinner: permutation("dinner"),
    snacks: permutation("snacks"),
  };
  const baselineCanonicalGroups = mealSlots.map(
    (slot) =>
      [
        slot,
        baselineBySlot[slot].map((entry) => [entry.id, entry.revision, entry.position] as const),
      ] as const,
  );
  const resultCanonicalGroups = mealSlots.map(
    (slot) =>
      [
        slot,
        desiredBySlot[slot].map(
          (entry, position) =>
            [
              entry.id,
              entry.position === position
                ? entry.revision
                : incrementDecimalRevision(entry.revision),
              position,
            ] as const,
        ),
      ] as const,
  );
  return { groups, baselineCanonicalGroups, resultCanonicalGroups };
}

export function diaryOrderDigestPayload(
  localDate: string,
  timeZone: string,
  canonicalGroups: DiaryOrderCanonicalGroups,
): string {
  if (!isLocalDate(localDate) || !isSupportedTimeZone(timeZone)) {
    throw new TypeError("The diary order digest coordinates were invalid.");
  }
  return JSON.stringify(["diary-day-order-v1", localDate, timeZone, canonicalGroups]);
}

/** Bind a compact move to both sides of the authoritative full-day order transition. */
export async function bindDiaryReorderDigestEvidence(
  day: DiaryDay,
  plan: DiaryReorderPlan,
  digest: (payload: string) => Promise<string>,
): Promise<DiaryReorderDigestEvidence> {
  const [computedExpectedOrderDigest, expectedResultOrderDigest] = await Promise.all([
    digest(diaryOrderDigestPayload(day.localDate, day.timeZone, plan.baselineCanonicalGroups)),
    digest(diaryOrderDigestPayload(day.localDate, day.timeZone, plan.resultCanonicalGroups)),
  ]);
  if (
    !/^[0-9a-f]{64}$/u.test(computedExpectedOrderDigest) ||
    !/^[0-9a-f]{64}$/u.test(expectedResultOrderDigest)
  ) {
    throw new TypeError("The diary order digest function returned an invalid digest.");
  }
  if (computedExpectedOrderDigest !== day.orderDigest) {
    throw new DiaryOrderBaselineMismatchError();
  }
  return { expectedOrderDigest: day.orderDigest, expectedResultOrderDigest };
}

export function isDiaryPageStaleProblem(status: number, value: unknown): boolean {
  return status === 409 && record(value) && value.code === "DIARY_PAGE_STALE";
}

export function isProfileOwnerChangedProblem(status: number, value: unknown): boolean {
  return status === 409 && record(value) && value.code === "PROFILE_OWNER_CHANGED";
}

export function diaryEditorOrigin(
  day: DiaryDay,
  entry: DiaryEntry,
  currentProfileTimeZone: string,
): DiaryEditorOrigin {
  if (!isSupportedTimeZone(currentProfileTimeZone)) {
    throw new TypeError("The current profile time zone was invalid.");
  }
  return {
    entryId: entry.id,
    originEntryRevision: entry.revision,
    originLocalDate: day.localDate,
    originTimeZone: currentProfileTimeZone,
    originDayRevision: day.revision,
  };
}

export function diaryEditorOriginMatches(
  origin: DiaryEditorOrigin,
  day: DiaryDay,
  entry: DiaryEntry,
  currentProfileTimeZone: string,
): boolean {
  return (
    origin.entryId === entry.id &&
    origin.originEntryRevision === entry.revision &&
    origin.originLocalDate === day.localDate &&
    origin.originTimeZone === currentProfileTimeZone &&
    origin.originDayRevision === day.revision
  );
}

export function diaryEditorOperationKey(origin: DiaryEditorOrigin, body: object): string {
  return `edit:${origin.entryId}:${origin.originEntryRevision}:${origin.originDayRevision}:${JSON.stringify(body)}`;
}

export function diaryRouteTransitionGeneration(
  requestedDate: string | undefined,
  refreshKey: string | undefined,
): string | null {
  return requestedDate && isLocalDate(requestedDate)
    ? JSON.stringify([requestedDate, refreshKey ?? null])
    : null;
}

export function createDiaryUnauthorizedSingleFlight(): DiaryUnauthorizedSingleFlight {
  let pending: Promise<void> | null = null;
  return {
    run(action) {
      pending ??= Promise.resolve().then(action);
      return pending;
    },
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
