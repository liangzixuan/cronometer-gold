"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLocalDate, parseSession, type SessionSummary } from "../../lib/diary";
import {
  type NutritionReport,
  type NutritionReportRange,
  type NutritionReportSeriesPoint,
  nutritionReportDates,
  nutritionReportPath,
  nutritionReportRange,
  parseNutritionReport,
  reportAmountText,
  reportComparisonText,
  reportPointAccessibilityLabel,
  reportPointCoverageText,
  resolveInitialNutritionReportRange,
  targetSnapshotForPoint,
} from "../../lib/nutrition-reports";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface ReportsClientProps {
  readonly initialFrom?: string;
  readonly initialTo?: string;
}

function rangeKey(range: NutritionReportRange | null): string {
  return range ? `${range.from}/${range.to}` : "";
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.error === "string" && candidate.error.length <= 500
    ? candidate.error
    : fallback;
}

function displayDate(localDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T00:00:00.000Z`));
}

function displaySnapshot(instant: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(instant));
}

function goalVersionLabel(report: NutritionReport, versionId: string | null): string {
  if (versionId === null) return "No saved goal";
  const goal = report.goalVersions.find((candidate) => candidate.versionId === versionId);
  return goal
    ? `Goal r${goal.revision} · version ${goal.versionId.slice(0, 8)}`
    : "Unavailable goal evidence";
}

function targetText(
  report: NutritionReport,
  nutrientId: string,
  point: NutritionReportSeriesPoint,
  unit: string,
): string {
  const target = targetSnapshotForPoint(report, nutrientId, point.goalVersionId);
  if (!target) return point.goalVersionId === null ? "No saved goal" : "No saved threshold";
  const thresholds = [
    target.minimumAmount === null ? null : `minimum ${target.minimumAmount} ${unit}`,
    target.targetAmount === null ? null : `target ${target.targetAmount} ${unit}`,
    target.maximumAmount === null ? null : `maximum ${target.maximumAmount} ${unit}`,
  ].filter((value): value is string => value !== null);
  return thresholds.length === 0
    ? `No saved threshold · ${target.source.label}`
    : `${thresholds.join(" · ")} · ${target.source.label}${target.source.version ? ` ${target.source.version}` : ""}`;
}

export function ReportsClient({ initialFrom, initialTo }: ReportsClientProps) {
  const router = useRouter();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [range, setRange] = useState<NutritionReportRange | null>(null);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [report, setReport] = useState<NutritionReport | null>(null);
  const [selectedNutrientId, setSelectedNutrientId] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Verifying your private report session…");
  const [rangeError, setRangeError] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const privateUiClosed = useRef(false);
  const sessionExplicitlyClosed = useRef(false);
  const sessionGeneration = useRef(0);
  const reportGeneration = useRef(0);
  const reportController = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const refreshRef = useRef(refreshKey);
  refreshRef.current = refreshKey;

  const signInAgain = useCallback(() => {
    sessionExplicitlyClosed.current = true;
    privateUiClosed.current = true;
    sessionGeneration.current += 1;
    reportGeneration.current += 1;
    reportController.current?.abort();
    setSession(null);
    setRange(null);
    setReport(null);
    setSelectedNutrientId("");
    setState("loading");
    setMessage("Closing your private report…");
    router.replace("/login");
    router.refresh();
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = sessionGeneration.current + 1;
    sessionGeneration.current = generation;
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          privateUiClosed.current ||
          sessionGeneration.current !== generation
        )
          return;
        if (response.status === 401) return signInAgain();
        const body = await responseJson(response);
        if (!response.ok) {
          throw new Error(responseError(body, "Your report session could not be verified."));
        }
        const nextSession = parseSession(body);
        const nextRange = resolveInitialNutritionReportRange({
          ...(initialFrom ? { initialFrom } : {}),
          ...(initialTo ? { initialTo } : {}),
          profileTimeZone: nextSession.profile.timeZone,
        });
        if (
          controller.signal.aborted ||
          privateUiClosed.current ||
          sessionGeneration.current !== generation
        ) {
          return;
        }
        setSession(nextSession);
        setRange(nextRange);
        setDraftFrom(nextRange.from);
        setDraftTo(nextRange.to);
        setMessage(`Loading ${nextRange.from} through ${nextRange.to}…`);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !privateUiClosed.current &&
          sessionGeneration.current === generation
        ) {
          setState("error");
          setMessage(
            error instanceof Error ? error.message : "Your report session could not be verified.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [initialFrom, initialTo, signInAgain]);

  useEffect(() => {
    if (!session || !range) return;
    const requestedOwner = session.user.id;
    const requestedRange = { ...range };
    const requestedRefreshKey = refreshKey;
    const generation = reportGeneration.current + 1;
    reportGeneration.current = generation;
    reportController.current?.abort();
    const controller = new AbortController();
    reportController.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      !privateUiClosed.current &&
      reportGeneration.current === generation &&
      reportController.current === controller &&
      rangeKey(rangeRef.current) === rangeKey(requestedRange) &&
      refreshRef.current === requestedRefreshKey &&
      sessionRef.current?.user.id === requestedOwner;

    setState("loading");
    setReport(null);
    setMessage(`Loading ${requestedRange.from} through ${requestedRange.to}…`);
    void (async () => {
      try {
        const response = await fetch(nutritionReportPath(requestedRange), {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (response.status === 401) return signInAgain();
        const body = await responseJson(response);
        if (!isCurrent()) return;
        if (!response.ok) {
          throw new Error(responseError(body, "The nutrition report could not be loaded."));
        }
        const nextReport = parseNutritionReport(body, requestedRange);
        if (nextReport.ownerUserId !== requestedOwner) return signInAgain();

        if (
          nextReport.profileRevision !== session.profile.revision ||
          nextReport.timeZone !== session.profile.timeZone
        ) {
          const freshResponse = await fetch("/api/auth/me", {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (!isCurrent()) return;
          if (freshResponse.status === 401) return signInAgain();
          const freshBody = await responseJson(freshResponse);
          if (!isCurrent()) return;
          if (!freshResponse.ok) {
            throw new Error(
              responseError(freshBody, "Your profile changed while the report was loading."),
            );
          }
          const freshSession = parseSession(freshBody);
          if (freshSession.user.id !== requestedOwner) return signInAgain();
          if (
            freshSession.profile.revision !== nextReport.profileRevision ||
            freshSession.profile.timeZone !== nextReport.timeZone
          ) {
            throw new Error("Your profile changed again while the report was loading. Retry now.");
          }
          setSession(freshSession);
        }
        if (!isCurrent()) return;
        setReport(nextReport);
        setSelectedNutrientId((current) =>
          nextReport.series.some((series) => series.nutrient.id === current)
            ? current
            : (nextReport.series[0]?.nutrient.id ?? ""),
        );
        setState("ready");
        setMessage(
          `${nextReport.days.length} profile-local day${nextReport.days.length === 1 ? "" : "s"} loaded from one coherent snapshot.`,
        );
      } catch (error) {
        if (isCurrent()) {
          setState("error");
          setMessage(
            error instanceof Error ? error.message : "The nutrition report could not be loaded.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [range, refreshKey, session, signInAgain]);

  useEffect(() => {
    // StrictMode replays mount effects. Reopen only the lifecycle gate;
    // an explicit session closure remains closed across effect replays.
    privateUiClosed.current = sessionExplicitlyClosed.current;
    return () => {
      privateUiClosed.current = true;
      sessionGeneration.current += 1;
      reportGeneration.current += 1;
      reportController.current?.abort();
    };
  }, []);

  const selectedSeries = useMemo(
    () =>
      report?.series.find((series) => series.nutrient.id === selectedNutrientId) ??
      report?.series[0] ??
      null,
    [report, selectedNutrientId],
  );

  function commitRange(next: NutritionReportRange, rewriteUrl = true) {
    nutritionReportDates(next.from, next.to);
    setRangeError("");
    setDraftFrom(next.from);
    setDraftTo(next.to);
    setRange(next);
    if (rewriteUrl) {
      router.replace(
        `/reports?from=${encodeURIComponent(next.from)}&to=${encodeURIComponent(next.to)}`,
        { scroll: false },
      );
    }
  }

  function submitRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      nutritionReportDates(draftFrom, draftTo);
      commitRange({ from: draftFrom, to: draftTo });
    } catch (error) {
      setRangeError(
        error instanceof Error ? error.message : "Choose an inclusive range of 1 to 31 days.",
      );
    }
  }

  function choosePreset(days: 7 | 14 | 30) {
    try {
      const anchor = isLocalDate(draftTo) ? draftTo : range?.to;
      if (!anchor) throw new RangeError("Choose a valid To date first.");
      commitRange(nutritionReportRange(anchor, days));
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : "Choose a valid report range.");
    }
  }

  async function signOut() {
    setLogoutBusy(true);
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed && !privateUiClosed.current) {
      setMessage("Sign out could not be confirmed. Your private report remains open; retry.");
      setState("error");
      setLogoutBusy(false);
    }
  }

  const navigationDate = range?.to;
  const dateQuery = navigationDate ? `?date=${encodeURIComponent(navigationDate)}` : "";

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/dashboard${dateQuery}`}>Diary</Link>
          <Link href={`/foods${dateQuery}`}>Foods</Link>
          <Link href={`/recipes${dateQuery}`}>Recipes</Link>
          <Link href={`/goals${dateQuery}`}>Goals</Link>
          <Link href={`/hydration${dateQuery}`}>Hydration</Link>
          <Link href={`/activities${dateQuery}`}>Activity</Link>
          <Link
            aria-current="page"
            href={
              range
                ? `/reports?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
                : "/reports"
            }
          >
            Reports
          </Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={logoutBusy}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
        <p className="wellnessNote">General wellness information—not medical advice.</p>
      </aside>

      <section className="dashboard reportDashboard" aria-busy={state === "loading"}>
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">Bounded nutrition history</p>
            <h1>Reports</h1>
          </div>
          <span className="statusPill">Up to 31 days</span>
        </header>
        <p className="workspaceIntro">
          Compare calories, macros, and micronutrients across your profile-local days. Missing,
          trace, and partial values stay visible instead of becoming zero.
        </p>

        <form className="reportControls" onSubmit={submitRange}>
          <fieldset className="reportPresets">
            <legend>Quick ranges ending on the To date</legend>
            {[7, 14, 30].map((days) => (
              <button
                disabled={!session || state === "loading"}
                key={days}
                onClick={() => choosePreset(days as 7 | 14 | 30)}
                type="button"
              >
                {days} days
              </button>
            ))}
          </fieldset>
          <div className="reportDateFields">
            <label>
              <span>From</span>
              <input
                disabled={!session || state === "loading"}
                onChange={(event) => setDraftFrom(event.target.value)}
                required
                type="date"
                value={draftFrom}
              />
            </label>
            <label>
              <span>To</span>
              <input
                disabled={!session || state === "loading"}
                onChange={(event) => setDraftTo(event.target.value)}
                required
                type="date"
                value={draftTo}
              />
            </label>
            <button
              className="buttonPrimary"
              disabled={!session || state === "loading"}
              type="submit"
            >
              Update report
            </button>
          </div>
          <p className="reportRangeError" aria-live="polite">
            {rangeError}
          </p>
        </form>

        <p className="workspaceStatus" data-state={state} role="status" aria-live="polite">
          {message}
        </p>
        {state === "error" && session && range ? (
          <button
            className="buttonSecondary"
            onClick={() => setRefreshKey((value) => value + 1)}
            type="button"
          >
            Retry report
          </button>
        ) : null}

        {report && selectedSeries ? (
          <div className="reportWorkspace">
            <section className="reportOverview" aria-labelledby="report-overview-heading">
              <div>
                <p className="kicker">Coherent snapshot</p>
                <h2 id="report-overview-heading">
                  {report.from} through {report.to}
                </h2>
                <p>
                  Days are grouped in <strong>{report.timeZone}</strong>. Snapshot captured{" "}
                  {displaySnapshot(report.snapshotAt)}.
                </p>
              </div>
              <dl className="reportStats">
                <div>
                  <dt>Diary days</dt>
                  <dd>{selectedSeries.summary.diaryDays}</dd>
                </div>
                <div>
                  <dt>Exact days</dt>
                  <dd>{selectedSeries.summary.exactDays}</dd>
                </div>
                <div>
                  <dt>Partial / unknown</dt>
                  <dd>{selectedSeries.summary.partialDays + selectedSeries.summary.unknownDays}</dd>
                </div>
                <div>
                  <dt>Missing days</dt>
                  <dd>{selectedSeries.summary.missingDays}</dd>
                </div>
              </dl>
            </section>

            <section className="reportPanel" aria-labelledby="report-chart-heading">
              <div className="reportPanelHeading">
                <div>
                  <p className="kicker">Selectable nutrient</p>
                  <h2 id="report-chart-heading">Daily intake chart</h2>
                </div>
                <label className="reportNutrientSelect">
                  <span>Nutrient</span>
                  <select
                    onChange={(event) => setSelectedNutrientId(event.target.value)}
                    value={selectedSeries.nutrient.id}
                  >
                    {report.series.map((series) => (
                      <option key={series.nutrient.id} value={series.nutrient.id}>
                        {series.nutrient.name} ({series.nutrient.unit})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="coverageCopy">
                Bars show the known amount against this chart’s {selectedSeries.scaleMaximum}{" "}
                {selectedSeries.nutrient.unit} scale. Markers show saved minimum, target, and
                maximum values when present; they are not recommendations.
              </p>
              <figure className="reportChart">
                <figcaption className="srOnly">
                  {selectedSeries.nutrient.name} by profile-local date with explicit missingness and
                  saved-goal markers.
                </figcaption>
                <ol>
                  {selectedSeries.points.map((point) => (
                    <li
                      aria-label={reportPointAccessibilityLabel(
                        point,
                        selectedSeries.nutrient.name,
                        selectedSeries.nutrient.unit,
                      )}
                      key={point.localDate}
                    >
                      <time dateTime={point.localDate}>{displayDate(point.localDate)}</time>
                      <div className="reportBarTrack" aria-hidden="true">
                        {point.knownPercentOfScale !== null ? (
                          <span
                            className={`reportBarFill reportBarFill--${point.aggregate?.completeness ?? "missing"}`}
                            style={{ width: `${Number(point.knownPercentOfScale)}%` }}
                          />
                        ) : null}
                        {point.minimumPercentOfScale !== null ? (
                          <span
                            className="reportThreshold reportThreshold--minimum"
                            style={{ left: `${Number(point.minimumPercentOfScale)}%` }}
                          />
                        ) : null}
                        {point.targetPercentOfScale !== null ? (
                          <span
                            className="reportThreshold reportThreshold--target"
                            style={{ left: `${Number(point.targetPercentOfScale)}%` }}
                          />
                        ) : null}
                        {point.maximumPercentOfScale !== null ? (
                          <span
                            className="reportThreshold reportThreshold--maximum"
                            style={{ left: `${Number(point.maximumPercentOfScale)}%` }}
                          />
                        ) : null}
                      </div>
                      <strong>{reportAmountText(point, selectedSeries.nutrient.unit)}</strong>
                    </li>
                  ))}
                </ol>
              </figure>
              <ul className="reportLegend" aria-label="Chart legend">
                <li>
                  <span className="reportLegendSwatch" /> Known intake
                </li>
                <li>
                  <span className="reportLegendLine reportLegendLine--minimum" /> Saved minimum
                </li>
                <li>
                  <span className="reportLegendLine reportLegendLine--target" /> Saved target
                </li>
                <li>
                  <span className="reportLegendLine reportLegendLine--maximum" /> Saved maximum
                </li>
              </ul>
            </section>

            <section className="reportPanel" aria-labelledby="target-periods-heading">
              <h2 id="target-periods-heading">Saved target periods</h2>
              <p className="coverageCopy">
                Each period pins the goal version current when this report snapshot was read. It is
                not a reconstruction of an older goal revision.
              </p>
              <ol className="reportBoundaryList">
                {report.targetSegments.map((segment) => (
                  <li key={`${segment.from}/${segment.to}/${segment.goalVersionId ?? "none"}`}>
                    <span>
                      {segment.from === segment.to
                        ? segment.from
                        : `${segment.from} through ${segment.to}`}
                    </span>
                    <strong>{goalVersionLabel(report, segment.goalVersionId)}</strong>
                  </li>
                ))}
              </ol>
            </section>

            <section className="reportPanel" aria-labelledby="report-table-heading">
              <h2 id="report-table-heading">Exact daily evidence</h2>
              <p className="coverageCopy">
                “At least” is a lower bound. A missing day has no diary entries and is never
                displayed as measured zero.
              </p>
              <div className="reportTableScroller">
                <table className="reportTable">
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Entries</th>
                      <th scope="col">Logged amount</th>
                      <th scope="col">Coverage</th>
                      <th scope="col">Saved threshold</th>
                      <th scope="col">Comparison</th>
                      <th scope="col">Goal period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedSeries.points.map((point, index) => {
                      const day = report.days[index];
                      return (
                        <tr key={point.localDate}>
                          <th scope="row">{point.localDate}</th>
                          <td>{day?.entryCount ?? 0}</td>
                          <td>{reportAmountText(point, selectedSeries.nutrient.unit)}</td>
                          <td>{reportPointCoverageText(point)}</td>
                          <td>
                            {targetText(
                              report,
                              selectedSeries.nutrient.id,
                              point,
                              selectedSeries.nutrient.unit,
                            )}
                          </td>
                          <td>{reportComparisonText(point)}</td>
                          <td>{goalVersionLabel(report, point.goalVersionId)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="reportEvidenceNote">
              Profile revision {report.profileRevision} · data watermark {report.watermarkRevision}{" "}
              · {report.notice}
            </p>
          </div>
        ) : null}
      </section>
    </>
  );
}
