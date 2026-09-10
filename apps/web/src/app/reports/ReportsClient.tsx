"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLocalDate, parseSession, type SessionSummary } from "../../lib/diary";
import {
  adjacentNutritionReportRange,
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
import { PrintableNutritionReport } from "./PrintableNutritionReport";
import printStyles from "./report-print-shell.module.css";

type LoadState = "loading" | "ready" | "error";

interface PrintCapture {
  readonly report: NutritionReport;
  readonly nutrientId: string;
  readonly sessionGeneration: number;
  readonly reportGeneration: number;
  readonly printGeneration: number;
}

interface PrintView {
  readonly report: NutritionReport;
  readonly nutrientId: string;
  readonly session: SessionSummary;
}

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
  const [sessionVerifying, setSessionVerifying] = useState(true);
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
  const [printBusy, setPrintBusy] = useState(false);
  const [printMessage, setPrintMessage] = useState("");
  const [printCapture, setPrintCapture] = useState<PrintCapture | null>(null);

  const privateUiClosed = useRef(false);
  const sessionExplicitlyClosed = useRef(false);
  const sessionGeneration = useRef(0);
  const reportGeneration = useRef(0);
  const controlGeneration = useRef(0);
  const ownedRouteCommit = useRef<{
    readonly rangeKey: string;
    readonly sessionGeneration: number;
    readonly ownerUserId: string;
  } | null>(null);
  const reportController = useRef<AbortController | null>(null);
  const completedReportRequest = useRef<{
    readonly range: NutritionReportRange;
    readonly refreshKey: number;
    readonly report: NutritionReport;
  } | null>(null);
  const printGeneration = useRef(0);
  const printController = useRef<AbortController | null>(null);
  const printView = useRef<PrintView | null>(null);
  const armedPrint = useRef<PrintCapture | null>(null);
  const lastInvokedPrint = useRef<number | null>(null);
  const printOutput = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const refreshRef = useRef(refreshKey);
  refreshRef.current = refreshKey;
  const initialRouteKey = `${initialFrom ?? ""}/${initialTo ?? ""}`;
  const routeRef = useRef({ key: initialRouteKey });
  if (routeRef.current.key !== initialRouteKey) routeRef.current = { key: initialRouteKey };
  const routeContext = routeRef.current;
  const handledRouteKey = useRef(initialRouteKey);
  const routeReadyRef = useRef(false);
  const pendingRoute = ownedRouteCommit.current;
  routeReadyRef.current =
    handledRouteKey.current === initialRouteKey ||
    (pendingRoute !== null &&
      pendingRoute.rangeKey === initialRouteKey &&
      rangeKey(rangeRef.current) === initialRouteKey &&
      pendingRoute.sessionGeneration === sessionGeneration.current &&
      pendingRoute.ownerUserId === sessionRef.current?.user.id);

  const closePrintGate = useCallback(() => {
    armedPrint.current = null;
    printOutput.current?.setAttribute("data-print-authorized", "false");
  }, []);

  const invalidatePrint = useCallback(
    (invalidateView = true) => {
      printGeneration.current += 1;
      printController.current?.abort();
      printController.current = null;
      closePrintGate();
      if (invalidateView) printView.current = null;
      setPrintCapture(null);
      setPrintBusy(false);
      setPrintMessage("");
    },
    [closePrintGate],
  );

  const isCurrentPrint = useCallback((capture: PrintCapture) => {
    const view = printView.current;
    return (
      !privateUiClosed.current &&
      routeReadyRef.current &&
      printGeneration.current === capture.printGeneration &&
      sessionGeneration.current === capture.sessionGeneration &&
      reportGeneration.current === capture.reportGeneration &&
      view?.report === capture.report &&
      view.nutrientId === capture.nutrientId &&
      view.session.user.id === capture.report.ownerUserId &&
      view.session.profile.revision === capture.report.profileRevision &&
      view.session.profile.timeZone === capture.report.timeZone &&
      rangeKey(rangeRef.current) === `${capture.report.from}/${capture.report.to}`
    );
  }, []);

  const signInAgain = useCallback(() => {
    controlGeneration.current += 1;
    ownedRouteCommit.current = null;
    completedReportRequest.current = null;
    invalidatePrint();
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
  }, [invalidatePrint, router]);

  useEffect(() => {
    const ownedCommit = ownedRouteCommit.current;
    ownedRouteCommit.current = null;
    handledRouteKey.current = initialRouteKey;
    routeReadyRef.current = true;
    if (
      ownedCommit &&
      !privateUiClosed.current &&
      sessionRef.current?.user.id === ownedCommit.ownerUserId &&
      sessionGeneration.current === ownedCommit.sessionGeneration &&
      `${initialFrom}/${initialTo}` === ownedCommit.rangeKey &&
      rangeKey(rangeRef.current) === ownedCommit.rangeKey
    )
      return;
    controlGeneration.current += 1;
    reportGeneration.current += 1;
    completedReportRequest.current = null;
    reportController.current?.abort();
    invalidatePrint();
    setReport(null);
    setState("loading");
    setSessionVerifying(true);
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
          !routeReadyRef.current ||
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
          !routeReadyRef.current ||
          sessionGeneration.current !== generation
        ) {
          return;
        }
        setSessionVerifying(false);
        setSession(nextSession);
        rangeRef.current = nextRange;
        setRange(nextRange);
        setDraftFrom(nextRange.from);
        setDraftTo(nextRange.to);
        setMessage(`Loading ${nextRange.from} through ${nextRange.to}…`);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !privateUiClosed.current &&
          routeReadyRef.current &&
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
  }, [initialFrom, initialTo, initialRouteKey, invalidatePrint, signInAgain]);

  useEffect(() => {
    if (!session || !range) return;
    const completed = completedReportRequest.current;
    // Installing the profile verified for this exact response must not refetch it.
    if (
      completed?.range === range &&
      completed.refreshKey === refreshKey &&
      completed.report.ownerUserId === session.user.id &&
      completed.report.profileRevision === session.profile.revision &&
      completed.report.timeZone === session.profile.timeZone
    )
      return;
    completedReportRequest.current = null;
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
      routeReadyRef.current &&
      reportGeneration.current === generation &&
      reportController.current === controller &&
      rangeKey(rangeRef.current) === rangeKey(requestedRange) &&
      refreshRef.current === requestedRefreshKey &&
      sessionRef.current?.user.id === requestedOwner;

    invalidatePrint();
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
        completedReportRequest.current = { range, refreshKey, report: nextReport };
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
  }, [invalidatePrint, range, refreshKey, session, signInAgain]);

  useEffect(() => {
    // StrictMode replays mount effects. Reopen only the lifecycle gate;
    // an explicit session closure remains closed across effect replays.
    privateUiClosed.current = sessionExplicitlyClosed.current;
    return () => {
      privateUiClosed.current = true;
      controlGeneration.current += 1;
      ownedRouteCommit.current = null;
      completedReportRequest.current = null;
      printGeneration.current += 1;
      printController.current?.abort();
      printController.current = null;
      printView.current = null;
      closePrintGate();
      sessionGeneration.current += 1;
      reportGeneration.current += 1;
      reportController.current?.abort();
    };
  }, [closePrintGate]);

  const selectedSeries = useMemo(
    () =>
      report?.series.find((series) => series.nutrient.id === selectedNutrientId) ??
      report?.series[0] ??
      null,
    [report, selectedNutrientId],
  );

  const printable =
    routeReadyRef.current &&
    !sessionVerifying &&
    state === "ready" &&
    !logoutBusy &&
    !privateUiClosed.current &&
    report !== null &&
    session !== null &&
    selectedSeries !== null &&
    range !== null &&
    report.ownerUserId === session.user.id &&
    report.profileRevision === session.profile.revision &&
    report.timeZone === session.profile.timeZone &&
    report.from === range.from &&
    report.to === range.to &&
    draftFrom === range.from &&
    draftTo === range.to;
  printView.current = printable
    ? { report, nutrientId: selectedSeries.nutrient.id, session }
    : null;

  const controlContext = controlGeneration.current;
  const sessionContext = sessionGeneration.current;
  const reportContext = reportGeneration.current;
  const dirtyRange = range !== null && (draftFrom !== range.from || draftTo !== range.to);
  const adjacentRanges = useMemo(() => {
    if (!report) return { previous: null, next: null };
    try {
      return {
        previous: adjacentNutritionReportRange(report, "previous"),
        next: adjacentNutritionReportRange(report, "next"),
      };
    } catch {
      return { previous: null, next: null };
    }
  }, [report]);

  function canUseRangeControls() {
    return (
      !privateUiClosed.current &&
      routeReadyRef.current &&
      routeRef.current === routeContext &&
      !sessionVerifying &&
      !logoutBusy &&
      session !== null &&
      sessionRef.current === session &&
      state !== "loading" &&
      sessionGeneration.current === sessionContext &&
      reportGeneration.current === reportContext &&
      controlGeneration.current === controlContext &&
      rangeKey(rangeRef.current) === rangeKey(range)
    );
  }

  function editRangeDate(field: "from" | "to", value: string) {
    if (!canUseRangeControls()) return;
    controlGeneration.current += 1;
    invalidatePrint();
    setRangeError("");
    if (field === "from") setDraftFrom(value);
    else setDraftTo(value);
  }

  function navigatePeriod(direction: "previous" | "next") {
    const view = printView.current;
    if (
      !canUseRangeControls() ||
      !printable ||
      !view ||
      view.report !== report ||
      view.nutrientId !== selectedSeries?.nutrient.id ||
      !adjacentRanges[direction]
    )
      return;
    commitRange(adjacentRanges[direction]);
  }

  useEffect(() => {
    const beforePrint = () => {
      const capture = armedPrint.current;
      printOutput.current?.setAttribute(
        "data-print-authorized",
        capture && isCurrentPrint(capture) ? "true" : "false",
      );
    };
    const afterPrint = () => {
      invalidatePrint(false);
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      closePrintGate();
    };
  }, [closePrintGate, invalidatePrint, isCurrentPrint]);

  useEffect(() => {
    if (
      !printCapture ||
      !isCurrentPrint(printCapture) ||
      lastInvokedPrint.current === printCapture.printGeneration
    )
      return;
    lastInvokedPrint.current = printCapture.printGeneration;
    armedPrint.current = printCapture;
    try {
      // This effect runs after the verified snapshot has committed to the DOM.
      // beforeprint opens its synchronous gate; afterprint removes the capture.
      window.print();
    } catch {
      invalidatePrint(false);
      setPrintMessage("The print dialog could not open. Try Print current report again.");
    } finally {
      // Browsers may ignore print() or return without afterprint. Never retain
      // an armed ticket after the native call returns; a handed-off browser
      // snapshot is outside this component's session controls.
      if (armedPrint.current === printCapture) invalidatePrint(false);
    }
  }, [invalidatePrint, isCurrentPrint, printCapture]);

  async function printCurrentReport() {
    const view = printView.current;
    if (
      !view ||
      view.report !== report ||
      view.nutrientId !== selectedSeries?.nutrient.id ||
      privateUiClosed.current ||
      printController.current ||
      armedPrint.current
    )
      return;
    invalidatePrint(false);
    const capture: PrintCapture = {
      report: view.report,
      nutrientId: view.nutrientId,
      sessionGeneration: sessionGeneration.current,
      reportGeneration: reportGeneration.current,
      printGeneration: printGeneration.current,
    };
    const controller = new AbortController();
    printController.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      printController.current === controller &&
      isCurrentPrint(capture);
    setPrintBusy(true);
    setPrintMessage("Verifying your session before opening the print dialog…");
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401) return signInAgain();
      const body = await responseJson(response);
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new Error(
          responseError(body, "Your print session could not be verified. Retry now."),
        );
      }
      const freshSession = parseSession(body);
      if (freshSession.user.id !== capture.report.ownerUserId) return signInAgain();
      if (
        freshSession.profile.revision !== capture.report.profileRevision ||
        freshSession.profile.timeZone !== capture.report.timeZone
      ) {
        controlGeneration.current += 1;
        completedReportRequest.current = null;
        invalidatePrint();
        setReport(null);
        setState("error");
        setMessage("Your profile changed. Retry the report before printing its new snapshot.");
        return;
      }
      if (!isCurrent()) return;
      printController.current = null;
      setPrintCapture(capture);
      setPrintMessage("Use your browser’s print dialog to print or save this snapshot as PDF.");
    } catch (error) {
      if (!isCurrent()) return;
      invalidatePrint(false);
      setPrintMessage(
        error instanceof Error ? error.message : "Your print session could not be verified.",
      );
    }
  }

  function commitRange(next: NutritionReportRange, rewriteUrl = true) {
    if (!canUseRangeControls()) return;
    nutritionReportDates(next.from, next.to);
    controlGeneration.current += 1;
    reportGeneration.current += 1;
    completedReportRequest.current = null;
    reportController.current?.abort();
    invalidatePrint();
    rangeRef.current = next;
    setReport(null);
    setState("loading");
    setMessage(`Loading ${next.from} through ${next.to}…`);
    setRangeError("");
    setDraftFrom(next.from);
    setDraftTo(next.to);
    setRange(next);
    if (rewriteUrl && session) {
      ownedRouteCommit.current = {
        rangeKey: rangeKey(next),
        sessionGeneration: sessionGeneration.current,
        ownerUserId: session.user.id,
      };
      router.replace(
        `/reports?from=${encodeURIComponent(next.from)}&to=${encodeURIComponent(next.to)}`,
        { scroll: false },
      );
    }
  }

  function submitRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUseRangeControls()) return;
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
    if (!canUseRangeControls()) return;
    try {
      const anchor = isLocalDate(draftTo) ? draftTo : range?.to;
      if (!anchor) throw new RangeError("Choose a valid To date first.");
      commitRange(nutritionReportRange(anchor, days));
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : "Choose a valid report range.");
    }
  }

  async function signOut() {
    if (
      privateUiClosed.current ||
      logoutBusy ||
      controlGeneration.current !== controlContext ||
      sessionGeneration.current !== sessionContext
    )
      return;
    controlGeneration.current += 1;
    invalidatePrint();
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
      <aside className={`sidebar ${printStyles.screen}`}>
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

      <section
        className={`dashboard reportDashboard ${printStyles.screen}`}
        aria-busy={state === "loading"}
      >
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
                disabled={
                  !session ||
                  sessionVerifying ||
                  logoutBusy ||
                  state === "loading" ||
                  privateUiClosed.current
                }
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
                disabled={
                  !session ||
                  sessionVerifying ||
                  logoutBusy ||
                  state === "loading" ||
                  privateUiClosed.current
                }
                onChange={(event) => {
                  editRangeDate("from", event.target.value);
                }}
                required
                type="date"
                value={draftFrom}
              />
            </label>
            <label>
              <span>To</span>
              <input
                disabled={
                  !session ||
                  sessionVerifying ||
                  logoutBusy ||
                  state === "loading" ||
                  privateUiClosed.current
                }
                onChange={(event) => {
                  editRangeDate("to", event.target.value);
                }}
                required
                type="date"
                value={draftTo}
              />
            </label>
            <button
              className="buttonPrimary"
              disabled={
                !session ||
                sessionVerifying ||
                logoutBusy ||
                state === "loading" ||
                privateUiClosed.current
              }
              type="submit"
            >
              Update report
            </button>
          </div>
          <p className="reportRangeError" aria-live="polite">
            {rangeError}
          </p>
        </form>

        <fieldset className="reportPresets">
          <legend>Adjacent report periods</legend>
          <button
            disabled={!printable || adjacentRanges.previous === null}
            onClick={() => navigatePeriod("previous")}
            type="button"
          >
            Previous period
          </button>
          <button
            disabled={!printable || adjacentRanges.next === null}
            onClick={() => navigatePeriod("next")}
            type="button"
          >
            Next period
          </button>
          {dirtyRange ? (
            <p aria-live="polite">
              Choose Update report to apply your dates before moving to another period.
            </p>
          ) : null}
        </fieldset>

        <p className="workspaceStatus" data-state={state} role="status" aria-live="polite">
          {message}
        </p>
        {state === "error" && session && range ? (
          <button
            className="buttonSecondary"
            onClick={() => {
              if (!canUseRangeControls()) return;
              controlGeneration.current += 1;
              reportGeneration.current += 1;
              completedReportRequest.current = null;
              reportController.current?.abort();
              invalidatePrint();
              setReport(null);
              setState("loading");
              const nextRefresh = refreshRef.current + 1;
              refreshRef.current = nextRefresh;
              setRefreshKey(nextRefresh);
            }}
            type="button"
          >
            Retry report
          </button>
        ) : null}

        <div className="reportPrintControls">
          <button
            className="buttonSecondary"
            disabled={!printable || printBusy}
            onClick={() => void printCurrentReport()}
            type="button"
          >
            {printBusy ? "Preparing print…" : "Print current report"}
          </button>
          <p>
            Print the loaded range and selected nutrient, or save them as PDF in your browser.
            Printed copies and saved files remain outside this app’s session controls.
          </p>
          <p role="status" aria-live="polite">
            {printMessage}
          </p>
        </div>

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
                    onChange={(event) => {
                      if (
                        !canUseRangeControls() ||
                        completedReportRequest.current?.report !== report
                      )
                        return;
                      controlGeneration.current += 1;
                      invalidatePrint();
                      setSelectedNutrientId(event.target.value);
                    }}
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
      <div className={printStyles.shell}>
        <p className={printStyles.notice}>
          No private report was prepared for printing. Return to Reports, load a current report,
          then choose Print current report.
        </p>
        <div className={printStyles.output} data-print-authorized="false" ref={printOutput}>
          {printCapture && isCurrentPrint(printCapture) ? (
            <PrintableNutritionReport
              report={printCapture.report}
              nutrientId={printCapture.nutrientId}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
