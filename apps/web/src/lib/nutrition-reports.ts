import {
  type DiaryNutrient,
  isLocalDate,
  isSupportedTimeZone,
  localDateInTimeZone,
  parseDiaryNutrient,
} from "./diary";

export const MAX_NUTRITION_REPORT_DAYS = 31;
export const NUTRITION_REPORT_NOTICE = "General wellness estimate; not medical advice.";

export const REPORT_NUTRIENTS = [
  { code: "energy", unit: "kcal", category: "energy" },
  { code: "protein", unit: "g", category: "macronutrient" },
  { code: "carbohydrate", unit: "g", category: "macronutrient" },
  { code: "fat", unit: "g", category: "macronutrient" },
  { code: "fiber", unit: "g", category: "macronutrient" },
  { code: "sugars", unit: "g", category: "macronutrient" },
  { code: "sodium", unit: "mg", category: "mineral" },
  { code: "potassium", unit: "mg", category: "mineral" },
  { code: "calcium", unit: "mg", category: "mineral" },
  { code: "iron", unit: "mg", category: "mineral" },
  { code: "vitamin-c", unit: "mg", category: "vitamin" },
  { code: "vitamin-d", unit: "ug", category: "vitamin" },
  { code: "vitamin-b12", unit: "ug", category: "vitamin" },
  { code: "folate-dfe", unit: "ug_DFE", category: "vitamin" },
  { code: "vitamin-a-rae", unit: "ug_RAE", category: "vitamin" },
] as const;

export type NutrientCategory =
  | "energy"
  | "macronutrient"
  | "vitamin"
  | "mineral"
  | "amino-acid"
  | "fatty-acid"
  | "other";
export type ThresholdState = "met" | "below" | "within" | "exceeded" | "indeterminate";

export interface NutritionReportNutrientDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly category: NutrientCategory;
}

export interface NutritionReportTargetSnapshot {
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionReportGoalVersion {
  readonly goalId: string;
  readonly versionId: string;
  readonly revision: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reference: {
    readonly templateCode: string;
    readonly templateVersion: string;
    readonly groupCode: string;
    readonly policyDigest: string;
    readonly eligibleThroughExclusive: string;
  } | null;
  readonly targets: readonly {
    readonly nutrientId: string;
    readonly snapshot: NutritionReportTargetSnapshot;
  }[];
}

export interface NutritionReportComparison {
  readonly minimumState: ThresholdState | null;
  readonly targetLowerBoundPercent: string | null;
  readonly targetPercentIsExact: boolean | null;
  readonly maximumState: ThresholdState | null;
}

export interface NutritionReportSeriesPoint {
  readonly localDate: string;
  readonly goalVersionId: string | null;
  readonly aggregate: DiaryNutrient | null;
  readonly knownPercentOfScale: string | null;
  readonly minimumPercentOfScale: string | null;
  readonly targetPercentOfScale: string | null;
  readonly maximumPercentOfScale: string | null;
  readonly comparison: NutritionReportComparison | null;
}

export interface NutritionReportSeries {
  readonly nutrient: NutritionReportNutrientDefinition;
  readonly scalePolicy: "max-intake-or-saved-threshold-v1";
  readonly scaleMaximum: string;
  readonly summary: {
    readonly diaryDays: number;
    readonly completeDays: number;
    readonly exactDays: number;
    readonly partialDays: number;
    readonly unknownDays: number;
    readonly traceDays: number;
    readonly missingDays: number;
  };
  readonly points: readonly NutritionReportSeriesPoint[];
}

export interface NutritionReportDay {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly entryCount: number;
  readonly sourceDiaries: readonly {
    readonly id: string;
    readonly localDate: string;
    readonly revision: string;
  }[];
  readonly sourceTimeZones: readonly string[];
}

export function reportSourceDiaryDates(day: NutritionReportDay): readonly string[] {
  if (
    !isLocalDate(day.localDate) ||
    !Number.isSafeInteger(day.entryCount) ||
    day.entryCount < 0 ||
    day.sourceDiaries.some((diary) => !isLocalDate(diary.localDate)) ||
    (day.entryCount === 0) !== (day.sourceDiaries.length === 0)
  )
    throw new TypeError("Report diary destinations require a valid parsed day.");
  return day.entryCount === 0
    ? [day.localDate]
    : [...new Set(day.sourceDiaries.map((diary) => diary.localDate))].sort();
}

export interface NutritionReport {
  readonly ownerUserId: string;
  readonly profileRevision: string;
  readonly timeZone: string;
  readonly watermarkRevision: string;
  readonly snapshotAt: string;
  readonly dateBasis: "active-profile-time-zone-v1";
  readonly goalVersionBasis: "current-version-at-report-snapshot-v1";
  readonly from: string;
  readonly to: string;
  readonly days: readonly NutritionReportDay[];
  readonly goalVersions: readonly NutritionReportGoalVersion[];
  readonly targetSegments: readonly {
    readonly from: string;
    readonly to: string;
    readonly goalVersionId: string | null;
  }[];
  readonly series: readonly NutritionReportSeries[];
  readonly notice: typeof NUTRITION_REPORT_NOTICE;
}

export interface NutritionReportRange {
  readonly from: string;
  readonly to: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/u;
const REVISION = /^(?:0|[1-9][0-9]{0,19})$/u;
const POSITIVE_REVISION = /^[1-9][0-9]{0,19}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const POSITIVE_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const SCALE_PERCENTAGE = /^(?:0|[1-9][0-9]?|100)(?:\.[0-9]{1,3})?$/u;
const RFC3339 =
  /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CATEGORIES = new Set<NutrientCategory>([
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);
const THRESHOLD_STATES = new Set<ThresholdState>([
  "met",
  "below",
  "within",
  "exceeded",
  "indeterminate",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function decimal(value: unknown, positive = false, maximum = 200): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (positive ? POSITIVE_DECIMAL : DECIMAL).test(value)
  );
}

function nullableDecimal(value: unknown): value is string | null {
  return value === null || decimal(value);
}

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339.test(value) &&
    isLocalDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function shiftReportDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days))
    throw new RangeError("Invalid report date.");
  const [year = 0, month = 1, day = 1] = localDate.split("-").map(Number);
  const shifted = new Date(0);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCFullYear(year, month - 1, day);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function adjacentNutritionReportRange(
  range: NutritionReportRange,
  direction: "previous" | "next",
): NutritionReportRange | null {
  const dates = nutritionReportDates(range.from, range.to);
  if (
    range.from < "0002-01-01" ||
    range.to > "9998-12-31" ||
    (direction !== "previous" && direction !== "next")
  )
    throw new RangeError("Choose a report period within 0002-01-01 through 9998-12-31.");
  const offset = (direction === "previous" ? -1 : 1) * dates.length;
  const from = shiftReportDate(range.from, offset);
  const to = shiftReportDate(range.to, offset);
  if (!isLocalDate(from) || !isLocalDate(to) || from < "0002-01-01" || to > "9998-12-31")
    return null;
  nutritionReportDates(from, to);
  return { from, to };
}

export function nutritionReportDates(from: string, to: string): readonly string[] {
  if (!isLocalDate(from) || !isLocalDate(to) || from > to) {
    throw new RangeError("Choose valid report dates with From on or before To.");
  }
  const dates = [from];
  while (dates[dates.length - 1] !== to && dates.length < MAX_NUTRITION_REPORT_DAYS) {
    const next = shiftReportDate(dates[dates.length - 1] ?? from, 1);
    if (!isLocalDate(next)) break;
    dates.push(next);
  }
  if (dates[dates.length - 1] !== to) {
    throw new RangeError("Choose an inclusive range of 1 to 31 local days.");
  }
  return dates;
}

export function nutritionReportRange(to: string, days = 14): NutritionReportRange {
  if (!isLocalDate(to) || !Number.isInteger(days) || days < 1 || days > MAX_NUTRITION_REPORT_DAYS) {
    throw new RangeError("Choose an inclusive range of 1 to 31 local days.");
  }
  const from = shiftReportDate(to, 1 - days);
  nutritionReportDates(from, to);
  return { from, to };
}

export function resolveInitialNutritionReportRange(input: {
  readonly initialFrom?: string;
  readonly initialTo?: string;
  readonly profileTimeZone: string;
  readonly now?: Date;
}): NutritionReportRange {
  if (input.initialFrom && input.initialTo) {
    try {
      nutritionReportDates(input.initialFrom, input.initialTo);
      return { from: input.initialFrom, to: input.initialTo };
    } catch {
      // A malformed shared URL falls back to the bounded profile-local default.
    }
  }
  const to =
    input.initialTo && isLocalDate(input.initialTo)
      ? input.initialTo
      : localDateInTimeZone(input.now ?? new Date(), input.profileTimeZone);
  return nutritionReportRange(to, 14);
}

export function nutritionReportPath(range: NutritionReportRange): string {
  nutritionReportDates(range.from, range.to);
  return `/api/reports/nutrition?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

function parseDefinition(value: unknown): NutritionReportNutrientDefinition {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "code", "name", "unit", "category"]) ||
    typeof value.id !== "string" ||
    !POSITIVE_ID.test(value.id) ||
    !text(value.code, 1, 64) ||
    !text(value.name, 1, 200) ||
    !text(value.unit, 1, 32) ||
    typeof value.category !== "string" ||
    !CATEGORIES.has(value.category as NutrientCategory)
  ) {
    throw new TypeError("A nutrition-report nutrient definition was invalid.");
  }
  return value as unknown as NutritionReportNutrientDefinition;
}

function parseSourceDiary(value: unknown): NutritionReportDay["sourceDiaries"][number] {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "localDate", "revision"]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !isLocalDate(value.localDate) ||
    typeof value.revision !== "string" ||
    !POSITIVE_REVISION.test(value.revision)
  ) {
    throw new TypeError("A nutrition-report source diary was invalid.");
  }
  return value as unknown as NutritionReportDay["sourceDiaries"][number];
}

function parseDay(
  value: unknown,
  expectedDate: string,
  reportTimeZone: string,
): NutritionReportDay {
  if (
    !record(value) ||
    !exactKeys(value, [
      "localDate",
      "startsAt",
      "endsAt",
      "entryCount",
      "sourceDiaries",
      "sourceTimeZones",
    ]) ||
    value.localDate !== expectedDate ||
    !instant(value.startsAt) ||
    !instant(value.endsAt) ||
    Date.parse(value.startsAt) >= Date.parse(value.endsAt) ||
    localDateInTimeZone(new Date(Date.parse(value.startsAt) - 1), reportTimeZone) !==
      shiftReportDate(expectedDate, -1) ||
    localDateInTimeZone(new Date(value.startsAt), reportTimeZone) !== expectedDate ||
    localDateInTimeZone(new Date(Date.parse(value.endsAt) - 1), reportTimeZone) !== expectedDate ||
    localDateInTimeZone(new Date(value.endsAt), reportTimeZone) !==
      shiftReportDate(expectedDate, 1) ||
    !safeCount(value.entryCount, 2_000) ||
    !Array.isArray(value.sourceDiaries) ||
    value.sourceDiaries.length > MAX_NUTRITION_REPORT_DAYS ||
    !Array.isArray(value.sourceTimeZones) ||
    value.sourceTimeZones.length > 50 ||
    !value.sourceTimeZones.every(
      (zone): zone is string => typeof zone === "string" && isSupportedTimeZone(zone),
    )
  ) {
    throw new TypeError("A nutrition-report day was invalid.");
  }
  const sourceDiaries = value.sourceDiaries.map(parseSourceDiary);
  if (
    new Set(sourceDiaries.map((diary) => diary.id)).size !== sourceDiaries.length ||
    new Set(value.sourceTimeZones).size !== value.sourceTimeZones.length ||
    (Number(value.entryCount) === 0 &&
      (sourceDiaries.length !== 0 || value.sourceTimeZones.length !== 0)) ||
    (Number(value.entryCount) > 0 &&
      (sourceDiaries.length === 0 || value.sourceTimeZones.length === 0))
  ) {
    throw new TypeError("Nutrition-report day provenance was inconsistent.");
  }
  return {
    localDate: value.localDate,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    entryCount: Number(value.entryCount),
    sourceDiaries,
    sourceTimeZones: value.sourceTimeZones,
  };
}

function parseTargetSnapshot(value: unknown): NutritionReportTargetSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, ["minimumAmount", "targetAmount", "maximumAmount", "source", "rationale"]) ||
    !nullableDecimal(value.minimumAmount) ||
    !nullableDecimal(value.targetAmount) ||
    !nullableDecimal(value.maximumAmount) ||
    !record(value.source) ||
    !exactKeys(value.source, ["label", "version"]) ||
    !text(value.source.label, 1, 160) ||
    !(value.source.version === null || text(value.source.version, 1, 100)) ||
    !(value.rationale === null || text(value.rationale, 1, 1_000))
  ) {
    throw new TypeError("A nutrition-report target snapshot was invalid.");
  }
  return value as unknown as NutritionReportTargetSnapshot;
}

function parseGoalVersion(value: unknown): NutritionReportGoalVersion {
  if (
    !record(value) ||
    !exactKeys(value, [
      "goalId",
      "versionId",
      "revision",
      "effectiveFrom",
      "effectiveTo",
      "reference",
      "targets",
    ]) ||
    typeof value.goalId !== "string" ||
    !UUID.test(value.goalId) ||
    typeof value.versionId !== "string" ||
    !UUID.test(value.versionId) ||
    typeof value.revision !== "string" ||
    !POSITIVE_REVISION.test(value.revision) ||
    !isLocalDate(value.effectiveFrom) ||
    !(value.effectiveTo === null || isLocalDate(value.effectiveTo)) ||
    (typeof value.effectiveTo === "string" && value.effectiveTo <= value.effectiveFrom) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > REPORT_NUTRIENTS.length
  ) {
    throw new TypeError("A nutrition-report goal version was invalid.");
  }
  if (value.reference !== null) {
    if (
      !record(value.reference) ||
      !exactKeys(value.reference, [
        "templateCode",
        "templateVersion",
        "groupCode",
        "policyDigest",
        "eligibleThroughExclusive",
      ]) ||
      !text(value.reference.templateCode, 1, 100) ||
      !text(value.reference.templateVersion, 1, 100) ||
      !text(value.reference.groupCode, 1, 100) ||
      typeof value.reference.policyDigest !== "string" ||
      !SHA256.test(value.reference.policyDigest) ||
      !isLocalDate(value.reference.eligibleThroughExclusive)
    ) {
      throw new TypeError("A nutrition-report reference target was invalid.");
    }
  }
  const targets = value.targets.map((target) => {
    if (
      !record(target) ||
      !exactKeys(target, ["nutrientId", "snapshot"]) ||
      typeof target.nutrientId !== "string" ||
      !POSITIVE_ID.test(target.nutrientId)
    ) {
      throw new TypeError("A nutrition-report goal target was invalid.");
    }
    return { nutrientId: target.nutrientId, snapshot: parseTargetSnapshot(target.snapshot) };
  });
  if (new Set(targets.map((target) => target.nutrientId)).size !== targets.length) {
    throw new TypeError("Nutrition-report goal targets were duplicated.");
  }
  return { ...(value as unknown as NutritionReportGoalVersion), targets };
}

function nullableScalePercentage(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && SCALE_PERCENTAGE.test(value) && Number(value) <= 100)
  );
}

function nullableThreshold(value: unknown): value is ThresholdState | null {
  return (
    value === null || (typeof value === "string" && THRESHOLD_STATES.has(value as ThresholdState))
  );
}

function parseComparison(value: unknown): NutritionReportComparison | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactKeys(value, [
      "minimumState",
      "targetLowerBoundPercent",
      "targetPercentIsExact",
      "maximumState",
    ]) ||
    !nullableThreshold(value.minimumState) ||
    !nullableDecimal(value.targetLowerBoundPercent) ||
    !(value.targetPercentIsExact === null || typeof value.targetPercentIsExact === "boolean") ||
    !nullableThreshold(value.maximumState)
  ) {
    throw new TypeError("A nutrition-report target comparison was invalid.");
  }
  return value as unknown as NutritionReportComparison;
}

function parseReportAggregate(value: unknown): DiaryNutrient {
  if (
    !record(value) ||
    !exactKeys(value, [
      "nutrientId",
      "code",
      "name",
      "unit",
      "knownAmount",
      "completeness",
      "isExact",
      "contributorCount",
      "quantifiedCount",
      "traceCount",
      "unknownCount",
      "unknownReasonCounts",
    ])
  ) {
    throw new TypeError("A nutrition-report aggregate was invalid.");
  }
  return parseDiaryNutrient(value);
}

function parseSeries(
  value: unknown,
  dates: readonly string[],
  days: readonly NutritionReportDay[],
  goalVersionIds: ReadonlySet<string>,
): NutritionReportSeries {
  if (
    !record(value) ||
    !exactKeys(value, ["nutrient", "scalePolicy", "scaleMaximum", "summary", "points"]) ||
    value.scalePolicy !== "max-intake-or-saved-threshold-v1" ||
    !decimal(value.scaleMaximum, true) ||
    !record(value.summary) ||
    !exactKeys(value.summary, [
      "diaryDays",
      "completeDays",
      "exactDays",
      "partialDays",
      "unknownDays",
      "traceDays",
      "missingDays",
    ]) ||
    !Object.values(value.summary).every((count) => safeCount(count, MAX_NUTRITION_REPORT_DAYS)) ||
    !Array.isArray(value.points) ||
    value.points.length !== dates.length
  ) {
    throw new TypeError("A nutrition-report series was invalid.");
  }
  const nutrient = parseDefinition(value.nutrient);
  const points = value.points.map((point, index): NutritionReportSeriesPoint => {
    const day = days[index];
    if (
      !day ||
      !record(point) ||
      !exactKeys(point, [
        "localDate",
        "goalVersionId",
        "aggregate",
        "knownPercentOfScale",
        "minimumPercentOfScale",
        "targetPercentOfScale",
        "maximumPercentOfScale",
        "comparison",
      ]) ||
      point.localDate !== dates[index] ||
      !(
        point.goalVersionId === null ||
        (typeof point.goalVersionId === "string" && goalVersionIds.has(point.goalVersionId))
      ) ||
      !nullableScalePercentage(point.knownPercentOfScale) ||
      !nullableScalePercentage(point.minimumPercentOfScale) ||
      !nullableScalePercentage(point.targetPercentOfScale) ||
      !nullableScalePercentage(point.maximumPercentOfScale)
    ) {
      throw new TypeError("A nutrition-report series point was invalid.");
    }
    const aggregate = point.aggregate === null ? null : parseReportAggregate(point.aggregate);
    if (
      (day.entryCount === 0) !== (aggregate === null) ||
      (aggregate === null) !== (point.knownPercentOfScale === null) ||
      (aggregate !== null &&
        (aggregate.nutrientId !== nutrient.id ||
          aggregate.code !== nutrient.code ||
          aggregate.name !== nutrient.name ||
          aggregate.unit !== nutrient.unit))
    ) {
      throw new TypeError("Nutrition-report point coverage was inconsistent.");
    }
    return {
      localDate: String(point.localDate),
      goalVersionId: point.goalVersionId as string | null,
      aggregate,
      knownPercentOfScale: point.knownPercentOfScale,
      minimumPercentOfScale: point.minimumPercentOfScale,
      targetPercentOfScale: point.targetPercentOfScale,
      maximumPercentOfScale: point.maximumPercentOfScale,
      comparison: parseComparison(point.comparison),
    };
  });
  const summary = value.summary as Record<string, number>;
  const normalizedSummary = {
    completeDays: points.filter((point) => point.aggregate?.completeness === "complete").length,
    diaryDays: points.filter((point) => point.aggregate !== null).length,
    exactDays: points.filter((point) => point.aggregate?.isExact === true).length,
    missingDays: points.filter((point) => point.aggregate === null).length,
    partialDays: points.filter((point) => point.aggregate?.completeness === "partial").length,
    traceDays: points.filter((point) => (point.aggregate?.traceCount ?? 0) > 0).length,
    unknownDays: points.filter((point) => point.aggregate?.completeness === "unknown").length,
  };
  if (Object.entries(normalizedSummary).some(([key, count]) => summary[key] !== count)) {
    throw new TypeError("Nutrition-report series summary was inconsistent.");
  }
  return {
    nutrient,
    scalePolicy: "max-intake-or-saved-threshold-v1",
    scaleMaximum: value.scaleMaximum,
    summary: normalizedSummary,
    points,
  };
}

export function parseNutritionReport(
  value: unknown,
  expected: { readonly from?: string; readonly to?: string; readonly ownerUserId?: string } = {},
): NutritionReport {
  const data = record(value) ? value.data : null;
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !record(data) ||
    !exactKeys(data, [
      "ownerUserId",
      "profileRevision",
      "timeZone",
      "watermarkRevision",
      "snapshotAt",
      "dateBasis",
      "goalVersionBasis",
      "from",
      "to",
      "days",
      "goalVersions",
      "targetSegments",
      "series",
      "notice",
    ]) ||
    typeof data.ownerUserId !== "string" ||
    !UUID.test(data.ownerUserId) ||
    typeof data.profileRevision !== "string" ||
    !REVISION.test(data.profileRevision) ||
    typeof data.timeZone !== "string" ||
    !isSupportedTimeZone(data.timeZone) ||
    typeof data.watermarkRevision !== "string" ||
    !REVISION.test(data.watermarkRevision) ||
    !instant(data.snapshotAt) ||
    data.dateBasis !== "active-profile-time-zone-v1" ||
    data.goalVersionBasis !== "current-version-at-report-snapshot-v1" ||
    !isLocalDate(data.from) ||
    !isLocalDate(data.to) ||
    data.notice !== NUTRITION_REPORT_NOTICE ||
    !Array.isArray(data.days) ||
    !Array.isArray(data.goalVersions) ||
    data.goalVersions.length > MAX_NUTRITION_REPORT_DAYS ||
    !Array.isArray(data.targetSegments) ||
    !Array.isArray(data.series)
  ) {
    throw new TypeError("The nutrition-report response was invalid.");
  }
  if (
    (expected.from !== undefined && data.from !== expected.from) ||
    (expected.to !== undefined && data.to !== expected.to) ||
    (expected.ownerUserId !== undefined && data.ownerUserId !== expected.ownerUserId)
  ) {
    throw new TypeError("The nutrition-report response did not match its request owner or range.");
  }
  const dates = nutritionReportDates(data.from, data.to);
  const reportTimeZone = data.timeZone;
  const days = data.days.map((day, index) => {
    const expectedDate = dates[index];
    if (!expectedDate) {
      throw new TypeError("Nutrition-report days did not match the requested range.");
    }
    return parseDay(day, expectedDate, reportTimeZone);
  });
  if (days.length !== dates.length || days.some((day, index) => day.localDate !== dates[index])) {
    throw new TypeError("Nutrition-report days did not match the requested range.");
  }
  const goalVersions = data.goalVersions.map(parseGoalVersion);
  const goalVersionIds = new Set(goalVersions.map((goal) => goal.versionId));
  if (goalVersionIds.size !== goalVersions.length) {
    throw new TypeError("Nutrition-report goal versions were duplicated.");
  }
  const goalsByVersion = new Map(goalVersions.map((goal) => [goal.versionId, goal]));
  const series = data.series.map((candidate) =>
    parseSeries(candidate, dates, days, goalVersionIds),
  );
  if (
    series.length !== REPORT_NUTRIENTS.length ||
    new Set(series.map((item) => item.nutrient.id)).size !== series.length ||
    new Set(series.map((item) => item.nutrient.code)).size !== series.length ||
    series.some((item, index) => {
      const expectedNutrient = REPORT_NUTRIENTS[index];
      return (
        !expectedNutrient ||
        item.nutrient.code !== expectedNutrient.code ||
        item.nutrient.unit !== expectedNutrient.unit ||
        item.nutrient.category !== expectedNutrient.category
      );
    })
  ) {
    throw new TypeError("The nutrition-report core nutrient series was incomplete.");
  }
  const nutrientIds = new Set(series.map((item) => item.nutrient.id));
  if (
    goalVersions.some((goal) => goal.targets.some((target) => !nutrientIds.has(target.nutrientId)))
  ) {
    throw new TypeError("A nutrition-report goal referred to an unknown nutrient.");
  }
  for (const nutrientSeries of series) {
    for (const point of nutrientSeries.points) {
      const target = targetSnapshotForPoint(
        { goalVersions },
        nutrientSeries.nutrient.id,
        point.goalVersionId,
      );
      const comparison = point.comparison;
      const expectedMinimum = target?.minimumAmount ?? null;
      const expectedTarget = target?.targetAmount ?? null;
      const expectedMaximum = target?.maximumAmount ?? null;
      const targetIsZero = expectedTarget !== null && /^0(?:\.0+)?$/u.test(expectedTarget);
      if (
        (expectedMinimum === null) !== (point.minimumPercentOfScale === null) ||
        (expectedTarget === null) !== (point.targetPercentOfScale === null) ||
        (expectedMaximum === null) !== (point.maximumPercentOfScale === null) ||
        (point.aggregate === null && comparison !== null) ||
        (target === null && comparison !== null) ||
        (point.aggregate !== null && target !== null && comparison === null) ||
        (comparison !== null &&
          ((comparison.minimumState === null) !== (expectedMinimum === null) ||
            (expectedTarget === null
              ? comparison.targetLowerBoundPercent !== null ||
                comparison.targetPercentIsExact !== null
              : targetIsZero
                ? comparison.targetLowerBoundPercent !== null ||
                  comparison.targetPercentIsExact !== point.aggregate?.isExact
                : comparison.targetLowerBoundPercent === null ||
                  comparison.targetPercentIsExact !== point.aggregate?.isExact) ||
            (comparison.maximumState === null) !== (expectedMaximum === null)))
      ) {
        throw new TypeError("Nutrition-report saved-target evidence was inconsistent.");
      }
    }
  }
  const canonicalGoalIds = series[0]?.points.map((point) => point.goalVersionId) ?? [];
  if (
    series.some((item) =>
      item.points.some((point, index) => point.goalVersionId !== canonicalGoalIds[index]),
    )
  ) {
    throw new TypeError("Nutrition-report target boundaries differed between nutrients.");
  }
  const segments = data.targetSegments.map((segment) => {
    if (
      !record(segment) ||
      !exactKeys(segment, ["from", "to", "goalVersionId"]) ||
      !isLocalDate(segment.from) ||
      !isLocalDate(segment.to) ||
      !(
        segment.goalVersionId === null ||
        (typeof segment.goalVersionId === "string" && goalVersionIds.has(segment.goalVersionId))
      )
    ) {
      throw new TypeError("A nutrition-report target segment was invalid.");
    }
    return {
      from: segment.from,
      to: segment.to,
      goalVersionId: segment.goalVersionId as string | null,
    };
  });
  for (const segment of segments) {
    const goal =
      segment.goalVersionId === null ? null : (goalsByVersion.get(segment.goalVersionId) ?? null);
    if (
      goal &&
      (segment.from < goal.effectiveFrom ||
        (goal.effectiveTo !== null && segment.to >= goal.effectiveTo) ||
        (goal.reference !== null && segment.to >= goal.reference.eligibleThroughExclusive))
    ) {
      throw new TypeError("A nutrition-report target segment exceeded its saved goal period.");
    }
  }
  if (segments.length < 1 || segments.length > dates.length) {
    throw new TypeError("Nutrition-report target segments were missing.");
  }
  const expandedSegments = segments.flatMap((segment) =>
    nutritionReportDates(segment.from, segment.to).map((localDate) => ({
      localDate,
      goalVersionId: segment.goalVersionId,
    })),
  );
  if (
    expandedSegments.length !== dates.length ||
    expandedSegments.some(
      (entry, index) =>
        entry.localDate !== dates[index] || entry.goalVersionId !== canonicalGoalIds[index],
    ) ||
    segments.some(
      (segment, index) => index > 0 && segment.goalVersionId === segments[index - 1]?.goalVersionId,
    )
  ) {
    throw new TypeError("Nutrition-report target segments were inconsistent.");
  }
  const usedGoalVersionIds = new Set(canonicalGoalIds.filter((id): id is string => id !== null));
  if (
    usedGoalVersionIds.size !== goalVersionIds.size ||
    [...goalVersionIds].some((id) => !usedGoalVersionIds.has(id))
  ) {
    throw new TypeError("Nutrition-report goal-version evidence was inconsistent.");
  }
  return {
    ownerUserId: data.ownerUserId,
    profileRevision: data.profileRevision,
    timeZone: data.timeZone,
    watermarkRevision: data.watermarkRevision,
    snapshotAt: data.snapshotAt,
    dateBasis: "active-profile-time-zone-v1",
    goalVersionBasis: "current-version-at-report-snapshot-v1",
    from: data.from,
    to: data.to,
    days,
    goalVersions,
    targetSegments: segments,
    series,
    notice: NUTRITION_REPORT_NOTICE,
  };
}

export function reportPointCoverageText(point: NutritionReportSeriesPoint): string {
  const aggregate = point.aggregate;
  if (!aggregate) return "No diary entries; this is missing, not zero.";
  if (aggregate.completeness === "unknown") {
    return "Amount unknown because every diary contribution lacks a quantified value.";
  }
  if (aggregate.completeness === "partial") {
    return `Known lower bound; ${aggregate.unknownCount} of ${aggregate.contributorCount} contributions lack values.`;
  }
  if (aggregate.traceCount > 0) {
    return `Known lower bound with ${aggregate.traceCount} trace contribution${aggregate.traceCount === 1 ? "" : "s"}.`;
  }
  return "Complete for logged diary contributions.";
}

export function reportAmountText(point: NutritionReportSeriesPoint, unit: string): string {
  if (!point.aggregate) return "Missing";
  if (point.aggregate.completeness === "unknown") return "Unknown";
  return `${point.aggregate.isExact ? "" : "At least "}${point.aggregate.knownAmount} ${unit}`;
}

export function reportComparisonText(point: NutritionReportSeriesPoint): string {
  const comparison = point.comparison;
  if (!comparison) return "Not compared";
  const parts = [
    comparison.minimumState === null ? null : `minimum ${comparison.minimumState}`,
    comparison.targetLowerBoundPercent === null
      ? comparison.targetPercentIsExact === null
        ? null
        : "target percentage unavailable because the saved target is zero"
      : `${comparison.targetPercentIsExact ? "" : "at least "}${comparison.targetLowerBoundPercent}% of target`,
    comparison.maximumState === null ? null : `maximum ${comparison.maximumState}`,
  ].filter((value): value is string => value !== null);
  return parts.length === 0 ? "No saved threshold" : parts.join(" · ");
}

export function reportPointAccessibilityLabel(
  point: NutritionReportSeriesPoint,
  nutrientName: string,
  unit: string,
): string {
  const scale =
    point.knownPercentOfScale === null
      ? "no chart bar"
      : `${point.knownPercentOfScale}% of chart scale`;
  return `${point.localDate}, ${nutrientName}: ${reportAmountText(point, unit)}; ${reportPointCoverageText(point)} ${scale}.`;
}

export function targetSnapshotForPoint(
  report: Pick<NutritionReport, "goalVersions">,
  nutrientId: string,
  goalVersionId: string | null,
): NutritionReportTargetSnapshot | null {
  if (goalVersionId === null) return null;
  const goal = report.goalVersions.find((candidate) => candidate.versionId === goalVersionId);
  return goal?.targets.find((target) => target.nutrientId === nutrientId)?.snapshot ?? null;
}
