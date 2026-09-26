"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  type DiaryDay,
  type DiaryNutrient,
  defaultDiaryGroups,
  nutrientDisplay,
  type SessionSummary,
} from "../../lib/diary";
import { formatNutrientAmount } from "../../lib/nutrition-display";
import type { GoalProgressView } from "../../lib/recipes-goals";
import { Icon } from "../ui/Icon";
import { NutrientIcon } from "../ui/NutrientIcon";
import {
  goalPercent,
  goalPercentLabel,
  loadCalmGoalProgress,
  matchedGoalRow,
  mealEnergy,
  remainingEnergy,
} from "./calm-overview";

const macros = [
  { code: "protein", label: "Protein" },
  { code: "carbohydrate", label: "Carbs" },
  { code: "fat", label: "Fat" },
] as const;
const snapshot = [
  { code: "fiber", label: "Fiber" },
  { code: "calcium", label: "Calcium" },
  { code: "iron", label: "Iron" },
  { code: "vitamin-d", label: "Vitamin D" },
] as const;

interface CalmOverviewProps {
  readonly day: DiaryDay;
  readonly totalEntries: number;
  readonly completeDayLoaded: boolean;
  readonly session: SessionSummary;
  readonly isCurrent: () => boolean;
  readonly onUnauthorized: () => void;
}

function displayNutrient(nutrient: DiaryNutrient | undefined) {
  return nutrient
    ? nutrientDisplay(nutrient)
    : { amount: "Unknown", qualification: "No nutrient total available" };
}

function Target({
  nutrient,
  progress,
  ring = false,
}: {
  readonly nutrient: DiaryNutrient | undefined;
  readonly progress: GoalProgressView | null;
  readonly ring?: boolean;
}) {
  const row = matchedGoalRow(nutrient, progress);
  const percent = goalPercent(nutrient, row);
  const label = goalPercentLabel(nutrient, row);
  if (ring)
    return percent === null ? null : (
      <svg aria-hidden="true" className="calmEnergyRing" viewBox="0 0 120 120">
        <circle className="calmEnergyRingTrack" cx="60" cy="60" r="52" />
        {percent > 0 ? (
          <circle
            className="calmEnergyRingValue"
            cx="60"
            cy="60"
            r="52"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - percent}
            transform="rotate(-90 60 60)"
          />
        ) : null}
      </svg>
    );
  return (
    <>
      {row?.target ? (
        <small className="calmTarget">
          Saved target: {formatNutrientAmount(row.target.amount, row.unit)}
        </small>
      ) : null}
      {percent !== null ? (
        <>
          <div aria-hidden="true" className="calmProgressTrack">
            <span style={{ width: `${percent}%` }} />
          </div>
          <small className="calmProgressLabel" title={`${label} of saved target`}>
            {label}
            <span className="srOnly"> of saved target</span>
          </small>
        </>
      ) : null}
    </>
  );
}

export function CalmOverview({
  day,
  totalEntries,
  completeDayLoaded,
  session,
  isCurrent,
  onUnauthorized,
}: CalmOverviewProps) {
  const [goals, setGoals] = useState<{
    readonly scope: string;
    readonly progress: GoalProgressView | null;
    readonly error: string | null;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify([
    session.user.id,
    session.profile.revision,
    session.profile.timeZone,
    day.localDate,
    day.timeZone,
    day.revision,
    retry,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    setGoals(null);
    void loadCalmGoalProgress({
      day,
      session,
      signal: controller.signal,
      isCurrent,
      onUnauthorized,
    })
      .then((progress) => {
        if (progress && !controller.signal.aborted && isCurrent())
          setGoals({ scope, progress, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && isCurrent())
          setGoals({
            scope,
            progress: null,
            error: error instanceof Error ? error.message : "Saved targets could not be loaded.",
          });
      });
    return () => controller.abort();
  }, [day, session, scope, isCurrent, onUnauthorized]);
  const currentGoals = goals?.scope === scope && isCurrent() ? goals : null;
  const progress = currentGoals?.progress ?? null;
  const energy = day.totals.find((nutrient) => nutrient.code === "energy");
  const energyDisplay = displayNutrient(energy);
  const energyRow = matchedGoalRow(energy, progress);
  const energyPercent = goalPercent(energy, energyRow);
  const energyPercentLabel = goalPercentLabel(energy, energyRow);
  const remaining = remainingEnergy(energy, energyRow);
  const dateQuery = `?date=${encodeURIComponent(day.localDate)}`;

  return (
    <div className="calmOverview">
      <section aria-labelledby="daily-summary-title" className="calmSummary">
        <div className="calmSummaryHeading">
          <h2 className="srOnly" id="daily-summary-title">
            Daily nutrition
          </h2>
          <span>
            {totalEntries} {totalEntries === 1 ? "entry" : "entries"} logged
          </span>
        </div>
        <div className="calmSummaryBody">
          <div
            className="calmEnergy"
            data-nutrient="energy"
            data-completeness={energy?.completeness ?? "unknown"}
            data-exact={energy?.isExact ?? false}
          >
            <div
              className={`calmEnergyGraphic${energyPercent === null ? " calmEnergyGraphic--untracked" : ""}`}
            >
              <Target nutrient={energy} progress={progress} ring />
              <div className="calmEnergyValue">
                <NutrientIcon nutrient="energy" />
                <span>Energy</span>
                <strong>{energyDisplay.amount}</strong>
                {energyRow?.target ? (
                  <small className="calmTarget">
                    Saved target: {formatNutrientAmount(energyRow.target.amount, energyRow.unit)}
                  </small>
                ) : null}
              </div>
            </div>
            {remaining ? <strong className="calmEnergyRemaining">{remaining}</strong> : null}
            <small className="calmQualification">{energyDisplay.qualification}</small>
            {energyPercentLabel ? (
              <span className="srOnly">{energyPercentLabel} of saved target</span>
            ) : null}
          </div>
          <section className="calmMacros" aria-labelledby="calm-macros-title">
            <h3 id="calm-macros-title">Macronutrients</h3>
            <dl>
              {macros.map(({ code, label }) => {
                const nutrient = day.totals.find((candidate) => candidate.code === code);
                const display = displayNutrient(nutrient);
                const row = matchedGoalRow(nutrient, progress);
                const percent = goalPercent(nutrient, row);
                const percentLabel = goalPercentLabel(nutrient, row);
                return (
                  <div
                    className="calmMacroRow"
                    data-nutrient={code}
                    data-completeness={nutrient?.completeness ?? "unknown"}
                    data-exact={nutrient?.isExact ?? false}
                    key={code}
                  >
                    <dt>
                      <NutrientIcon nutrient={code} />
                      {label}
                    </dt>
                    <dd>
                      <div className="calmMacroMetric">
                        <strong>{display.amount}</strong>
                        {row?.target ? (
                          <span>
                            <span aria-hidden="true"> / </span>
                            <span className="srOnly">of saved target </span>
                            {formatNutrientAmount(row.target.amount, row.unit)}
                          </span>
                        ) : null}
                        {percentLabel ? <span>({percentLabel})</span> : null}
                      </div>
                      <small className="calmQualification">{display.qualification}</small>
                      {percent !== null ? (
                        <div aria-hidden="true" className="calmProgressTrack">
                          <span style={{ width: `${percent}%` }} />
                        </div>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        </div>
        <div className="calmSummaryFooter">
          <p>
            Totals cover all {totalEntries} diary {totalEntries === 1 ? "entry" : "entries"}.
            Partial totals are lower bounds; unknown values are never counted as zero.
          </p>
          {currentGoals?.error ? (
            <p role="status">
              {currentGoals.error}{" "}
              <button
                className="buttonQuiet"
                type="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry targets
              </button>
            </p>
          ) : !currentGoals ? (
            <p role="status">Loading saved targets…</p>
          ) : !progress?.goal ? (
            <p>
              No saved goal for this day. <Link href={`/goals${dateQuery}`}>Set your targets</Link>
            </p>
          ) : (
            <Link href={`/goals${dateQuery}`}>View saved targets</Link>
          )}
        </div>
      </section>
      <div className="calmOverviewGrid">
        <section aria-labelledby="calm-meals-title" className="calmMeals">
          <div className="calmCardHeading">
            <h2 id="calm-meals-title">Today’s meals</h2>
            <Link href={`/dashboard${dateQuery}`}>
              Open diary <Icon name="chevron-right" />
            </Link>
          </div>
          {!completeDayLoaded ? (
            <p className="calmMealCoverage">
              Showing {day.entries.length} of {totalEntries} entries. Meal counts cover loaded
              entries only; open the diary and load the complete day for meal energy totals.
            </p>
          ) : null}
          <ul className="calmMealList">
            {session.profile.diaryGroups.map((group) => {
              const entries = day.entries.filter((entry) => entry.mealSlot === group.mealSlot);
              const names = entries
                .slice(0, 2)
                .map((entry) => (entry.entryKind === "food" ? entry.food.name : entry.recipe.name));
              const standardGroup = defaultDiaryGroups.some(
                (standard) =>
                  standard.mealSlot === group.mealSlot && standard.label === group.label,
              );
              const mealIcon = standardGroup
                ? (
                    { breakfast: "sun", lunch: "recipes", dinner: "moon", snacks: "foods" } as const
                  )[group.mealSlot]
                : "recipes";
              return (
                <li className="calmMealRow" key={group.mealSlot}>
                  <span className="calmMealIcon">
                    <Icon name={mealIcon} />
                  </span>
                  <div className="calmMealDescription">
                    <h3>{group.label}</h3>
                    <p>
                      {names.length
                        ? `${names.join(", ")}${entries.length > 2 ? ` + ${entries.length - 2} more` : ""}`
                        : completeDayLoaded
                          ? "No foods logged"
                          : "No entries loaded yet"}
                    </p>
                    <small>
                      {entries.length} {completeDayLoaded ? "" : "loaded "}
                      {entries.length === 1 ? "entry" : "entries"}
                    </small>
                  </div>
                  <strong className="calmMealEnergy">
                    {completeDayLoaded ? mealEnergy(entries) : "Meal energy unavailable"}
                  </strong>
                  <Link
                    className="calmMealAdd"
                    aria-label={`Add food to ${group.label}`}
                    href={`/foods${dateQuery}&meal=${group.mealSlot}`}
                  >
                    <Icon name="plus" /> Add
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-labelledby="calm-snapshot-title" className="calmSnapshot">
          <div className="calmCardHeading">
            <h2 id="calm-snapshot-title">Nutrient snapshot</h2>
          </div>
          <dl>
            {snapshot.map(({ code, label }) => {
              const nutrient = day.totals.find((candidate) => candidate.code === code);
              const display = displayNutrient(nutrient);
              return (
                <div
                  className="calmSnapshotRow"
                  data-nutrient={code}
                  data-completeness={nutrient?.completeness ?? "unknown"}
                  data-exact={nutrient?.isExact ?? false}
                  key={code}
                >
                  <dt>{label}</dt>
                  <dd>
                    <strong>{display.amount}</strong>
                    <small className="calmQualification">{display.qualification}</small>
                    <Target nutrient={nutrient} progress={progress} />
                  </dd>
                </div>
              );
            })}
          </dl>
          <Link
            className="calmCardFooter"
            href={`/reports?to=${encodeURIComponent(day.localDate)}`}
          >
            View full nutrition report <Icon name="chevron-right" />
          </Link>
        </section>
      </div>
    </div>
  );
}
