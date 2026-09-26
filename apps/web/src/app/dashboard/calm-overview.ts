import {
  type DiaryDay,
  type DiaryEntry,
  type DiaryNutrient,
  parseSession,
  type SessionSummary,
} from "../../lib/diary";
import {
  type GoalProgressRowView,
  type GoalProgressView,
  nutrientProgressPresentation,
  parseGoalProgress,
} from "../../lib/recipes-goals";

// Amounts stay decimal strings. BigInt adds the bounded, already-validated diary
// decimals without rounding a food contribution through a JavaScript number.
function sumAmounts(amounts: readonly string[]): string {
  const scale = Math.max(0, ...amounts.map((amount) => amount.split(".")[1]?.length ?? 0));
  const total = amounts.reduce((sum, amount) => {
    const [whole = "0", fraction = ""] = amount.split(".");
    return sum + BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/u, "");
}

export function mealEnergy(entries: readonly DiaryEntry[]): string {
  if (entries.length === 0) return "No foods logged";
  const energy = entries.map((entry) =>
    entry.nutrients.find(
      (nutrient) =>
        ["energy", "ENERGY", "ENERGY_KCAL", "CALORIES", "energy_kcal"].includes(nutrient.code) &&
        nutrient.unit === "kcal",
    ),
  );
  const known = energy.filter(
    (nutrient): nutrient is DiaryNutrient =>
      nutrient !== undefined && nutrient.completeness !== "unknown",
  );
  if (known.length === 0) return "Energy unknown";
  const exact =
    known.length === entries.length &&
    known.every(
      (nutrient) =>
        nutrient.completeness === "complete" && nutrient.isExact && nutrient.traceCount === 0,
    );
  return `${exact ? "" : "≥ "}${sumAmounts(known.map((nutrient) => nutrient.knownAmount))} kcal${exact ? "" : " · lower bound"}`;
}

export function matchedGoalRow(
  nutrient: DiaryNutrient | undefined,
  progress: GoalProgressView | null,
): GoalProgressRowView | null {
  if (!nutrient || !progress?.goal) return null;
  const row = [progress.energy, ...progress.nutrients].find(
    (candidate) =>
      candidate?.nutrientId === nutrient.nutrientId &&
      candidate.code === nutrient.code &&
      candidate.unit === nutrient.unit,
  );
  if (
    !row ||
    sumAmounts([row.knownAmount]) !== sumAmounts([nutrient.knownAmount]) ||
    row.completeness !== nutrient.completeness ||
    (row.amountInterpretation === "exact") !==
      (nutrient.completeness === "complete" && nutrient.isExact && nutrient.traceCount === 0)
  )
    return null;
  return row;
}

export function goalPercent(
  nutrient: DiaryNutrient | undefined,
  row: GoalProgressRowView | null,
): number | null {
  if (!nutrient || nutrient.completeness === "unknown" || !row?.target) return null;
  return nutrientProgressPresentation({
    ...row,
    minimumAmount: row.minimum?.amount ?? null,
    maximumAmount: row.maximum?.amount ?? null,
    targetAmount: row.target.amount,
    lowerBoundPercent: row.target.lowerBoundPercent,
    percentIsExact: row.target.percentIsExact,
  }).progressPercent;
}

export function goalPercentLabel(
  nutrient: DiaryNutrient | undefined,
  row: GoalProgressRowView | null,
): string | null {
  const percent = goalPercent(nutrient, row);
  if (percent === null || !row?.target) return null;
  // Round/truncate the validated source decimal before conversion: Number can
  // shift a long value across a tenth or rounding boundary before formatting.
  const [whole = "0", fraction = ""] = (row.target.lowerBoundPercent ?? "0").split(".");
  let tenths = BigInt(whole) * 10n + BigInt(fraction[0] ?? "0");
  if (row.target.percentIsExact && Number(fraction[1] ?? "0") >= 5) tenths += 1n;
  const formatted = tenths % 10n === 0n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`;
  return `${row.target.percentIsExact ? "" : "≥ "}${formatted}%`;
}

export function remainingEnergy(
  nutrient: DiaryNutrient | undefined,
  row: GoalProgressRowView | null,
): string | null {
  if (
    nutrient?.completeness !== "complete" ||
    !nutrient.isExact ||
    nutrient.traceCount !== 0 ||
    !row?.target ||
    !row.target.percentIsExact ||
    !/[1-9]/u.test(row.target.amount)
  )
    return null;
  const amounts = [row.target.amount, nutrient.knownAmount];
  const scale = Math.max(...amounts.map((amount) => amount.split(".")[1]?.length ?? 0));
  const coefficients = amounts.map((amount) => {
    const [whole = "0", fraction = ""] = amount.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  });
  const difference = (coefficients[0] ?? 0n) - (coefficients[1] ?? 0n);
  const absolute = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, "0");
  const amount =
    scale === 0
      ? absolute
      : `${absolute.slice(0, -scale)}.${absolute.slice(-scale)}`.replace(/\.?0+$/u, "");
  return `${amount} ${nutrient.unit} ${difference < 0n ? "over saved target" : "remaining"}`;
}

export async function loadCalmGoalProgress({
  day,
  session,
  signal,
  isCurrent,
  onUnauthorized,
}: {
  readonly day: Pick<DiaryDay, "localDate" | "timeZone" | "revision">;
  readonly session: SessionSummary;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly onUnauthorized: () => void;
}): Promise<GoalProgressView | null> {
  const current = () => !signal.aborted && isCurrent();
  if (!current()) return null;
  const response = await fetch(`/api/goals/progress?date=${encodeURIComponent(day.localDate)}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!current()) return null;
  if (response.status === 401) {
    onUnauthorized();
    return null;
  }
  if (!response.ok) throw new Error("Saved targets could not be loaded.");
  const body: unknown = await response.json();
  if (!current()) return null;
  const progress = parseGoalProgress(body);
  const responseSession = await fetch("/api/auth/me", {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!current()) return null;
  if (responseSession.status === 401) {
    onUnauthorized();
    return null;
  }
  if (!responseSession.ok) throw new Error("Your session could not be revalidated safely.");
  const sessionBody: unknown = await responseSession.json();
  if (!current()) return null;
  const verified = parseSession(sessionBody);
  if (verified.user.id !== session.user.id) {
    onUnauthorized();
    return null;
  }
  if (
    verified.profile.revision !== session.profile.revision ||
    verified.profile.timeZone !== session.profile.timeZone
  )
    throw new Error("Your profile changed. Reload this day to see saved targets.");
  if (
    progress.localDate !== day.localDate ||
    progress.timeZone !== day.timeZone ||
    progress.diaryRevision !== day.revision
  )
    throw new Error("Your diary changed. Reload this day to see matching targets.");
  return current() ? progress : null;
}
