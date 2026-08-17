"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { createOperationId, isLocalDate, localDateInTimeZone, parseSession } from "../../lib/diary";
import {
  type GoalProgressView,
  type GoalView,
  goalWriteBody,
  isGoalDecimal,
  isRecipePositiveDecimal,
  isSignedGoalDecimal,
  nutrientProgressPresentation,
  parseCurrentGoal,
  parseGoalMutation,
  parseGoalProgress,
  parseTargetableNutrients,
  prepareStableMutation,
  type StableMutation,
  type TargetableNutrient,
} from "../../lib/recipes-goals";

interface TargetDraft {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: string;
  readonly targetAmount: string;
  readonly maximumAmount: string;
  readonly sourceLabel: string;
  readonly sourceVersion: string;
  readonly rationale: string;
}

interface GoalBuilder {
  readonly goalId: string | null;
  readonly revision: string | null;
  readonly effectiveFrom: string;
  readonly energyMode: "derived" | "fixed";
  readonly fixedKcal: string;
  readonly activityLevelCode: "" | "sedentary_or_light" | "active_or_moderate" | "vigorous";
  readonly activityFactor: string;
  readonly palAcknowledged: boolean;
  readonly adjustmentKcal: string;
  readonly rationale: string;
  readonly targets: readonly TargetDraft[];
}

export function emptyGoal(date: string): GoalBuilder {
  return {
    goalId: null,
    revision: null,
    effectiveFrom: date,
    energyMode: "fixed",
    fixedKcal: "",
    activityLevelCode: "",
    activityFactor: "",
    palAcknowledged: false,
    adjustmentKcal: "0",
    rationale: "",
    targets: [],
  };
}

export function goalBuilderFromGoal(goal: GoalView): GoalBuilder {
  return {
    goalId: goal.id,
    revision: goal.revision,
    effectiveFrom: goal.effectiveFrom,
    energyMode: goal.energy.mode,
    fixedKcal: goal.energy.targetKcal,
    activityLevelCode:
      goal.energy.mode === "derived"
        ? (goal.energy.activityLevelCode as GoalBuilder["activityLevelCode"])
        : "",
    activityFactor: goal.energy.mode === "derived" ? goal.energy.activityFactor : "",
    palAcknowledged: goal.energy.mode === "derived",
    adjustmentKcal: goal.energy.mode === "derived" ? goal.energy.adjustmentKcal : "0",
    rationale: goal.energy.rationale,
    targets: goal.targets.map((target) => ({
      definition: target,
      minimumAmount: target.minimumAmount ?? "",
      targetAmount: target.targetAmount ?? "",
      maximumAmount: target.maximumAmount ?? "",
      sourceLabel: target.targetSource,
      sourceVersion: target.targetSourceVersion ?? "",
      rationale: target.rationale ?? "",
    })),
  };
}

export function goalBuilderIsHistorical(
  goal: GoalView | null,
  builder: Pick<GoalBuilder, "goalId">,
): boolean {
  return builder.goalId !== null && goal?.id === builder.goalId && goal.effectiveTo !== null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

function palRange(code: Exclude<GoalBuilder["activityLevelCode"], "">): readonly [number, number] {
  if (code === "sedentary_or_light") return [1.4, 1.69];
  if (code === "active_or_moderate") return [1.7, 1.99];
  return [2, 2.4];
}

export function goalBody(builder: GoalBuilder) {
  if (!isLocalDate(builder.effectiveFrom))
    throw new RangeError("Effective date must be a real YYYY-MM-DD local date.");
  const rationale = builder.rationale;
  if (!rationale.normalize("NFKC").trim() || rationale.length > 1_000)
    throw new RangeError("Explain why you selected this energy target.");
  const energy =
    builder.energyMode === "fixed"
      ? (() => {
          if (!isRecipePositiveDecimal(builder.fixedKcal))
            throw new RangeError("Fixed energy must be a positive calorie amount.");
          return { mode: "fixed" as const, targetKcal: builder.fixedKcal, rationale };
        })()
      : (() => {
          if (
            !builder.palAcknowledged ||
            !builder.activityLevelCode ||
            !isRecipePositiveDecimal(builder.activityFactor) ||
            !isSignedGoalDecimal(builder.adjustmentKcal)
          )
            throw new RangeError("Choose and acknowledge a reviewed PAL category and factor.");
          const [minimum, maximum] = palRange(builder.activityLevelCode);
          const factor = Number(builder.activityFactor);
          if (factor < minimum || factor > maximum)
            throw new RangeError("The PAL factor is outside the selected reviewed category.");
          return {
            mode: "derived" as const,
            activityLevelCode: builder.activityLevelCode,
            activityFactor: builder.activityFactor,
            adjustmentKcal: builder.adjustmentKcal,
            rationale,
          };
        })();
  if (builder.targets.length > 256)
    throw new RangeError("A goal supports at most 256 nutrient targets.");
  const nutrientTargets = builder.targets.map((target) => {
    const minimumAmount = target.minimumAmount || null;
    const targetAmount = target.targetAmount || null;
    const maximumAmount = target.maximumAmount || null;
    if (
      (minimumAmount !== null && !isGoalDecimal(minimumAmount)) ||
      (targetAmount !== null && !isGoalDecimal(targetAmount)) ||
      (maximumAmount !== null && !isGoalDecimal(maximumAmount)) ||
      (minimumAmount === null && targetAmount === null && maximumAmount === null)
    )
      throw new RangeError(`${target.definition.name} needs at least one valid threshold.`);
    const sourceLabel = target.sourceLabel;
    if (!sourceLabel.normalize("NFKC").trim() || sourceLabel.length > 160)
      throw new RangeError(`${target.definition.name} needs a target source label.`);
    const sourceVersion = target.sourceVersion || null;
    const targetRationale = target.rationale || null;
    if (
      (sourceVersion !== null && sourceVersion.length > 100) ||
      (targetRationale !== null && targetRationale.length > 1_000)
    )
      throw new RangeError(`${target.definition.name} source metadata is too long.`);
    return {
      nutrientId: target.definition.nutrientId,
      minimumAmount,
      targetAmount,
      maximumAmount,
      source: { label: sourceLabel, version: sourceVersion },
      rationale: targetRationale,
    };
  });
  return goalWriteBody(builder.goalId, builder.effectiveFrom, energy, nutrientTargets);
}

export function GoalsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const [date, setDate] = useState(
    requestedDate && isLocalDate(requestedDate) ? requestedDate : "",
  );
  const [builder, setBuilder] = useState<GoalBuilder>(() => emptyGoal(""));
  const [definitions, setDefinitions] = useState<readonly TargetableNutrient[]>([]);
  const [selectedNutrientId, setSelectedNutrientId] = useState("");
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [progress, setProgress] = useState<GoalProgressView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("Loading your versioned goals…");
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, StableMutation<ReturnType<typeof goalBody>>>());

  const signInAgain = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const load = useCallback(
    async (localDate: string) => {
      setState("loading");
      try {
        const [currentResponse, progressResponse, nutrientResponse] = await Promise.all([
          fetch(`/api/goals/current?date=${encodeURIComponent(localDate)}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
          }),
          fetch(`/api/goals/progress?date=${encodeURIComponent(localDate)}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
          }),
          fetch("/api/nutrients/targetable", {
            headers: { accept: "application/json" },
            cache: "no-store",
          }),
        ]);
        if (
          [currentResponse, progressResponse, nutrientResponse].some(
            (response) => response.status === 401,
          )
        )
          return signInAgain();
        const [currentBody, progressBody, nutrientBody] = await Promise.all([
          json(currentResponse),
          json(progressResponse),
          json(nutrientResponse),
        ]);
        if (!currentResponse.ok)
          throw new Error(errorMessage(currentBody, "The current goal could not be loaded."));
        if (!progressResponse.ok)
          throw new Error(errorMessage(progressBody, "Goal progress could not be loaded."));
        if (!nutrientResponse.ok)
          throw new Error(errorMessage(nutrientBody, "Targetable nutrients could not be loaded."));
        const nextGoal = parseCurrentGoal(currentBody);
        const nextProgress = parseGoalProgress(progressBody);
        const nextDefinitions = parseTargetableNutrients(nutrientBody);
        setGoal(nextGoal);
        setProgress(nextProgress);
        setDefinitions(nextDefinitions);
        setSelectedNutrientId(nextDefinitions[0]?.nutrientId ?? "");
        setBuilder(nextGoal ? goalBuilderFromGoal(nextGoal) : emptyGoal(localDate));
        setState("ready");
        setMessage(
          nextGoal
            ? `Goal version ${nextGoal.versionNumber} applies on ${localDate}.`
            : "No active goal applies to this local day. Create one below.",
        );
      } catch (caught) {
        setState("error");
        setMessage(caught instanceof Error ? caught.message : "Goals could not be loaded.");
      }
    },
    [signInAgain],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) return signInAgain();
        const session = parseSession(await json(response));
        const localDate =
          requestedDate && isLocalDate(requestedDate)
            ? requestedDate
            : localDateInTimeZone(new Date(), session.profile.timeZone);
        if (!controller.signal.aborted) {
          setDate(localDate);
          void load(localDate);
        }
      } catch {
        if (!controller.signal.aborted) {
          setState("error");
          setMessage("Your private goal session could not be verified.");
        }
      }
    })();
    return () => controller.abort();
  }, [load, requestedDate, signInAgain]);

  function addTarget() {
    const definition = definitions.find((candidate) => candidate.nutrientId === selectedNutrientId);
    if (
      !definition ||
      builder.targets.some((target) => target.definition.nutrientId === definition.nutrientId)
    )
      return;
    if (builder.targets.length >= 256) {
      setMessage("A goal supports at most 256 nutrient targets.");
      return;
    }
    setBuilder({
      ...builder,
      targets: [
        ...builder.targets,
        {
          definition,
          minimumAmount: "",
          targetAmount: "",
          maximumAmount: "",
          sourceLabel: "",
          sourceVersion: "",
          rationale: "",
        },
      ],
    });
  }

  function updateTarget(index: number, patch: Partial<TargetDraft>) {
    setBuilder({
      ...builder,
      targets: builder.targets.map((target, candidate) =>
        candidate === index ? { ...target, ...patch } : target,
      ),
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    let body: ReturnType<typeof goalBody>;
    try {
      body = goalBody(builder);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the goal fields.");
      return;
    }
    const intentKey = `${builder.goalId ?? "create"}:${builder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(
      pending.current,
      intentKey,
      () => body,
      createOperationId,
    );
    pending.current.set(intentKey, operation);
    setBusy(true);
    setMessage(
      builder.goalId ? "Publishing a new immutable goal revision…" : "Creating your goal…",
    );
    try {
      const path = builder.goalId
        ? `/api/goals/${encodeURIComponent(builder.goalId)}/revisions`
        : "/api/goals";
      const response = await fetch(path, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(builder.revision ? { "if-match": `"${builder.revision}"` } : {}),
        },
        body: JSON.stringify(operation.body),
        cache: "no-store",
      });
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 412) {
        pending.current.delete(intentKey);
        await load(date);
        setMessage(
          "This goal changed elsewhere. Fresh values were loaded; review before saving again.",
        );
        return;
      }
      if (!response.ok) throw new Error(errorMessage(responseBody, "The goal could not be saved."));
      const mutation = parseGoalMutation(responseBody);
      pending.current.delete(intentKey);
      setGoal(mutation.goal);
      setBuilder(goalBuilderFromGoal(mutation.goal));
      await load(date);
      setMessage(
        mutation.replayed
          ? "The earlier goal save was confirmed safely."
          : `Goal version ${mutation.goal.versionNumber} published.`,
      );
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The goal could not be saved."} Choose Save again to retry safely.`,
      );
    } finally {
      setBusy(false);
    }
  }

  function beginNewGoal() {
    if (!isLocalDate(date)) {
      setMessage("Choose a real progress date before starting a new goal.");
      return;
    }
    setBuilder(emptyGoal(date));
    setMessage("New goal draft started. Choose its effective date and explicit targets.");
  }

  const historicalGoal = goalBuilderIsHistorical(goal, builder);

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/dashboard?date=${date}`}>Diary</Link>
          <Link href={`/foods?date=${date}`}>Foods</Link>
          <Link href={`/recipes?date=${date}`}>Recipes</Link>
          <Link aria-current="page" href={`/goals?date=${date}`}>
            Goals
          </Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        <p className="wellnessNote">General wellness estimates—not medical advice.</p>
      </aside>
      <section className="dashboard goalsDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">EXPLAINABLE DAILY TARGETS</p>
            <h1>Goals</h1>
          </div>
          <span className="statusPill">Versioned</span>
        </header>
        <p className="workspaceIntro">
          Choose your own fixed energy target or an eligible adult profile-derived estimate, then
          add explicit nutrient thresholds with their source.
        </p>
        <p className="workspaceStatus" data-state={state} aria-live="polite">
          {message}
        </p>
        {state === "error" ? (
          <button className="buttonSecondary" onClick={() => void load(date)} type="button">
            Retry goals
          </button>
        ) : null}
        <div className="goalWorkspace">
          <section className="workspacePanel">
            <div className="workspaceHeading">
              <div>
                <p className="kicker">
                  {builder.goalId && goal ? `GOAL REVISION ${goal.versionNumber}` : "NEW GOAL"}
                </p>
                <h2>Daily targets</h2>
              </div>
              {builder.goalId && goal ? (
                <>
                  <button
                    className="buttonSecondary"
                    disabled={busy}
                    onClick={beginNewGoal}
                    type="button"
                  >
                    New goal
                  </button>
                  <span className="statusPill">Effective {goal.effectiveFrom}</span>
                </>
              ) : null}
            </div>
            <form className="workspaceForm" onSubmit={(event) => void save(event)}>
              <fieldset className="goalEditorFields" disabled={busy || historicalGoal}>
                <label className="formField">
                  <span>Effective from</span>
                  <input
                    aria-describedby={builder.goalId ? "effective-date-help" : undefined}
                    maxLength={10}
                    onChange={(event) =>
                      setBuilder({ ...builder, effectiveFrom: event.target.value })
                    }
                    readOnly={builder.goalId !== null}
                    value={builder.effectiveFrom}
                  />
                </label>
                {builder.goalId ? (
                  <p className="fieldHelp" id="effective-date-help">
                    {historicalGoal
                      ? "This closed goal is immutable history. Start a new goal to make changes."
                      : "A revision keeps the original effective date. Create a new goal to choose another date."}
                  </p>
                ) : null}
                <fieldset className="modeChooser">
                  <legend className="fieldLegend">Energy method</legend>
                  <div className="intentControls">
                    <label
                      className={`intentOption ${builder.energyMode === "fixed" ? "active" : ""}`}
                    >
                      <input
                        checked={builder.energyMode === "fixed"}
                        name="energy-mode"
                        onChange={() =>
                          setBuilder({
                            ...builder,
                            energyMode: "fixed",
                            fixedKcal: builder.energyMode === "derived" ? "" : builder.fixedKcal,
                          })
                        }
                        type="radio"
                      />
                      <span>Fixed target</span>
                    </label>
                    <label
                      className={`intentOption ${builder.energyMode === "derived" ? "active" : ""}`}
                    >
                      <input
                        checked={builder.energyMode === "derived"}
                        name="energy-mode"
                        onChange={() => setBuilder({ ...builder, energyMode: "derived" })}
                        type="radio"
                      />
                      <span>Profile-derived estimate</span>
                    </label>
                  </div>
                </fieldset>
                {builder.energyMode === "fixed" ? (
                  <label className="formField">
                    <span>Daily energy (kcal)</span>
                    <input
                      inputMode="decimal"
                      maxLength={19}
                      onChange={(event) =>
                        setBuilder({ ...builder, fixedKcal: event.target.value })
                      }
                      placeholder="Enter your selected value"
                      value={builder.fixedKcal}
                    />
                  </label>
                ) : (
                  <div className="formGrid">
                    <label className="formField">
                      <span>PAL category</span>
                      <select
                        onChange={(event) => {
                          const code = event.target.value as GoalBuilder["activityLevelCode"];
                          setBuilder({
                            ...builder,
                            activityLevelCode: code,
                            activityFactor: "",
                            palAcknowledged: false,
                          });
                        }}
                        value={builder.activityLevelCode}
                      >
                        <option value="">Choose a category…</option>
                        <option value="sedentary_or_light">Sedentary or light (1.40–1.69)</option>
                        <option value="active_or_moderate">Active or moderate (1.70–1.99)</option>
                        <option value="vigorous">Vigorous (2.00–2.40)</option>
                      </select>
                    </label>
                    <label className="formField">
                      <span>PAL factor</span>
                      <input
                        inputMode="decimal"
                        maxLength={19}
                        onChange={(event) =>
                          setBuilder({
                            ...builder,
                            activityFactor: event.target.value,
                            palAcknowledged: false,
                          })
                        }
                        value={builder.activityFactor}
                      />
                    </label>
                    <label className="formField">
                      <span>Adjustment kcal</span>
                      <input
                        inputMode="decimal"
                        maxLength={20}
                        onChange={(event) =>
                          setBuilder({ ...builder, adjustmentKcal: event.target.value })
                        }
                        value={builder.adjustmentKcal}
                      />
                    </label>
                    <label className="formField formField--wide">
                      <span>
                        <input
                          checked={builder.palAcknowledged}
                          onChange={(event) =>
                            setBuilder({ ...builder, palAcknowledged: event.target.checked })
                          }
                          type="checkbox"
                        />{" "}
                        I understand PAL represents habitual total activity and ordinary exercise is
                        not added again.
                      </span>
                    </label>
                    <p className="fieldHelp formField--wide">
                      Estimated daily energy = estimated resting energy × PAL + adjustment. This is
                      not a measured value or recommendation.
                    </p>
                  </div>
                )}
                <label className="formField">
                  <span>Why this energy target?</span>
                  <textarea
                    maxLength={1_000}
                    onChange={(event) => setBuilder({ ...builder, rationale: event.target.value })}
                    value={builder.rationale}
                  />
                </label>
                <section className="workspaceSection" aria-labelledby="targets-heading">
                  <h3 id="targets-heading">Nutrient thresholds ({builder.targets.length}/256)</h3>
                  <div className="searchInputRow">
                    <select
                      aria-label="Nutrient to add"
                      onChange={(event) => setSelectedNutrientId(event.target.value)}
                      value={selectedNutrientId}
                    >
                      {definitions
                        .filter(
                          (definition) =>
                            !builder.targets.some(
                              (target) => target.definition.nutrientId === definition.nutrientId,
                            ),
                        )
                        .map((definition) => (
                          <option key={definition.nutrientId} value={definition.nutrientId}>
                            {definition.name} ({definition.unit})
                          </option>
                        ))}
                    </select>
                    <button className="buttonSecondary" onClick={addTarget} type="button">
                      Add nutrient
                    </button>
                  </div>
                  <div className="goalTargetGrid">
                    {builder.targets.map((target, index) => (
                      <div className="goalTargetRow" key={target.definition.nutrientId}>
                        <div>
                          <strong>{target.definition.name}</strong>
                          <p className="sourceLine">
                            {target.definition.unit} · {target.definition.category}
                          </p>
                          <input
                            aria-label={`${target.definition.name} target source`}
                            maxLength={160}
                            onChange={(event) =>
                              updateTarget(index, { sourceLabel: event.target.value })
                            }
                            placeholder="Source label (required)"
                            value={target.sourceLabel}
                          />
                          <input
                            aria-label={`${target.definition.name} source version`}
                            maxLength={100}
                            onChange={(event) =>
                              updateTarget(index, { sourceVersion: event.target.value })
                            }
                            placeholder="Source version (optional)"
                            value={target.sourceVersion}
                          />
                          <input
                            aria-label={`${target.definition.name} rationale`}
                            maxLength={1_000}
                            onChange={(event) =>
                              updateTarget(index, { rationale: event.target.value })
                            }
                            placeholder="Rationale (optional)"
                            value={target.rationale}
                          />
                        </div>
                        <input
                          aria-label={`${target.definition.name} minimum ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { minimumAmount: event.target.value })
                          }
                          placeholder="Minimum"
                          value={target.minimumAmount}
                        />
                        <input
                          aria-label={`${target.definition.name} target ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { targetAmount: event.target.value })
                          }
                          placeholder="Target"
                          value={target.targetAmount}
                        />
                        <input
                          aria-label={`${target.definition.name} maximum ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { maximumAmount: event.target.value })
                          }
                          placeholder="Maximum"
                          value={target.maximumAmount}
                        />
                        <button
                          className="buttonDanger"
                          onClick={() =>
                            setBuilder({
                              ...builder,
                              targets: builder.targets.filter(
                                (_, candidate) => candidate !== index,
                              ),
                            })
                          }
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </fieldset>
              <button className="buttonPrimary" disabled={busy || historicalGoal} type="submit">
                {historicalGoal
                  ? "Closed goal history is read-only"
                  : busy
                    ? "Saving…"
                    : builder.goalId
                      ? "Publish goal revision"
                      : "Create goal"}
              </button>
            </form>
            {builder.goalId && goal?.energy.mode === "derived" ? (
              <section className="workspaceSection">
                <h3>Explainable energy estimate</h3>
                <p>
                  <strong>{goal.energy.targetKcal} kcal estimated daily energy</strong> from{" "}
                  {goal.energy.bmrKcal} kcal estimated resting energy.
                </p>
                <details>
                  <summary>Calculation inputs</summary>
                  <p className="coverageCopy">
                    Profile revision {goal.energy.profileRevision}: age {goal.energy.ageYears},{" "}
                    {goal.energy.sexAtBirth} equation constant, {goal.energy.heightCm} cm,{" "}
                    {goal.energy.weightKg} kg, PAL {goal.energy.activityFactor}, adjustment{" "}
                    {goal.energy.adjustmentKcal} kcal. This is an estimate, not measured metabolism
                    or a recommendation. Ordinary exercise is already represented by PAL.
                  </p>
                </details>
                <p className="sourceLine">
                  <a href={goal.energy.sourceUrl} rel="noreferrer" target="_blank">
                    {goal.energy.equationLabel}
                  </a>{" "}
                  ·{" "}
                  <a href={goal.energy.activitySourceUrl} rel="noreferrer" target="_blank">
                    Reviewed FAO/WHO/UNU PAL policy
                  </a>
                </p>
              </section>
            ) : null}
          </section>
          <aside className="recipeRail">
            <div className="workspaceHeading">
              <div>
                <p className="kicker">LOCAL DAY</p>
                <h2>Progress</h2>
              </div>
            </div>
            <label className="formField">
              <span>Progress date</span>
              <input
                maxLength={10}
                onChange={(event) => setDate(event.target.value)}
                onBlur={() => {
                  if (isLocalDate(date)) void load(date);
                }}
                value={date}
              />
            </label>
            {progress?.energy ? (
              <ProgressRow row={progress.energy} />
            ) : (
              <p className="coverageCopy">No energy comparison is available for this day.</p>
            )}
            <ul className="progressList">
              {progress?.nutrients.map((row) => (
                <li key={row.nutrientId}>
                  <ProgressRow row={row} />
                </li>
              ))}
            </ul>
            <p className="coverageCopy">
              {progress?.notice ?? "General wellness estimate; not medical advice."} Incomplete
              intake is a quantified lower bound, never a measured zero.
            </p>
          </aside>
        </div>
      </section>
    </>
  );
}

function ProgressRow({ row }: { readonly row: GoalProgressView["nutrients"][number] }) {
  const view = nutrientProgressPresentation({
    name: row.name,
    unit: row.unit,
    knownAmount: row.knownAmount,
    completeness: row.completeness,
    amountInterpretation: row.amountInterpretation,
    minimumAmount: row.minimum?.amount ?? null,
    targetAmount: row.target?.amount ?? null,
    maximumAmount: row.maximum?.amount ?? null,
    lowerBoundPercent: row.target?.lowerBoundPercent ?? null,
    percentIsExact: row.target?.percentIsExact ?? row.amountInterpretation === "exact",
  });
  return (
    <section aria-label={view.accessibilityLabel}>
      <div className="progressHeader">
        <strong>{row.name}</strong>
        <span>{view.valueText}</span>
      </div>
      {view.progressPercent !== null ? (
        <div aria-hidden="true" className="progressTrack">
          <span style={{ width: `${view.progressPercent}%` }} />
        </div>
      ) : null}
      <p className="coverageCopy">
        {view.targetText} · {view.coverageText}
        {row.minimum ? ` · minimum ${row.minimum.state}` : ""}
        {row.maximum ? ` · maximum ${row.maximum.state}` : ""}
      </p>
    </section>
  );
}
