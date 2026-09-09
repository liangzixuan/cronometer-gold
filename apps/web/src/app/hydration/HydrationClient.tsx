"use client";

import { resolveHydrationLocalMinute } from "@nutrition-tracker/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  parseSession,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import {
  assertHydrationMutationMatches,
  changeHydrationTimeDraft,
  HYDRATION_OWNER_CHANGED_CODE,
  type HydrationDay,
  type HydrationEntry,
  type HydrationTimeDraft,
  type HydrationWriteOperation,
  hydrationAmountFromDraft,
  hydrationEntryAccessibilityLabel,
  hydrationTimeDraft,
  hydrationWriteBelongsToView,
  hydrationWriteOperation,
  hydrationWriteRequest,
  parseHydrationDay,
  parseHydrationMutation,
  prepareHydrationUpdate,
} from "../../lib/hydration";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface HydrationClientProps {
  readonly initialDate?: string;
}

interface HydrationEdit {
  readonly entry: HydrationEntry;
  readonly amount: string;
  readonly time: HydrationTimeDraft;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

function responseCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).code;
  return typeof candidate === "string" && candidate.length <= 100 ? candidate : null;
}

export function hydrationReadHeaders(expectedOwnerUserId: string): Record<string, string> {
  return {
    accept: "application/json",
    "x-expected-owner-user-id": expectedOwnerUserId,
  };
}

export function hydrationReadClosesPrivateUi(status: number, body: unknown): boolean {
  return status === 401 || (status === 409 && responseCode(body) === HYDRATION_OWNER_CHANGED_CODE);
}

function retainedDefaultOccurredAt(
  value: string | undefined,
  localDate: string,
  localTime: string,
  timeZone: string,
): string | null {
  if (!value) return null;
  const captured = new Date(value);
  if (
    !Number.isFinite(captured.getTime()) ||
    localDateInTimeZone(captured, timeZone) !== localDate ||
    localTimeInTimeZone(captured, timeZone).slice(0, 5) !== localTime
  ) {
    return null;
  }
  return captured.toISOString();
}

export function prepareHydrationCreate(
  amountDraft: string,
  selectedLocalDate: string,
  localTime: string,
  loadedDay: Pick<HydrationDay, "localDate" | "timeZone">,
  untouchedDefaultOccurredAt?: string,
): {
  readonly body: { readonly amountMilliliters: number; readonly occurredAt: string };
  readonly expectedTimeZone: string;
} {
  if (loadedDay.localDate !== selectedLocalDate) {
    throw new TypeError("Load the selected hydration day before adding an entry.");
  }
  const retainedOccurredAt = retainedDefaultOccurredAt(
    untouchedDefaultOccurredAt,
    selectedLocalDate,
    localTime,
    loadedDay.timeZone,
  );
  return {
    body: {
      amountMilliliters: hydrationAmountFromDraft(amountDraft),
      occurredAt:
        retainedOccurredAt ??
        localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone),
    },
    expectedTimeZone: loadedDay.timeZone,
  };
}

export function hydrationUpdateBody(amountDraft: string): { readonly amountMilliliters: number } {
  return { amountMilliliters: hydrationAmountFromDraft(amountDraft) };
}

function dayMessage(day: HydrationDay): string {
  if (day.entries.length === 0) return "No hydration entries for this local day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "entry" : "entries"}; exact total ${day.totalMilliliters.toLocaleString("en-US")} milliliters.`;
}

export function HydrationClient({ initialDate }: HydrationClientProps) {
  const router = useRouter();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<HydrationDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private hydration log…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [amount, setAmount] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [edit, setEdit] = useState<HydrationEdit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<HydrationWriteOperation | null>(null);
  const [reconcile, setReconcile] = useState(false);
  const [movedToDate, setMovedToDate] = useState<string | null>(null);
  const pendingRef = useRef<HydrationWriteOperation | null>(null);
  const acceptedRead = useRef<{ readonly message: string; readonly sourceDate: string } | null>(
    null,
  );
  const ownerRef = useRef<string | null>(null);
  const dateRef = useRef("");
  const mounted = useRef(false);
  const viewGeneration = useRef(0);
  const writeGeneration = useRef(0);
  const inFlight = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(null);
  const timeResolution = useMemo(
    () =>
      edit?.time.enabled
        ? resolveHydrationLocalMinute(edit.time.localDate, edit.time.localTime, edit.time.timeZone)
        : null,
    [edit?.time.enabled, edit?.time.localDate, edit?.time.localTime, edit?.time.timeZone],
  );

  const signInAgain = useCallback(() => {
    ownerRef.current = null;
    viewGeneration.current += 1;
    writeGeneration.current += 1;
    loadGeneration.current += 1;
    loadController.current?.abort();
    mutationController.current?.abort();
    pendingRef.current = null;
    acceptedRead.current = null;
    inFlight.current = false;
    setPending(null);
    setEdit(null);
    setBusy(null);
    setSession(null);
    setDay(null);
    setAmount("");
    setLocalTime("");
    setDate("");
    dateRef.current = "";
    loadedTimeZone.current = null;
    untouchedDefaultOccurredAt.current = null;
    setMovedToDate(null);
    setReconcile(false);
    setMessage("Sign in again to open your private hydration log.");
    setMessageIsError(false);
    router.replace("/login");
    router.refresh();
  }, [router]);

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      const expectedOwnerUserId = ownerRef.current;
      if (!expectedOwnerUserId || requestedDate !== dateRef.current) return false;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = ++loadGeneration.current;
      const view = viewGeneration.current;
      const current = () =>
        mounted.current &&
        !controller.signal.aborted &&
        loadGeneration.current === generation &&
        viewGeneration.current === view &&
        ownerRef.current === expectedOwnerUserId &&
        dateRef.current === requestedDate;
      setDay(null);
      setState("loading");
      setMessageIsError(false);
      setMessage(`Loading hydration entries for ${requestedDate}…`);
      try {
        const response = await fetch(`/api/hydration?date=${encodeURIComponent(requestedDate)}`, {
          cache: "no-store",
          headers: hydrationReadHeaders(expectedOwnerUserId),
          signal: controller.signal,
        });
        if (!current()) return false;
        if (response.status === 401) {
          signInAgain();
          return false;
        }
        const body = await json(response);
        if (!current()) return false;
        if (hydrationReadClosesPrivateUi(response.status, body)) {
          signInAgain();
          return false;
        }
        if (!response.ok)
          throw new Error(responseError(body, "Hydration entries could not be loaded."));
        const next = parseHydrationDay(body);
        if (next.localDate !== requestedDate)
          throw new TypeError("The hydration service returned another local day.");
        if (loadedTimeZone.current !== next.timeZone) {
          const capturedNow = new Date();
          setLocalTime(localTimeInTimeZone(capturedNow, next.timeZone));
          untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          loadedTimeZone.current = next.timeZone;
          setEdit(null);
        }
        setDay(next);
        setState("ready");
        setMessageIsError(false);
        setMessage(successMessage ?? dayMessage(next));
        return true;
      } catch (error) {
        if (!current()) return false;
        setDay(null);
        setState("error");
        setMessageIsError(true);
        setMessage(
          error instanceof Error ? error.message : "Hydration entries could not be loaded.",
        );
        return false;
      }
    },
    [signInAgain],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const view = ++viewGeneration.current;
    ownerRef.current = null;
    pendingRef.current = null;
    acceptedRead.current = null;
    setSession(null);
    setDay(null);
    setEdit(null);
    setPending(null);
    setBusy(null);
    setReconcile(false);
    setMovedToDate(null);
    setAmount("");
    setLocalTime("");
    loadedTimeZone.current = null;
    untouchedDefaultOccurredAt.current = null;
    setMessage("Opening your private hydration log…");
    setMessageIsError(false);
    setState("loading");
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (controller.signal.aborted || viewGeneration.current !== view) return;
        if (response.status === 401) return signInAgain();
        if (!response.ok) throw new Error("Your session could not be verified.");
        const nextSession = parseSession(await json(response));
        if (controller.signal.aborted || viewGeneration.current !== view) return;
        const today = localDateInTimeZone(new Date(), nextSession.profile.timeZone);
        const nextDate = initialDate && isLocalDate(initialDate) ? initialDate : today;
        ownerRef.current = nextSession.user.id;
        dateRef.current = nextDate;
        setSession(nextSession);
        setDate(nextDate);
        setLocalTime(localTimeInTimeZone(new Date(), nextSession.profile.timeZone));
      } catch (error) {
        if (controller.signal.aborted || viewGeneration.current !== view) return;
        setState("error");
        setMessageIsError(true);
        setMessage(error instanceof Error ? error.message : "Your session could not be verified.");
      }
    })();
    return () => {
      mounted.current = false;
      viewGeneration.current += 1;
      writeGeneration.current += 1;
      controller.abort();
      loadController.current?.abort();
      mutationController.current?.abort();
      inFlight.current = false;
    };
  }, [initialDate, signInAgain]);

  useEffect(() => {
    if (session && date) void loadDay(date);
    return () => loadController.current?.abort();
  }, [date, loadDay, session]);

  function selectDate(nextDate: string) {
    if (
      inFlight.current ||
      pendingRef.current ||
      !isLocalDate(nextDate) ||
      nextDate === dateRef.current
    )
      return;
    viewGeneration.current += 1;
    loadGeneration.current += 1;
    loadController.current?.abort();
    dateRef.current = nextDate;
    acceptedRead.current = null;
    setEdit(null);
    setDay(null);
    setAmount("");
    setReconcile(false);
    setMovedToDate(null);
    setState("loading");
    setDate(nextDate);
  }

  async function retryDayView() {
    if (inFlight.current || pendingRef.current) return;
    setEdit(null);
    setReconcile(false);
    const accepted = acceptedRead.current;
    const owner = ownerRef.current;
    const view = viewGeneration.current;
    const refreshed = await loadDay(dateRef.current, accepted?.message);
    if (!mounted.current || ownerRef.current !== owner || viewGeneration.current !== view) return;
    if (refreshed) acceptedRead.current = null;
    else if (
      accepted &&
      mounted.current &&
      accepted.sourceDate === dateRef.current &&
      ownerRef.current
    ) {
      setMessage(
        "The entry change was accepted. Retry the day view to refresh the exact total; the change will not be submitted again.",
      );
      setMessageIsError(true);
    }
  }

  async function mutate(operation: HydrationWriteOperation): Promise<void> {
    if (
      inFlight.current ||
      !hydrationWriteBelongsToView(operation, ownerRef.current, dateRef.current) ||
      (pendingRef.current && pendingRef.current !== operation)
    )
      return;
    inFlight.current = true;
    pendingRef.current = operation;
    setPending(operation);
    const controller = new AbortController();
    mutationController.current = controller;
    const view = viewGeneration.current;
    const generation = ++writeGeneration.current;
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      viewGeneration.current === view &&
      writeGeneration.current === generation &&
      hydrationWriteBelongsToView(operation, ownerRef.current, dateRef.current);
    setBusy(`${operation.method}:${operation.operationId}`);
    setMessageIsError(false);
    setMessage("Saving the hydration entry…");
    try {
      const response = await fetch(operation.path, {
        ...hydrationWriteRequest(operation),
        signal: controller.signal,
      });
      if (!current()) return;
      if (response.status === 401) return signInAgain();
      const body = await json(response);
      if (!current()) return;
      if (hydrationReadClosesPrivateUi(response.status, body)) return signInAgain();
      if (!response.ok) {
        // A timeout or rate limit does not establish that an earlier attempt
        // was rejected. Preserve its exact operation for accepted replay.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          pendingRef.current = null;
          setPending(null);
          setEdit(null);
          setDay(null);
          setReconcile(true);
          setState("error");
          setMessageIsError(true);
          setMessage(
            `${responseError(body, "The hydration entry or profile changed.")} Reload and review the current entry before confirming another correction.`,
          );
          return;
        }
        throw new Error(responseError(body, "The hydration entry could not be changed."));
      }
      assertHydrationMutationMatches(parseHydrationMutation(body), operation);
      pendingRef.current = null;
      setPending(null);
      setEdit(null);
      if (operation.method === "POST") setAmount("");
      const moved = operation.destinationDate !== operation.sourceDate;
      const successMessage = moved
        ? `Hydration entry moved to ${operation.destinationDate}. The selected source day ${operation.sourceDate} was refreshed.`
        : operation.successMessage;
      setMovedToDate(moved ? operation.destinationDate : null);
      acceptedRead.current = { message: successMessage, sourceDate: operation.sourceDate };
      const refreshed = await loadDay(operation.sourceDate, successMessage);
      if (!current()) return;
      if (refreshed) acceptedRead.current = null;
      else {
        setState("error");
        setMessageIsError(true);
        setMessage(
          `The entry change was accepted${moved ? ` and moved to ${operation.destinationDate}` : ""}, but the exact local-day view could not be refreshed. Retry the day view; the change will not be submitted again.`,
        );
      }
    } catch (error) {
      if (!current()) return;
      setDay(null);
      setState("error");
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The hydration entry could not be changed."} Retry the saved change to reuse its exact values, revision and operation key.`,
      );
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  }

  function newOperation(
    input: Pick<
      Parameters<typeof hydrationWriteOperation>[0],
      | "method"
      | "body"
      | "originalEntry"
      | "expectedTimeZone"
      | "destinationDate"
      | "successMessage"
    >,
  ): HydrationWriteOperation {
    if (
      !day ||
      day.localDate !== dateRef.current ||
      state !== "ready" ||
      !ownerRef.current ||
      session?.user.id !== ownerRef.current ||
      pendingRef.current ||
      inFlight.current ||
      reconcile
    ) {
      throw new TypeError("Load the selected hydration day before changing an entry.");
    }
    return hydrationWriteOperation({
      ...input,
      day,
      ownerUserId: ownerRef.current,
      operationId: crypto.randomUUID(),
    });
  }

  async function createEntry() {
    try {
      if (!day) throw new TypeError("Load the selected hydration day before adding an entry.");
      const prepared = prepareHydrationCreate(
        amount,
        date,
        localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      await mutate(
        newOperation({
          method: "POST",
          body: prepared.body,
          expectedTimeZone: prepared.expectedTimeZone,
          destinationDate: date,
          successMessage: `${prepared.body.amountMilliliters.toLocaleString("en-US")} milliliters added and the exact total refreshed.`,
        }),
      );
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration entry.");
    }
  }

  async function updateEntry() {
    if (!edit) return;
    try {
      const prepared = prepareHydrationUpdate(edit.amount, edit.entry, edit.time);
      await mutate(
        newOperation({
          method: "PATCH",
          ...prepared,
          originalEntry: edit.entry,
          successMessage: edit.time.enabled
            ? "Hydration time corrected and the exact total refreshed."
            : "Hydration amount updated and the exact total refreshed.",
        }),
      );
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration correction.");
    }
  }

  async function deleteEntry(entry: HydrationEntry) {
    if (!window.confirm(`Delete the ${entry.amountMilliliters} milliliter hydration entry?`))
      return;
    try {
      await mutate(
        newOperation({
          method: "DELETE",
          originalEntry: entry,
          destinationDate: entry.localDate,
          successMessage: "Hydration entry deleted and the exact total refreshed.",
        }),
      );
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Reload the hydration entry.");
    }
  }

  async function signOut() {
    setBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed && mounted.current) {
      setMessage("Sign out could not be confirmed. Your hydration log remains open; retry.");
      setState("error");
      setMessageIsError(true);
      setBusy(null);
    }
  }

  const dateQuery = date ? `?date=${encodeURIComponent(date)}` : "";
  const controlsDisabled =
    busy !== null || pending !== null || reconcile || !session || state === "loading";
  const createDisabled =
    controlsDisabled || state !== "ready" || day === null || day.localDate !== date;

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
          <Link aria-current="page" href={`/hydration${dateQuery}`}>
            Hydration
          </Link>
          <Link href={`/activities${dateQuery}`}>Activity</Link>
          <Link href={date ? `/reports?to=${encodeURIComponent(date)}` : "/reports"}>Reports</Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={busy !== null}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
      </aside>

      <section className="dashboard hydrationDashboard" aria-busy={state === "loading"}>
        <header className="dashboardHeader diaryHeader">
          <div>
            <p className="kicker">Private local-day hydration log</p>
            <h1>Hydration</h1>
          </div>
          <span className="statusPill">
            {day?.timeZone ?? session?.profile.timeZone ?? "Local time"}
          </span>
        </header>

        <fieldset className="dateNavigator">
          <legend className="srOnly">Hydration date</legend>
          <button
            aria-label="Previous day"
            disabled={!date || controlsDisabled}
            onClick={() => selectDate(shiftLocalDate(date, -1))}
            type="button"
          >
            ←
          </button>
          <label htmlFor="hydration-date">Local date</label>
          <input
            disabled={!date || controlsDisabled}
            id="hydration-date"
            onChange={(event) => {
              if (isLocalDate(event.target.value)) {
                selectDate(event.target.value);
              }
            }}
            type="date"
            value={date}
          />
          <button
            aria-label="Next day"
            disabled={!date || controlsDisabled}
            onClick={() => selectDate(shiftLocalDate(date, 1))}
            type="button"
          >
            →
          </button>
          <button
            disabled={controlsDisabled}
            onClick={() => {
              const timeZone = day?.timeZone ?? session?.profile.timeZone;
              if (timeZone) selectDate(localDateInTimeZone(new Date(), timeZone));
            }}
            type="button"
          >
            Today
          </button>
        </fieldset>

        <p
          className={`hydrationStatus hydrationStatus--${messageIsError ? "error" : state}`}
          role={messageIsError ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
        {state === "error" && session && date && !pending ? (
          <button
            className="buttonQuiet hydrationRetry"
            disabled={busy !== null}
            onClick={() => void retryDayView()}
            type="button"
          >
            {reconcile ? "Reload and review entries" : "Retry day view"}
          </button>
        ) : null}

        {pending ? (
          <button
            className="buttonPrimary"
            disabled={busy !== null}
            onClick={() => void mutate(pending)}
            type="button"
          >
            Retry saved change
          </button>
        ) : null}
        {movedToDate ? (
          <button
            className="buttonQuiet"
            disabled={controlsDisabled}
            onClick={() => selectDate(movedToDate)}
            type="button"
          >
            View destination day {movedToDate}
          </button>
        ) : null}
        <Link href={`/dashboard${dateQuery}`}>Return to Today overview</Link>

        <div className="hydrationGrid">
          <section className="retentionSection" aria-labelledby="hydration-total-heading">
            <p className="kicker">Exact local-day sum</p>
            <h2 id="hydration-total-heading" className="hydrationTotal">
              {day ? `${day.totalMilliliters.toLocaleString("en-US")} mL` : "—"}
            </h2>
            <p className="finePrint">
              Sum of the bounded hydration entries shown for {date || "this day"}.
            </p>
          </section>

          <section className="retentionSection" aria-labelledby="hydration-add-heading">
            <div className="sectionHeading">
              <div>
                <p className="kicker">New entry</p>
                <h2 id="hydration-add-heading">Add milliliters</h2>
              </div>
            </div>
            <form
              className="workspaceForm hydrationForm"
              onSubmit={(event) => {
                event.preventDefault();
                void createEntry();
              }}
            >
              <label className="formField">
                <span>Milliliters</span>
                <input
                  aria-describedby="hydration-amount-help"
                  disabled={createDisabled}
                  inputMode="numeric"
                  maxLength={5}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="250"
                  required
                  value={amount}
                />
              </label>
              <small className="fieldHelp" id="hydration-amount-help">
                Whole milliliters, 1 to 20,000 per entry.
              </small>
              <label className="formField">
                <span>Local time</span>
                <input
                  disabled={createDisabled}
                  onChange={(event) => {
                    untouchedDefaultOccurredAt.current = null;
                    setLocalTime(event.target.value);
                  }}
                  required
                  type="time"
                  value={localTime}
                />
              </label>
              <button className="buttonPrimary" disabled={createDisabled} type="submit">
                {busy?.startsWith("POST:") ? "Adding…" : "Add entry"}
              </button>
            </form>
          </section>
        </div>

        <section
          className="retentionSection hydrationEntries"
          aria-labelledby="hydration-entries-heading"
        >
          <div className="sectionHeading">
            <div>
              <p className="kicker">Bounded day log</p>
              <h2 id="hydration-entries-heading">Entries</h2>
            </div>
            <p>{day ? `${day.entries.length} of 64 maximum` : "Up to 64 per local day"}</p>
          </div>
          {day?.entries.length ? (
            <ul className="recordList">
              {day.entries.map((entry) => (
                <li key={entry.id} aria-label={hydrationEntryAccessibilityLabel(entry)}>
                  {edit?.entry.id === entry.id ? (
                    <form
                      className="hydrationEditor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateEntry();
                      }}
                    >
                      <label className="formField">
                        <span>Milliliters at {entry.localTime.slice(0, 5)}</span>
                        <input
                          disabled={controlsDisabled}
                          inputMode="numeric"
                          maxLength={5}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, amount: event.target.value } : current,
                            )
                          }
                          required
                          value={edit.amount}
                        />
                      </label>
                      <p className="finePrint">
                        Originally logged: {edit.entry.localDate} {edit.entry.localTime} ·{" "}
                        {edit.entry.timeZone}. Changing only milliliters preserves that exact time.
                      </p>
                      <label className="formField">
                        <span>
                          <input
                            checked={edit.time.enabled}
                            disabled={controlsDisabled}
                            onChange={(event) =>
                              setEdit((current) =>
                                current
                                  ? {
                                      ...current,
                                      time: changeHydrationTimeDraft(current.time, {
                                        enabled: event.target.checked,
                                      }),
                                    }
                                  : current,
                              )
                            }
                            type="checkbox"
                          />{" "}
                          Correct date or time
                        </span>
                      </label>
                      {edit.time.enabled ? (
                        <fieldset disabled={controlsDisabled}>
                          <legend>Corrected time in {edit.time.timeZone}</legend>
                          <label className="formField">
                            <span>Corrected local date</span>
                            <input
                              onChange={(event) =>
                                setEdit((current) =>
                                  current
                                    ? {
                                        ...current,
                                        time: changeHydrationTimeDraft(current.time, {
                                          localDate: event.target.value,
                                        }),
                                      }
                                    : current,
                                )
                              }
                              required
                              type="date"
                              value={edit.time.localDate}
                            />
                          </label>
                          <label className="formField">
                            <span>Corrected local time</span>
                            <input
                              onChange={(event) =>
                                setEdit((current) =>
                                  current
                                    ? {
                                        ...current,
                                        time: changeHydrationTimeDraft(current.time, {
                                          localTime: event.target.value,
                                        }),
                                      }
                                    : current,
                                )
                              }
                              required
                              type="time"
                              value={edit.time.localTime}
                            />
                          </label>
                          {timeResolution?.kind === "gap" ? (
                            <p role="alert">
                              This local time does not exist in {edit.time.timeZone}. Choose another
                              time.
                            </p>
                          ) : timeResolution?.kind === "invalid" ? (
                            <p role="alert">Enter a valid local date and time.</p>
                          ) : timeResolution?.kind === "ambiguous" ? (
                            <fieldset>
                              <legend>
                                This local time occurs more than once. Choose an occurrence.
                              </legend>
                              {timeResolution.candidates.map((candidate, index) => (
                                <label className="formField" key={candidate.occurredAt}>
                                  <span>
                                    <input
                                      checked={edit.time.occurrence === candidate.occurredAt}
                                      name="hydration-time-occurrence"
                                      onChange={() =>
                                        setEdit((current) =>
                                          current
                                            ? {
                                                ...current,
                                                time: {
                                                  ...current.time,
                                                  occurrence: candidate.occurredAt,
                                                },
                                              }
                                            : current,
                                        )
                                      }
                                      required
                                      type="radio"
                                      value={candidate.occurredAt}
                                    />{" "}
                                    {index === 0
                                      ? "Earlier"
                                      : index === timeResolution.candidates.length - 1
                                        ? "Later"
                                        : `Occurrence ${index + 1}`}{" "}
                                    occurrence · {candidate.utcOffsetLabel}
                                  </span>
                                </label>
                              ))}
                            </fieldset>
                          ) : null}
                        </fieldset>
                      ) : null}
                      <div className="entryActions">
                        <button className="buttonPrimary" disabled={controlsDisabled} type="submit">
                          {edit.time.enabled ? "Save correction" : "Save amount"}
                        </button>
                        <button
                          className="buttonQuiet"
                          disabled={controlsDisabled}
                          onClick={() => setEdit(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div>
                        <strong>{entry.amountMilliliters.toLocaleString("en-US")} mL</strong>
                        <small>
                          <time dateTime={entry.occurredAt}>{entry.localTime.slice(0, 5)}</time> ·{" "}
                          {entry.timeZone}
                        </small>
                      </div>
                      <div className="entryActions">
                        <button
                          className="buttonQuiet"
                          disabled={controlsDisabled}
                          onClick={() =>
                            setEdit({
                              entry,
                              amount: String(entry.amountMilliliters),
                              time: hydrationTimeDraft(entry, day.timeZone),
                            })
                          }
                          type="button"
                        >
                          Edit entry
                        </button>
                        <button
                          className="buttonDanger"
                          disabled={controlsDisabled}
                          onClick={() => void deleteEntry(entry)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : state === "ready" ? (
            <p className="hydrationEmpty">No hydration entries for this local day.</p>
          ) : null}
        </section>
      </section>
    </>
  );
}
