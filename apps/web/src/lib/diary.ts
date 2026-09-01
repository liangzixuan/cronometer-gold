export const mealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
export const DIARY_PAGE_SIZE = 20;
export const DIARY_DAY_MAX_ENTRIES = 50;
export const DIARY_CURSOR_MAX_LENGTH = 512;

export type MealSlot = (typeof mealSlots)[number];
export type NutrientCompleteness = "complete" | "partial" | "unknown";

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface ProfileSummary {
  readonly displayName: string | null;
  readonly birthDate: string | null;
  readonly sexAtBirth: string | null;
  readonly heightCm: string | null;
  readonly baselineWeightKg: string | null;
  readonly activityLevelCode: string | null;
  readonly locale: string;
  readonly timeZone: string;
  readonly unitSystem: string;
  readonly onboardingCompletedAt: string | null;
  readonly revision: string;
}

export interface SessionSummary {
  readonly user: UserSummary;
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
  readonly note: string | null;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly localTime: string;
  readonly position: number;
  readonly nutrients: readonly DiaryNutrient[];
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

export interface DiaryMutationResult {
  readonly replayed: boolean;
  readonly entry: DiaryEntry | null;
  readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
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

export interface DiaryPageMetadata {
  readonly nextCursor: string | null;
  readonly totalEntries: number;
}

export interface DiaryPage {
  readonly data: DiaryDay;
  readonly page: DiaryPageMetadata;
  /** True only when an older full-day `{ data }` response was normalized locally. */
  readonly legacy: boolean;
}

export interface DiaryEditorOrigin {
  readonly entryId: string;
  readonly originEntryRevision: string;
  readonly originLocalDate: string;
  readonly originTimeZone: string;
  readonly originDayRevision: string;
}

export interface ProblemResponse {
  readonly code?: string;
  readonly detail?: string;
  readonly error?: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const API_POSITIVE_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;
const API_RESOLVED_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,17})(?:\.[0-9]+)?$/u;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.\d{1,9})?)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 1_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function nullableText(value: unknown, maximum = 1_000): value is string | null {
  return value === null || text(value, maximum);
}

export function diaryEntryNoteCharacterCount(value: string): number {
  return Array.from(value).length;
}

function legacyDiaryEntryNote(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      diaryEntryNoteCharacterCount(value) <= 10_000 &&
      !value.includes("\u0000") &&
      wellFormedUnicode(value))
  );
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function exactEntryKeysWithLegacyNote(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  if (exactEntryKeys(value, expected)) return true;
  return (
    !("note" in value) &&
    exactEntryKeys(
      value,
      expected.filter((key) => key !== "note"),
    )
  );
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && DECIMAL.test(value);
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

function nullableDecimal(value: unknown): value is string | null {
  return value === null || decimal(value);
}

function isMealSlot(value: unknown): value is MealSlot {
  return mealSlots.some((slot) => slot === value);
}

type RuntimeProfile = Omit<ProfileSummary, "revision"> & { readonly revision: string | number };

function isProfile(value: unknown): value is RuntimeProfile {
  return (
    record(value) &&
    nullableText(value.displayName, 100) &&
    (value.birthDate === null || isLocalDate(value.birthDate)) &&
    nullableText(value.sexAtBirth, 50) &&
    nullableDecimal(value.heightCm) &&
    nullableDecimal(value.baselineWeightKg) &&
    nullableText(value.activityLevelCode, 100) &&
    text(value.locale, 35) &&
    text(value.timeZone, 63) &&
    text(value.unitSystem, 30) &&
    (value.onboardingCompletedAt === null || text(value.onboardingCompletedAt, 64)) &&
    ((typeof value.revision === "string" && /^\d+$/u.test(value.revision)) ||
      (typeof value.revision === "number" && Number.isSafeInteger(value.revision)))
  );
}

function isUser(value: unknown): value is UserSummary {
  return (
    record(value) &&
    text(value.id, 64) &&
    text(value.email, 254) &&
    typeof value.emailVerified === "boolean"
  );
}

function normalizeProfile(value: RuntimeProfile) {
  return { ...value, revision: String(value.revision) } as ProfileSummary;
}

export function parseSession(value: unknown): SessionSummary {
  if (
    !record(value) ||
    !record(value.data) ||
    !isUser(value.data.user) ||
    !isProfile(value.data.profile)
  ) {
    throw new TypeError("The session response was invalid.");
  }
  if (value.data.expiresAt !== undefined && !text(value.data.expiresAt, 64)) {
    throw new TypeError("The session expiry was invalid.");
  }
  return {
    user: value.data.user,
    profile: normalizeProfile(value.data.profile),
    ...(typeof value.data.expiresAt === "string" ? { expiresAt: value.data.expiresAt } : {}),
  };
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
  ) {
    throw new TypeError("A diary nutrient was invalid.");
  }
  const unknownReasonCounts = parseUnknownReasonCounts(value.unknownReasonCounts);
  const expectedCompleteness =
    Number(value.unknownCount) === 0
      ? "complete"
      : Number(value.unknownCount) === Number(value.contributorCount)
        ? "unknown"
        : "partial";
  if (
    Object.values(unknownReasonCounts).reduce((total, count) => total + count, 0) !==
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
    !UUID.test(String(value.releaseId)) ||
    !text(value.displayName, 200) ||
    !text(value.licenseExpression, 256) ||
    typeof value.attributionRequired !== "boolean" ||
    !text(value.attributionText, 2_000)
  )
    throw new TypeError("Diary source provenance was invalid.");
  return {
    code: value.code,
    releaseId: String(value.releaseId),
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
  ) {
    return {
      kind: "serving",
      servingId: value.servingId,
      amount: value.amount,
      servingLabel: value.servingLabel,
    };
  }
  if (
    value.kind === "grams" &&
    exactEntryKeys(value, ["kind", "grams"]) &&
    positiveApiDecimal(value.grams)
  ) {
    return { kind: "grams", grams: value.grams };
  }
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
  ) {
    return { kind: "grams", grams: value.grams };
  }
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
    !UUID.test(String(value.id)) ||
    !text(value.name, 200) ||
    !Number.isSafeInteger(value.versionNumber) ||
    Number(value.versionNumber) < 1 ||
    !positiveResolvedDecimal(value.yieldGrams) ||
    !["measured", "estimated"].includes(String(value.yieldSource)) ||
    !(value.servingCount === null || positiveApiDecimal(value.servingCount)) ||
    !nullableText(value.servingLabel, 100) ||
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
    !(
      (typeof value.revision === "string" && /^[1-9]\d*$/u.test(value.revision)) ||
      (typeof value.revision === "number" &&
        Number.isSafeInteger(value.revision) &&
        value.revision > 0)
    ) ||
    !isMealSlot(value.mealSlot) ||
    !positiveResolvedDecimal(value.resolvedGrams) ||
    !legacyDiaryEntryNote(value.note) ||
    !text(value.occurredAt, 64) ||
    !isLocalDate(value.localDate) ||
    !text(value.timeZone, 63) ||
    typeof value.localTime !== "string" ||
    !TIME.test(value.localTime) ||
    !Number.isSafeInteger(value.position) ||
    !Array.isArray(value.nutrients) ||
    value.nutrients.length > 256
  ) {
    throw new TypeError("A diary entry was invalid.");
  }
  const common = {
    id: value.id,
    revision: String(value.revision),
    mealSlot: value.mealSlot,
    resolvedGrams: value.resolvedGrams,
    note: typeof value.note === "string" && value.note.length > 0 ? value.note : null,
    occurredAt: value.occurredAt,
    localDate: value.localDate,
    timeZone: value.timeZone,
    localTime: value.localTime,
    position: Number(value.position),
    nutrients: value.nutrients.map(parseDiaryNutrient),
  };
  if (
    value.entryKind === "food" &&
    exactEntryKeysWithLegacyNote(value, [
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
      "note",
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
    nullableText(value.food.brandName, 300) &&
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
        !UUID.test(String(value.foodProvenance.customFoodId)) ||
        !Number.isSafeInteger(value.foodProvenance.customFoodVersionNumber) ||
        Number(value.foodProvenance.customFoodVersionNumber) < 1
      ) {
        throw new TypeError("Private custom-food provenance was invalid.");
      }
      return {
        ...entry,
        source: null,
        foodProvenance: {
          kind: "private_custom",
          customFoodId: String(value.foodProvenance.customFoodId),
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
    ) {
      throw new TypeError("Public food provenance was invalid.");
    }
    return { ...entry, source, foodProvenance: { kind: "public", source } };
  }
  if (
    value.entryKind === "recipe" &&
    exactEntryKeysWithLegacyNote(value, [
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
      "note",
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

export function parseDiaryDay(value: unknown): DiaryDay {
  if (
    !record(value) ||
    !record(value.data) ||
    !(value.data.id === null || text(value.data.id, 64)) ||
    !isLocalDate(value.data.localDate) ||
    !text(value.data.timeZone, 63) ||
    (value.data.status !== "open" && value.data.status !== "locked") ||
    !(
      (typeof value.data.revision === "string" && /^\d+$/u.test(value.data.revision)) ||
      (typeof value.data.revision === "number" && Number.isSafeInteger(value.data.revision))
    ) ||
    !Array.isArray(value.data.entries) ||
    value.data.entries.length > DIARY_DAY_MAX_ENTRIES ||
    !Array.isArray(value.data.totals) ||
    value.data.totals.length > 256 ||
    !(value.data.updatedAt === null || text(value.data.updatedAt, 64))
  ) {
    throw new TypeError("The diary response was invalid.");
  }
  return {
    id: value.data.id,
    localDate: value.data.localDate,
    timeZone: value.data.timeZone,
    status: value.data.status,
    revision: String(value.data.revision),
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

/** Parse either the opt-in paged response or the legacy complete-day response. */
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

/** Append one validated snapshot page without ever producing a partial or mixed-day model. */
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
  return `/api/diary?${query.toString()}`;
}

export function isDiaryPageStaleProblem(status: number, value: unknown): boolean {
  return status === 409 && record(value) && value.code === "DIARY_PAGE_STALE";
}

export function diaryEditorOrigin(day: DiaryDay, entry: DiaryEntry): DiaryEditorOrigin {
  return {
    entryId: entry.id,
    originEntryRevision: entry.revision,
    originLocalDate: day.localDate,
    originTimeZone: day.timeZone,
    originDayRevision: day.revision,
  };
}

export function diaryEditorOriginMatches(
  origin: DiaryEditorOrigin,
  day: DiaryDay,
  entry: DiaryEntry,
): boolean {
  return (
    origin.entryId === entry.id &&
    origin.originEntryRevision === entry.revision &&
    origin.originLocalDate === day.localDate &&
    origin.originTimeZone === day.timeZone &&
    origin.originDayRevision === day.revision
  );
}

export function diaryEditorOperationKey(origin: DiaryEditorOrigin, body: object): string {
  return `edit:${origin.entryId}:${origin.originEntryRevision}:${origin.originDayRevision}:${JSON.stringify(body)}`;
}

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  if (Number(match[1]) < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

export function currentLocalDate(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveDiaryRouteDate(
  explicitDate: string | null,
  profileTimeZone: string | null,
  now = new Date(),
): string | null {
  if (explicitDate !== null && isLocalDate(explicitDate)) return explicitDate;
  return profileTimeZone === null ? null : localDateInTimeZone(now, profileTimeZone);
}

export function localDateInTimeZone(now: Date, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone)) throw new RangeError("Invalid diary time zone.");
  const [year, month, day] = zonedParts(now, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function shiftLocalDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days))
    throw new RangeError("Invalid local date.");
  const [year, month, day] = localDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function prepareDiaryEntryNote(value: string): string | null {
  if (value.length === 0) return null;
  if (value.includes("\u0000")) {
    throw new RangeError("A private note cannot contain a null character.");
  }
  if (!wellFormedUnicode(value)) {
    throw new RangeError("A private note must contain well-formed Unicode text.");
  }
  if (diaryEntryNoteCharacterCount(value) > 2_000) {
    throw new RangeError("A private note must contain 1 to 2,000 characters or be cleared.");
  }
  return value;
}

export function prepareDiaryEntryNotePatch(
  draft: string,
  current: string | null,
): { readonly note?: string | null } {
  return draft === (current ?? "") ? {} : { note: prepareDiaryEntryNote(draft) };
}

function zonedParts(instant: Date, timeZone: string): readonly number[] {
  const values = new Map(
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
    values.get("year") ?? 0,
    values.get("month") ?? 0,
    values.get("day") ?? 0,
    values.get("hour") ?? 0,
    values.get("minute") ?? 0,
  ];
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

export function localDateTimeToInstant(
  localDate: string,
  localTime: string,
  timeZone: string,
): string {
  if (!isLocalDate(localDate) || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(localTime)) {
    throw new RangeError("Invalid local diary time.");
  }
  if (!isSupportedTimeZone(timeZone)) throw new RangeError("Invalid diary time zone.");
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const desired = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [actualYear, actualMonth, actualDay, actualHour, actualMinute] = zonedParts(
      new Date(candidate),
      timeZone,
    );
    const actual = Date.UTC(
      actualYear ?? 0,
      (actualMonth ?? 1) - 1,
      actualDay ?? 0,
      actualHour ?? 0,
      actualMinute ?? 0,
    );
    const delta = desired - actual;
    if (delta === 0) break;
    candidate += delta;
  }
  const expected = [year, month, day, hour, minute].map((part) => part ?? 0);
  if (zonedParts(new Date(candidate), timeZone).some((part, index) => part !== expected[index])) {
    throw new RangeError("That local time does not exist in the selected time zone.");
  }
  return new Date(candidate).toISOString();
}

export function currentLocalTime(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function localTimeInTimeZone(now: Date, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone)) throw new RangeError("Invalid diary time zone.");
  const parts = zonedParts(now, timeZone);
  return `${String(parts[3]).padStart(2, "0")}:${String(parts[4]).padStart(2, "0")}`;
}

export function diaryEditErrorMessage(error: unknown): string {
  if (error instanceof RangeError) {
    return "That local time does not exist in your current diary time zone. Choose another time.";
  }
  return `${error instanceof Error ? error.message : "The entry could not be saved."} Press Save again to retry safely.`;
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

export function defaultMealForTime(now = new Date()): MealSlot {
  return defaultMealForHour(now.getHours());
}

export function defaultMealForHour(hour: number): MealSlot {
  if (hour < 11) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snacks";
}

export function isPositiveDecimal(value: string): boolean {
  return value.length <= 19 && API_POSITIVE_DECIMAL.test(value);
}

export function createOperationId(): string {
  return globalThis.crypto.randomUUID();
}

export function quoteRevision(revision: string): string {
  if (!/^\d+$/u.test(revision)) throw new RangeError("Invalid diary revision.");
  return `"${revision}"`;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function nutrientDisplay(nutrient: DiaryNutrient): {
  readonly amount: string;
  readonly qualification: string;
} {
  if (nutrient.completeness === "unknown") {
    return {
      amount: "Unknown",
      qualification: `0/${nutrient.contributorCount} contributions quantified`,
    };
  }
  if (nutrient.completeness === "partial") {
    return {
      amount: `≥ ${nutrient.knownAmount} ${nutrient.unit}`,
      qualification: `Partial · ${nutrient.quantifiedCount}/${nutrient.contributorCount} contributions quantified`,
    };
  }
  if (nutrient.traceCount > 0 || !nutrient.isExact) {
    return {
      amount: `≥ ${nutrient.knownAmount} ${nutrient.unit}`,
      qualification:
        nutrient.traceCount > 0
          ? "Complete coverage · includes trace values"
          : "Complete coverage · estimated",
    };
  }
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

export function parseDiaryMutation(value: unknown): DiaryMutationResult {
  if (
    !record(value) ||
    !record(value.data) ||
    typeof value.data.replayed !== "boolean" ||
    !(value.data.entry === null || record(value.data.entry)) ||
    !Array.isArray(value.data.affectedDays) ||
    value.data.affectedDays.length < 1 ||
    value.data.affectedDays.length > 2
  ) {
    throw new TypeError("The diary mutation response was invalid.");
  }
  const affectedDays = value.data.affectedDays.map((day) => {
    if (
      !record(day) ||
      !isLocalDate(day.localDate) ||
      !(
        (typeof day.revision === "string" && /^[1-9]\d*$/u.test(day.revision)) ||
        (typeof day.revision === "number" && Number.isSafeInteger(day.revision) && day.revision > 0)
      )
    ) {
      throw new TypeError("An affected diary day was invalid.");
    }
    return { localDate: day.localDate, revision: String(day.revision) };
  });
  return {
    replayed: value.data.replayed,
    entry: value.data.entry === null ? null : parseEntry(value.data.entry),
    affectedDays,
  };
}

export function mealLabel(meal: MealSlot): string {
  return meal === "snacks" ? "Snacks" : `${meal[0]?.toUpperCase()}${meal.slice(1)}`;
}
