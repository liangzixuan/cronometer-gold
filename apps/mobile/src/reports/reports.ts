import {
  type DiaryNutrientAggregate,
  MAX_NUTRITION_REPORT_DAYS,
  NUTRITION_REPORT_NOTICE,
  type NutritionReportComparison,
  type NutritionReportDay,
  type NutritionReportGoalVersion,
  type NutritionReportNutrientDefinition,
  type NutritionReportResponse,
  type NutritionReportSeries,
  type NutritionReportSeriesPoint,
  type NutritionReportTargetSegment,
  type NutritionReportTargetSnapshot,
} from "@nutrition-tracker/contracts";

import { isLocalDate, isSupportedTimeZone, localDateInTimeZone } from "../diary/diary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]{0,19})$/u;
const POSITIVE_REVISION = /^[1-9][0-9]{0,19}$/u;
const POSITIVE_IDENTIFIER = /^[1-9][0-9]{0,19}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const RFC3339 =
  /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/u;
const CATEGORIES = new Set([
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);
const THRESHOLD_STATES = new Set(["met", "below", "within", "exceeded", "indeterminate"]);
const REPORT_NUTRIENTS = [
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
const AGGREGATE_KEYS = [
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
] as const;

export interface NutritionReportExpectation {
  readonly ownerUserId: string;
  readonly profileRevision: string;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
}

export interface NutritionReportRequestFence extends NutritionReportExpectation {
  readonly generation: number;
  readonly sessionEpoch: number;
}

export interface NutritionReportPointDisplay {
  readonly amount: string;
  readonly coverage: string;
  readonly comparison: string;
}

export type NutritionReportTargetMarkerPosition =
  | { readonly left: `${number}%` }
  | { readonly right: 0 };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function decimal(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.length <= maximum && DECIMAL.test(value);
}

function positiveDecimal(value: unknown): value is string {
  return decimal(value) && /[1-9]/u.test(value);
}

function percentage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 7 &&
    /^(?:0|[1-9][0-9]?|100)(?:\.[0-9]{1,3})?$/u.test(value) &&
    Number(value) <= 100
  );
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    RFC3339.test(value) &&
    isLocalDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
}

function shiftReportLocalDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days))
    throw new RangeError("Invalid report date.");
  const [year, month, day] = localDate.split("-").map(Number);
  const shifted = new Date(0);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCFullYear(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days);
  return shifted.toISOString().slice(0, 10);
}

export function nutritionReportLocalDates(from: string, to: string): readonly string[] {
  if (
    !isLocalDate(from) ||
    !isLocalDate(to) ||
    from < "0002-01-01" ||
    to > "9998-12-31" ||
    from > to
  ) {
    throw new RangeError("Choose a valid inclusive report range of 1 to 31 local days.");
  }
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length <= MAX_NUTRITION_REPORT_DAYS) {
    dates.push(cursor);
    if (cursor === to) break;
    cursor = shiftReportLocalDate(cursor, 1);
  }
  if (dates.length < 1 || dates.length > MAX_NUTRITION_REPORT_DAYS || dates.at(-1) !== to) {
    throw new RangeError("Choose a valid inclusive report range of 1 to 31 local days.");
  }
  return dates;
}

export function nutritionReportRangeEndingAt(
  to: string,
  days: 7 | 14 | 30,
): { readonly from: string; readonly to: string } {
  if (!isLocalDate(to) || to < "0002-01-01" || to > "9998-12-31") {
    throw new RangeError("Choose a valid report end date.");
  }
  const from = shiftReportLocalDate(to, -(days - 1));
  nutritionReportLocalDates(from, to);
  return { from, to };
}

export function nutritionReportDiaryDates(
  day: Pick<NutritionReportDay, "entryCount" | "localDate" | "sourceDiaries">,
): readonly string[] {
  const dates =
    day.entryCount === 0 && day.sourceDiaries.length === 0
      ? [day.localDate]
      : day.sourceDiaries.map((source) => source.localDate);
  if (dates.some((date) => !isLocalDate(date))) throw new RangeError("Invalid source diary date.");
  return [...new Set(dates)].sort();
}

export function nutritionReportAdjacentRange(
  from: string,
  to: string,
  direction: "previous" | "next",
): { readonly from: string; readonly to: string } | null {
  const days = nutritionReportLocalDates(from, to).length;
  if (direction !== "previous" && direction !== "next")
    throw new RangeError("Invalid report direction.");
  const offset = direction === "previous" ? -days : days;
  const shiftedFrom = shiftReportLocalDate(from, offset);
  const shiftedTo = shiftReportLocalDate(to, offset);
  if (shiftedFrom < "0002-01-01" || shiftedTo > "9998-12-31") return null;
  nutritionReportLocalDates(shiftedFrom, shiftedTo);
  return { from: shiftedFrom, to: shiftedTo };
}

export function nutritionReportPath(from: string, to: string): string {
  nutritionReportLocalDates(from, to);
  return `/v1/reports/nutrition?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export function nutritionReportRequestIdentityMatches(
  current: NutritionReportRequestFence,
  initiating: NutritionReportRequestFence,
): boolean {
  return (
    current.ownerUserId === initiating.ownerUserId &&
    current.sessionEpoch === initiating.sessionEpoch &&
    current.profileRevision === initiating.profileRevision &&
    current.timeZone === initiating.timeZone &&
    current.from === initiating.from &&
    current.to === initiating.to &&
    current.generation === initiating.generation
  );
}

export function nutritionReportTargetMarkerPosition(
  value: string,
): NutritionReportTargetMarkerPosition {
  if (!percentage(value)) {
    throw new RangeError("A nutrition report marker percentage must be between 0 and 100.");
  }
  const position = Number(value);
  return position === 100 ? { right: 0 } : { left: `${position}%` };
}

function parseAggregate(value: unknown): DiaryNutrientAggregate {
  if (
    !record(value) ||
    !exactKeys(value, AGGREGATE_KEYS) ||
    typeof value.nutrientId !== "string" ||
    !POSITIVE_IDENTIFIER.test(value.nutrientId) ||
    !text(value.code, 64) ||
    !text(value.name, 200) ||
    !text(value.unit, 32) ||
    !decimal(value.knownAmount) ||
    !["complete", "partial", "unknown"].includes(String(value.completeness)) ||
    typeof value.isExact !== "boolean" ||
    !count(value.contributorCount) ||
    Number(value.contributorCount) < 1 ||
    !count(value.quantifiedCount) ||
    !count(value.traceCount) ||
    !count(value.unknownCount) ||
    !record(value.unknownReasonCounts) ||
    !exactKeys(value.unknownReasonCounts, [
      "not_reported",
      "not_analyzed",
      "not_applicable",
      "withheld",
    ]) ||
    !Object.values(value.unknownReasonCounts).every(count)
  ) {
    throw new TypeError("A nutrition report aggregate was invalid.");
  }
  const contributorCount = Number(value.contributorCount);
  const quantifiedCount = Number(value.quantifiedCount);
  const traceCount = Number(value.traceCount);
  const unknownCount = Number(value.unknownCount);
  const unknownReasonTotal = Object.values(value.unknownReasonCounts).reduce<number>(
    (sum, item) => sum + Number(item),
    0,
  );
  const expectedCompleteness =
    unknownCount === contributorCount ? "unknown" : unknownCount === 0 ? "complete" : "partial";
  if (
    quantifiedCount + traceCount + unknownCount !== contributorCount ||
    unknownReasonTotal !== unknownCount ||
    value.completeness !== expectedCompleteness ||
    value.isExact !== (unknownCount === 0 && traceCount === 0)
  ) {
    throw new TypeError("Nutrition report coverage counts were inconsistent.");
  }
  return value as unknown as DiaryNutrientAggregate;
}

function parseDefinition(value: unknown): NutritionReportNutrientDefinition {
  if (
    !record(value) ||
    !exactKeys(value, ["id", "code", "name", "unit", "category"]) ||
    typeof value.id !== "string" ||
    !POSITIVE_IDENTIFIER.test(value.id) ||
    !text(value.code, 64) ||
    !text(value.name, 200) ||
    !text(value.unit, 32) ||
    typeof value.category !== "string" ||
    !CATEGORIES.has(value.category)
  ) {
    throw new TypeError("A nutrition report nutrient definition was invalid.");
  }
  return value as unknown as NutritionReportNutrientDefinition;
}

function parseTargetSnapshot(value: unknown): NutritionReportTargetSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, ["minimumAmount", "targetAmount", "maximumAmount", "source", "rationale"]) ||
    !(value.minimumAmount === null || decimal(value.minimumAmount)) ||
    !(value.targetAmount === null || decimal(value.targetAmount)) ||
    !(value.maximumAmount === null || decimal(value.maximumAmount)) ||
    (value.minimumAmount === null && value.targetAmount === null && value.maximumAmount === null) ||
    !record(value.source) ||
    !exactKeys(value.source, ["label", "version"]) ||
    !text(value.source.label, 160) ||
    !(value.source.version === null || text(value.source.version, 100)) ||
    !(value.rationale === null || text(value.rationale, 1_000))
  ) {
    throw new TypeError("A nutrition report target snapshot was invalid.");
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
    value.targets.length > 15
  ) {
    throw new TypeError("A nutrition report goal version was invalid.");
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
      !text(value.reference.templateCode, 100) ||
      !text(value.reference.templateVersion, 100) ||
      !text(value.reference.groupCode, 100) ||
      typeof value.reference.policyDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.reference.policyDigest) ||
      !isLocalDate(value.reference.eligibleThroughExclusive)
    ) {
      throw new TypeError("Nutrition report reference-target provenance was invalid.");
    }
  }
  const targets = value.targets.map((target) => {
    if (
      !record(target) ||
      !exactKeys(target, ["nutrientId", "snapshot"]) ||
      typeof target.nutrientId !== "string" ||
      !POSITIVE_IDENTIFIER.test(target.nutrientId)
    ) {
      throw new TypeError("A nutrition report goal target was invalid.");
    }
    return {
      nutrientId: String(target.nutrientId),
      snapshot: parseTargetSnapshot(target.snapshot),
    };
  });
  if (new Set(targets.map((target) => target.nutrientId)).size !== targets.length) {
    throw new TypeError("A nutrition report goal repeated a nutrient target.");
  }
  return { ...(value as unknown as NutritionReportGoalVersion), targets };
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
    !timestamp(value.startsAt) ||
    !timestamp(value.endsAt) ||
    Date.parse(value.startsAt) >= Date.parse(value.endsAt) ||
    localDateInTimeZone(new Date(value.startsAt), reportTimeZone) !== expectedDate ||
    localDateInTimeZone(new Date(Date.parse(value.startsAt) - 1), reportTimeZone) !==
      shiftReportLocalDate(expectedDate, -1) ||
    localDateInTimeZone(new Date(Date.parse(value.endsAt) - 1), reportTimeZone) !== expectedDate ||
    localDateInTimeZone(new Date(value.endsAt), reportTimeZone) !==
      shiftReportLocalDate(expectedDate, 1) ||
    !count(value.entryCount) ||
    !Array.isArray(value.sourceDiaries) ||
    value.sourceDiaries.length > 31 ||
    !Array.isArray(value.sourceTimeZones) ||
    value.sourceTimeZones.length > 50
  ) {
    throw new TypeError("A nutrition report day was invalid.");
  }
  const sourceDiaries = value.sourceDiaries.map((source) => {
    if (
      !record(source) ||
      !exactKeys(source, ["id", "localDate", "revision"]) ||
      typeof source.id !== "string" ||
      !UUID.test(source.id) ||
      !isLocalDate(source.localDate) ||
      typeof source.revision !== "string" ||
      !POSITIVE_REVISION.test(source.revision)
    ) {
      throw new TypeError("A nutrition report source diary was invalid.");
    }
    return source as unknown as NutritionReportDay["sourceDiaries"][number];
  });
  if (
    new Set(sourceDiaries.map((source) => source.id)).size !== sourceDiaries.length ||
    !value.sourceTimeZones.every((zone) => typeof zone === "string" && isSupportedTimeZone(zone)) ||
    new Set(value.sourceTimeZones).size !== value.sourceTimeZones.length ||
    (Number(value.entryCount) === 0 &&
      (sourceDiaries.length !== 0 || value.sourceTimeZones.length !== 0)) ||
    (Number(value.entryCount) > 0 &&
      (sourceDiaries.length === 0 || value.sourceTimeZones.length === 0))
  ) {
    throw new TypeError("Nutrition report day provenance was inconsistent.");
  }
  return {
    endsAt: value.endsAt,
    entryCount: Number(value.entryCount),
    localDate: value.localDate,
    sourceDiaries,
    sourceTimeZones: value.sourceTimeZones as string[],
    startsAt: value.startsAt,
  };
}

function parseComparison(value: unknown): NutritionReportComparison {
  if (
    !record(value) ||
    !exactKeys(value, [
      "minimumState",
      "targetLowerBoundPercent",
      "targetPercentIsExact",
      "maximumState",
    ]) ||
    !(
      value.minimumState === null ||
      (typeof value.minimumState === "string" && THRESHOLD_STATES.has(value.minimumState))
    ) ||
    !(value.targetLowerBoundPercent === null || decimal(value.targetLowerBoundPercent)) ||
    !(value.targetPercentIsExact === null || typeof value.targetPercentIsExact === "boolean") ||
    !(
      value.maximumState === null ||
      (typeof value.maximumState === "string" && THRESHOLD_STATES.has(value.maximumState))
    )
  ) {
    throw new TypeError("A nutrition report target comparison was invalid.");
  }
  return value as unknown as NutritionReportComparison;
}

function parsePoint(
  value: unknown,
  nutrient: NutritionReportNutrientDefinition,
  expectedDate: string,
  day: NutritionReportDay,
  goalsByVersion: ReadonlyMap<string, NutritionReportGoalVersion>,
): NutritionReportSeriesPoint {
  if (
    !record(value) ||
    !exactKeys(value, [
      "localDate",
      "goalVersionId",
      "aggregate",
      "knownPercentOfScale",
      "minimumPercentOfScale",
      "targetPercentOfScale",
      "maximumPercentOfScale",
      "comparison",
    ]) ||
    value.localDate !== expectedDate ||
    !(
      value.goalVersionId === null ||
      (typeof value.goalVersionId === "string" && UUID.test(value.goalVersionId))
    ) ||
    !(value.knownPercentOfScale === null || percentage(value.knownPercentOfScale)) ||
    !(value.minimumPercentOfScale === null || percentage(value.minimumPercentOfScale)) ||
    !(value.targetPercentOfScale === null || percentage(value.targetPercentOfScale)) ||
    !(value.maximumPercentOfScale === null || percentage(value.maximumPercentOfScale))
  ) {
    throw new TypeError("A nutrition report series point was invalid.");
  }
  const aggregate = value.aggregate === null ? null : parseAggregate(value.aggregate);
  if (
    (day.entryCount === 0) !== (aggregate === null) ||
    (aggregate !== null &&
      (aggregate.nutrientId !== nutrient.id ||
        aggregate.code !== nutrient.code ||
        aggregate.name !== nutrient.name ||
        aggregate.unit !== nutrient.unit)) ||
    (aggregate === null) !== (value.knownPercentOfScale === null)
  ) {
    throw new TypeError("Nutrition report point coverage was inconsistent with its day.");
  }
  const goal =
    value.goalVersionId === null
      ? null
      : (goalsByVersion.get(value.goalVersionId as string) ?? null);
  if (value.goalVersionId !== null && goal === null) {
    throw new TypeError("A nutrition report point named an unknown goal version.");
  }
  const target = goal?.targets.find((candidate) => candidate.nutrientId === nutrient.id)?.snapshot;
  const expectedMinimum = target?.minimumAmount ?? null;
  const expectedTarget = target?.targetAmount ?? null;
  const expectedMaximum = target?.maximumAmount ?? null;
  if (
    (value.minimumPercentOfScale === null) !== (expectedMinimum === null) ||
    (value.targetPercentOfScale === null) !== (expectedTarget === null) ||
    (value.maximumPercentOfScale === null) !== (expectedMaximum === null)
  ) {
    throw new TypeError("Nutrition report target markers did not match the saved goal snapshot.");
  }
  const comparison = value.comparison === null ? null : parseComparison(value.comparison);
  if ((aggregate !== null && target !== undefined) !== (comparison !== null)) {
    throw new TypeError("Nutrition report target comparison availability was inconsistent.");
  }
  const targetIsZero = expectedTarget !== null && /^0(?:\.0+)?$/u.test(expectedTarget);
  if (
    comparison &&
    expectedTarget !== null &&
    comparison.targetPercentIsExact !== aggregate?.isExact
  ) {
    throw new TypeError("Nutrition report target-percentage exactness was inconsistent.");
  }
  if (
    comparison &&
    ((comparison.minimumState === null) !== (expectedMinimum === null) ||
      (expectedTarget === null
        ? comparison.targetLowerBoundPercent !== null || comparison.targetPercentIsExact !== null
        : targetIsZero
          ? comparison.targetLowerBoundPercent !== null || comparison.targetPercentIsExact === null
          : comparison.targetLowerBoundPercent === null ||
            comparison.targetPercentIsExact === null) ||
      (comparison.maximumState === null) !== (expectedMaximum === null))
  ) {
    throw new TypeError("Nutrition report comparison thresholds were inconsistent.");
  }
  return {
    aggregate,
    comparison,
    goalVersionId: value.goalVersionId as string | null,
    knownPercentOfScale: value.knownPercentOfScale as string | null,
    localDate: value.localDate,
    maximumPercentOfScale: value.maximumPercentOfScale as string | null,
    minimumPercentOfScale: value.minimumPercentOfScale as string | null,
    targetPercentOfScale: value.targetPercentOfScale as string | null,
  };
}

function parseSeries(
  value: unknown,
  dates: readonly string[],
  days: readonly NutritionReportDay[],
  goalsByVersion: ReadonlyMap<string, NutritionReportGoalVersion>,
): NutritionReportSeries {
  if (
    !record(value) ||
    !exactKeys(value, ["nutrient", "scalePolicy", "scaleMaximum", "summary", "points"]) ||
    value.scalePolicy !== "max-intake-or-saved-threshold-v1" ||
    !positiveDecimal(value.scaleMaximum) ||
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
    !Object.values(value.summary).every((item) => count(item) && Number(item) <= dates.length) ||
    !Array.isArray(value.points) ||
    value.points.length !== dates.length
  ) {
    throw new TypeError("A nutrition report series was invalid.");
  }
  const nutrient = parseDefinition(value.nutrient);
  const points = value.points.map((point, index) => {
    const date = dates[index];
    const day = days[index];
    if (!date || !day) throw new TypeError("A nutrition report series day was missing.");
    return parsePoint(point, nutrient, date, day, goalsByVersion);
  });
  const computed = {
    completeDays: points.filter((point) => point.aggregate?.completeness === "complete").length,
    diaryDays: points.filter((point) => point.aggregate !== null).length,
    exactDays: points.filter((point) => point.aggregate?.isExact === true).length,
    missingDays: points.filter((point) => point.aggregate === null).length,
    partialDays: points.filter((point) => point.aggregate?.completeness === "partial").length,
    traceDays: points.filter((point) => (point.aggregate?.traceCount ?? 0) > 0).length,
    unknownDays: points.filter((point) => point.aggregate?.completeness === "unknown").length,
  };
  if (
    Object.entries(computed).some(
      ([key, expected]) => (value.summary as Record<string, unknown>)[key] !== expected,
    ) ||
    computed.completeDays + computed.partialDays + computed.unknownDays + computed.missingDays !==
      dates.length
  ) {
    throw new TypeError("Nutrition report summary counts were inconsistent.");
  }
  return {
    nutrient,
    points,
    scaleMaximum: value.scaleMaximum,
    scalePolicy: value.scalePolicy,
    summary: computed,
  };
}

function parseSegments(
  value: unknown,
  dates: readonly string[],
  goalsByVersion: ReadonlyMap<string, NutritionReportGoalVersion>,
): readonly NutritionReportTargetSegment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > dates.length) {
    throw new TypeError("Nutrition report target boundaries were invalid.");
  }
  const segments = value.map((segment) => {
    if (
      !record(segment) ||
      !exactKeys(segment, ["from", "to", "goalVersionId"]) ||
      !isLocalDate(segment.from) ||
      !isLocalDate(segment.to) ||
      !(
        segment.goalVersionId === null ||
        (typeof segment.goalVersionId === "string" && UUID.test(segment.goalVersionId))
      ) ||
      (segment.goalVersionId !== null && !goalsByVersion.has(segment.goalVersionId as string))
    ) {
      throw new TypeError("A nutrition report target boundary was invalid.");
    }
    nutritionReportLocalDates(segment.from, segment.to);
    const goal =
      segment.goalVersionId === null
        ? null
        : (goalsByVersion.get(segment.goalVersionId as string) ?? null);
    if (
      goal &&
      (goal.effectiveFrom > segment.from ||
        (goal.effectiveTo !== null && segment.to >= goal.effectiveTo) ||
        (goal.reference !== null && segment.to >= goal.reference.eligibleThroughExclusive))
    ) {
      throw new TypeError("A nutrition report target boundary exceeded its saved goal period.");
    }
    return segment as unknown as NutritionReportTargetSegment;
  });
  const expanded = segments.flatMap((segment) =>
    nutritionReportLocalDates(segment.from, segment.to).map((localDate) => ({
      goalVersionId: segment.goalVersionId,
      localDate,
    })),
  );
  if (
    expanded.length !== dates.length ||
    expanded.some((item, index) => item.localDate !== dates[index]) ||
    segments.some(
      (segment, index) => index > 0 && segments[index - 1]?.goalVersionId === segment.goalVersionId,
    )
  ) {
    throw new TypeError("Nutrition report target boundaries did not cover the requested days.");
  }
  return segments;
}

export function parseNutritionReport(
  value: unknown,
  expected: NutritionReportExpectation,
): NutritionReportResponse["data"] {
  const dates = nutritionReportLocalDates(expected.from, expected.to);
  if (!record(value) || !exactKeys(value, ["data"]) || !record(value.data)) {
    throw new TypeError("The nutrition report response envelope was invalid.");
  }
  const data = value.data;
  if (
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
    !isSupportedTimeZone(String(data.timeZone)) ||
    typeof data.watermarkRevision !== "string" ||
    !REVISION.test(data.watermarkRevision) ||
    !timestamp(data.snapshotAt) ||
    data.dateBasis !== "active-profile-time-zone-v1" ||
    data.goalVersionBasis !== "current-version-at-report-snapshot-v1" ||
    data.from !== expected.from ||
    data.to !== expected.to ||
    data.ownerUserId !== expected.ownerUserId ||
    data.profileRevision !== expected.profileRevision ||
    data.timeZone !== expected.timeZone ||
    data.notice !== NUTRITION_REPORT_NOTICE ||
    !Array.isArray(data.days) ||
    data.days.length !== dates.length ||
    !Array.isArray(data.goalVersions) ||
    data.goalVersions.length > dates.length ||
    !Array.isArray(data.series) ||
    data.series.length !== REPORT_NUTRIENTS.length
  ) {
    throw new TypeError("The nutrition report identity or snapshot metadata was invalid.");
  }
  const days = data.days.map((day, index) => {
    const date = dates[index];
    if (!date) throw new TypeError("A nutrition report date was missing.");
    return parseDay(day, date, expected.timeZone);
  });
  const goalVersions = data.goalVersions.map(parseGoalVersion);
  if (new Set(goalVersions.map((goal) => goal.versionId)).size !== goalVersions.length) {
    throw new TypeError("Nutrition report goal versions were duplicated.");
  }
  const goalsByVersion = new Map(goalVersions.map((goal) => [goal.versionId, goal]));
  const series = data.series.map((item) => parseSeries(item, dates, days, goalsByVersion));
  if (
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
    throw new TypeError("Nutrition report core nutrient series were incomplete or duplicated.");
  }
  const nutrientIds = new Set(series.map((item) => item.nutrient.id));
  if (
    goalVersions.some((goal) => goal.targets.some((target) => !nutrientIds.has(target.nutrientId)))
  ) {
    throw new TypeError("A nutrition report goal targeted a nutrient outside the report.");
  }
  const targetSegments = parseSegments(data.targetSegments, dates, goalsByVersion);
  const canonicalGoalIds = series[0]?.points.map((point) => point.goalVersionId) ?? [];
  const segmentGoalIds = targetSegments.flatMap((segment) =>
    nutritionReportLocalDates(segment.from, segment.to).map(() => segment.goalVersionId),
  );
  if (
    canonicalGoalIds.length !== dates.length ||
    series.some((item) =>
      item.points.some((point, index) => point.goalVersionId !== canonicalGoalIds[index]),
    ) ||
    segmentGoalIds.some((goalVersionId, index) => goalVersionId !== canonicalGoalIds[index]) ||
    new Set(canonicalGoalIds.filter((goalId): goalId is string => goalId !== null)).size !==
      goalVersions.length
  ) {
    throw new TypeError("Nutrition report goal-version boundaries were inconsistent.");
  }
  return {
    dateBasis: data.dateBasis,
    days,
    from: data.from,
    goalVersionBasis: data.goalVersionBasis,
    goalVersions,
    notice: data.notice,
    ownerUserId: data.ownerUserId,
    profileRevision: data.profileRevision,
    series,
    snapshotAt: data.snapshotAt,
    targetSegments,
    timeZone: data.timeZone,
    to: data.to,
    watermarkRevision: data.watermarkRevision,
  };
}

function thresholdLabel(kind: "minimum" | "maximum", state: string | null): string | null {
  if (state === null) return null;
  if (state === "indeterminate") return `${kind} threshold indeterminate`;
  return `${kind} threshold ${state}`;
}

export function nutritionReportPointDisplay(
  point: NutritionReportSeriesPoint,
  unit: string,
): NutritionReportPointDisplay {
  if (point.aggregate === null) {
    return {
      amount: "No diary entries",
      comparison:
        point.goalVersionId === null
          ? "No saved target applied."
          : "A saved target applied, but there is no diary amount to compare.",
      coverage: "Missing day; this is not a measured zero.",
    };
  }
  const aggregate = point.aggregate;
  const amount =
    aggregate.completeness === "unknown"
      ? "Unknown"
      : `${aggregate.isExact ? "" : "≥ "}${aggregate.knownAmount} ${unit}`;
  const coverage =
    aggregate.completeness === "unknown"
      ? `Unknown coverage · 0/${aggregate.contributorCount} contributions quantified`
      : aggregate.completeness === "partial"
        ? `Partial coverage · ${aggregate.quantifiedCount} quantified · ${aggregate.traceCount} trace · ${aggregate.unknownCount} unknown of ${aggregate.contributorCount} contributions`
        : aggregate.traceCount > 0
          ? `Complete coverage · ${aggregate.traceCount} trace ${aggregate.traceCount === 1 ? "contribution" : "contributions"}; amount is a lower bound`
          : "Complete coverage · quantified amount";
  if (point.comparison === null) {
    return {
      amount,
      comparison:
        point.goalVersionId === null
          ? "No saved target applied."
          : "No saved threshold exists for this nutrient.",
      coverage,
    };
  }
  const pieces = [
    thresholdLabel("minimum", point.comparison.minimumState),
    point.comparison.targetLowerBoundPercent === null
      ? point.comparison.targetPercentIsExact === null
        ? null
        : "target percentage unavailable because the saved target is zero"
      : `${point.comparison.targetPercentIsExact ? "" : "at least "}${point.comparison.targetLowerBoundPercent}% of saved target`,
    thresholdLabel("maximum", point.comparison.maximumState),
  ].filter((piece): piece is string => piece !== null);
  return { amount, comparison: `Saved comparison: ${pieces.join(" · ")}.`, coverage };
}

export function nutritionReportCoverageSummary(series: NutritionReportSeries): string {
  const { summary } = series;
  return `${summary.exactDays} exact, ${summary.partialDays} partial, ${summary.unknownDays} unknown, ${summary.traceDays} with trace amounts, and ${summary.missingDays} missing ${summary.missingDays === 1 ? "day" : "days"}.`;
}

export function nutritionReportBoundarySummary(
  segments: readonly NutritionReportTargetSegment[],
): string {
  if (segments.length === 1) {
    return segments[0]?.goalVersionId === null
      ? "No saved goal applied anywhere in this range."
      : "One saved goal version applied across this whole range.";
  }
  return `${segments.length} saved-target periods apply in this range. Boundaries are shown below.`;
}
