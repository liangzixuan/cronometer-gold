"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  parseSession,
  quoteRevision,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import {
  type HydrationDay,
  type HydrationEntry,
  hydrationAmountFromDraft,
  hydrationEntryAccessibilityLabel,
  parseHydrationDay,
  parseHydrationMutation,
} from "../../lib/hydration";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface HydrationClientProps {
  readonly initialDate?: string;
}

interface HydrationEdit {
  readonly entry: HydrationEntry;
  readonly amount: string;
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
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(null);

  const signInAgain = useCallback(() => {
    loadController.current?.abort();
    setSession(null);
    setDay(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      setState("loading");
      setMessageIsError(false);
      setMessage(`Loading hydration entries for ${requestedDate}…`);
      try {
        const response = await fetch(`/api/hydration?date=${encodeURIComponent(requestedDate)}`, {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (response.status === 401) {
          signInAgain();
          return false;
        }
        const body = await json(response);
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Hydration entries could not be loaded."));
        }
        const next = parseHydrationDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The hydration service returned another local day.");
        }
        if (loadedTimeZone.current !== next.timeZone) {
          const capturedNow = new Date();
          setLocalTime(localTimeInTimeZone(capturedNow, next.timeZone).slice(0, 5));
          untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          loadedTimeZone.current = next.timeZone;
        }
        setDay(next);
        setState("ready");
        setMessageIsError(false);
        setMessage(successMessage ?? dayMessage(next));
        return true;
      } catch (error) {
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
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
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) return signInAgain();
        if (!response.ok) throw new Error("Your session could not be verified.");
        const nextSession = parseSession(await json(response));
        if (controller.signal.aborted) return;
        const today = localDateInTimeZone(new Date(), nextSession.profile.timeZone);
        const nextDate = initialDate && isLocalDate(initialDate) ? initialDate : today;
        setSession(nextSession);
        setDate(nextDate);
        setLocalTime(localTimeInTimeZone(new Date(), nextSession.profile.timeZone).slice(0, 5));
      } catch (error) {
        if (controller.signal.aborted) return;
        setState("error");
        setMessageIsError(true);
        setMessage(error instanceof Error ? error.message : "Your session could not be verified.");
      }
    })();
    return () => controller.abort();
  }, [initialDate, signInAgain]);

  useEffect(() => {
    if (session && date) void loadDay(date);
    return () => loadController.current?.abort();
  }, [date, loadDay, session]);

  function operationId(key: string): string {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    operations.current.set(key, created);
    return created;
  }

  async function mutate(input: {
    readonly intentKey: string;
    readonly path: string;
    readonly method: "DELETE" | "PATCH" | "POST";
    readonly body?: unknown;
    readonly revision?: string;
    readonly expectedTimeZone?: string;
    readonly successMessage: string;
  }): Promise<boolean> {
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the hydration entry…");
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "idempotency-key": operationId(input.intentKey),
      };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
      if (input.expectedTimeZone) {
        headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
      });
      if (response.status === 401) {
        signInAgain();
        return false;
      }
      const body = await json(response);
      if (!response.ok) {
        throw new Error(responseError(body, "The hydration entry could not be changed."));
      }
      parseHydrationMutation(body);
      operations.current.delete(input.intentKey);
      const refreshed = await loadDay(date, input.successMessage);
      if (!refreshed) {
        setState("error");
        setMessageIsError(true);
        setMessage(
          "The entry change was accepted, but the exact local-day view could not be refreshed. Retry the day view; do not submit the change again.",
        );
      }
      return true;
    } catch (error) {
      setState("error");
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The hydration entry could not be changed."} Retry to safely reuse the same operation.`,
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createEntry() {
    if (!day || day.localDate !== date || state !== "ready") {
      setMessageIsError(true);
      setMessage("Load the selected hydration day before adding an entry.");
      return;
    }
    try {
      const prepared = prepareHydrationCreate(
        amount,
        date,
        localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      const intentKey = `create:${prepared.body.occurredAt}:${prepared.expectedTimeZone}:${prepared.body.amountMilliliters}`;
      if (
        await mutate({
          intentKey,
          path: "/api/hydration/entries?profileTimeZonePrecondition=v1",
          method: "POST",
          body: prepared.body,
          expectedTimeZone: prepared.expectedTimeZone,
          successMessage: `${prepared.body.amountMilliliters.toLocaleString("en-US")} milliliters added and the exact total refreshed.`,
        })
      ) {
        setAmount("");
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration entry.");
    }
  }

  async function updateEntry() {
    if (!edit) return;
    try {
      const body = hydrationUpdateBody(edit.amount);
      const intentKey = `update:${edit.entry.id}:${edit.entry.revision}:${body.amountMilliliters}`;
      if (
        await mutate({
          intentKey,
          path: `/api/hydration/entries/${encodeURIComponent(edit.entry.id)}`,
          method: "PATCH",
          body,
          revision: edit.entry.revision,
          successMessage: "Hydration amount updated and the exact total refreshed.",
        })
      ) {
        setEdit(null);
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration amount.");
    }
  }

  async function deleteEntry(entry: HydrationEntry) {
    if (!window.confirm(`Delete the ${entry.amountMilliliters} milliliter hydration entry?`))
      return;
    const intentKey = `delete:${entry.id}:${entry.revision}`;
    if (
      await mutate({
        intentKey,
        path: `/api/hydration/entries/${encodeURIComponent(entry.id)}`,
        method: "DELETE",
        revision: entry.revision,
        successMessage: "Hydration entry deleted and the exact total refreshed.",
      })
    ) {
      setEdit((current) => (current?.entry.id === entry.id ? null : current));
    }
  }

  async function signOut() {
    setBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed) {
      setMessage("Sign out could not be confirmed. Your hydration log remains open; retry.");
      setState("error");
      setMessageIsError(true);
      setBusy(null);
    }
  }

  const dateQuery = date ? `?date=${encodeURIComponent(date)}` : "";
  const controlsDisabled = busy !== null || !session || state === "loading";
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
            onClick={() => setDate(shiftLocalDate(date, -1))}
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
                setDate(event.target.value);
                setEdit(null);
              }
            }}
            type="date"
            value={date}
          />
          <button
            aria-label="Next day"
            disabled={!date || controlsDisabled}
            onClick={() => setDate(shiftLocalDate(date, 1))}
            type="button"
          >
            →
          </button>
          <button
            disabled={controlsDisabled}
            onClick={() => {
              const timeZone = day?.timeZone ?? session?.profile.timeZone;
              if (timeZone) setDate(localDateInTimeZone(new Date(), timeZone));
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
        {state === "error" && session && date ? (
          <button
            className="buttonQuiet hydrationRetry"
            disabled={busy !== null}
            onClick={() => void loadDay(date)}
            type="button"
          >
            Retry day view
          </button>
        ) : null}

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
                {busy?.startsWith("create:") ? "Adding…" : "Add entry"}
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
                      <div className="entryActions">
                        <button className="buttonPrimary" disabled={controlsDisabled} type="submit">
                          Save amount
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
                            setEdit({ entry, amount: String(entry.amountMilliliters) })
                          }
                          type="button"
                        >
                          Edit amount
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
