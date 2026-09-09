"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityCreateBody,
  type ActivityDay,
  type ActivityEntry,
  type ActivityMutationExpectation,
  type ActivityUpdateBody,
  activityDurationFromDraft,
  activityEnergyFromDraft,
  activityEntryAccessibilityLabel,
  assertActivityMutationSemantics,
  canonicalActivityNameFromDraft,
  parseActivityDay,
  parseActivityMutation,
} from "../../lib/activity";
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
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface ActivityClientProps {
  readonly initialDate?: string;
}

interface ActivityEdit {
  readonly entry: ActivityEntry;
  readonly name: string;
  readonly duration: string;
  readonly energy: string;
  readonly localDate: string;
  readonly localTime: string;
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

export function prepareActivityCreate(
  nameDraft: string,
  durationDraft: string,
  energyDraft: string,
  selectedLocalDate: string,
  localTime: string,
  loadedDay: Pick<ActivityDay, "localDate" | "timeZone">,
  untouchedDefaultOccurredAt?: string,
): {
  readonly body: ActivityCreateBody;
  readonly expectedTimeZone: string;
} {
  if (loadedDay.localDate !== selectedLocalDate) {
    throw new TypeError("Load the selected activity day before adding an entry.");
  }
  const retainedOccurredAt = retainedDefaultOccurredAt(
    untouchedDefaultOccurredAt,
    selectedLocalDate,
    localTime,
    loadedDay.timeZone,
  );
  return {
    body: {
      name: canonicalActivityNameFromDraft(nameDraft),
      durationMinutes: activityDurationFromDraft(durationDraft),
      selfReportedEnergyKilocalories: activityEnergyFromDraft(energyDraft),
      occurredAt:
        retainedOccurredAt ??
        localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone),
    },
    expectedTimeZone: loadedDay.timeZone,
  };
}

export function activityUpdateBody(nameDraft: string, durationDraft: string, energyDraft: string) {
  return {
    name: canonicalActivityNameFromDraft(nameDraft),
    durationMinutes: activityDurationFromDraft(durationDraft),
    selfReportedEnergyKilocalories: activityEnergyFromDraft(energyDraft),
  };
}

export function prepareActivityUpdate(
  nameDraft: string,
  durationDraft: string,
  energyDraft: string,
  selectedLocalDate: string,
  localTime: string,
  entry: ActivityEntry,
  loadedDay: Pick<ActivityDay, "localDate" | "timeZone">,
): { readonly body: ActivityUpdateBody; readonly expectedTimeZone?: string } {
  if (loadedDay.localDate !== entry.localDate) {
    throw new TypeError("Reload the activity entry before editing it.");
  }
  if (!isLocalDate(selectedLocalDate)) throw new TypeError("Choose a valid activity date.");
  const fields = activityUpdateBody(nameDraft, durationDraft, energyDraft);
  const timeChanged =
    selectedLocalDate !== entry.localDate || localTime !== entry.localTime.slice(0, 5);
  const body: ActivityUpdateBody = {
    ...(fields.name === entry.name ? {} : { name: fields.name }),
    ...(fields.durationMinutes === entry.durationMinutes
      ? {}
      : { durationMinutes: fields.durationMinutes }),
    ...(fields.selfReportedEnergyKilocalories === entry.selfReportedEnergyKilocalories
      ? {}
      : { selfReportedEnergyKilocalories: fields.selfReportedEnergyKilocalories }),
    ...(timeChanged
      ? { occurredAt: localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone) }
      : {}),
  };
  if (Object.keys(body).length === 0) throw new RangeError("Change at least one activity field.");
  return timeChanged ? { body, expectedTimeZone: loadedDay.timeZone } : { body };
}

function dayMessage(day: ActivityDay): string {
  if (day.entries.length === 0) return "No activity entries for this local day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "activity" : "activities"}; ${day.totalDurationMinutes.toLocaleString("en-US")} total minutes.`;
}

export function ActivityClient({ initialDate }: ActivityClientProps) {
  const router = useRouter();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<ActivityDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private activity log…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [energy, setEnergy] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [edit, setEdit] = useState<ActivityEdit | null>(null);
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
      const expectedOwnerUserId = session?.user.id;
      if (!expectedOwnerUserId) return false;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      setState("loading");
      setMessageIsError(false);
      setMessage(`Loading activity entries for ${requestedDate}…`);
      try {
        const response = await fetch(`/api/activities?date=${encodeURIComponent(requestedDate)}`, {
          cache: "no-store",
          headers: {
            accept: "application/json",
            "x-expected-owner-user-id": expectedOwnerUserId,
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (response.status === 401) {
          signInAgain();
          return false;
        }
        const body = await json(response);
        if (response.status === 409 && responseCode(body) === "ACTIVITY_OWNER_CHANGED") {
          signInAgain();
          return false;
        }
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Activity entries could not be loaded."));
        }
        const next = parseActivityDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The activity service returned another local day.");
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
          error instanceof Error ? error.message : "Activity entries could not be loaded.",
        );
        return false;
      }
    },
    [session?.user.id, signInAgain],
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
    readonly expectedOwnerUserId: string;
    readonly expectation: ActivityMutationExpectation;
    readonly successMessage: string;
  }): Promise<boolean> {
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the activity entry…");
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "idempotency-key": operationId(input.intentKey),
        "x-expected-owner-user-id": input.expectedOwnerUserId,
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
      if (response.status === 409 && responseCode(body) === "ACTIVITY_OWNER_CHANGED") {
        operations.current.delete(input.intentKey);
        signInAgain();
        return false;
      }
      if (response.status === 409 && responseCode(body) === "ACTIVITY_TIME_ZONE_CHANGED") {
        operations.current.delete(input.intentKey);
        const refreshed = await loadDay(date);
        setMessageIsError(true);
        setMessage(
          refreshed
            ? "Your profile time zone changed. No activity was saved. Fresh entries were loaded; review the local date and time before saving again."
            : "Your profile time zone changed and no activity was saved. Refresh this page, then review the local date and time before saving again.",
        );
        return false;
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          operations.current.delete(input.intentKey);
          const staleView = response.status === 404 || response.status === 412;
          if (staleView) {
            setEdit(null);
            await loadDay(date);
          }
          setMessageIsError(true);
          setMessage(
            staleView
              ? "The activity changed elsewhere and was not saved. Fresh entries were loaded; review before saving again."
              : `${responseError(body, "The activity entry was not changed.")} Review the entry before submitting again.`,
          );
          return false;
        }
        throw new Error(responseError(body, "The activity entry could not be changed."));
      }
      const mutation = parseActivityMutation(body);
      assertActivityMutationSemantics(mutation, input.expectation);
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
        `${error instanceof Error ? error.message : "The activity entry could not be changed."} Retry to safely reuse the same operation.`,
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createEntry() {
    if (!session || !day || day.localDate !== date || state !== "ready") {
      setMessageIsError(true);
      setMessage("Load the selected activity day before adding an entry.");
      return;
    }
    try {
      const prepared = prepareActivityCreate(
        name,
        duration,
        energy,
        date,
        localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      const initiatingOwnerUserId = session.user.id;
      const intentKey = `create:${initiatingOwnerUserId}:${prepared.expectedTimeZone}:${JSON.stringify(prepared.body)}`;
      if (
        await mutate({
          intentKey,
          path: "/api/activities/entries?profileTimeZonePrecondition=v1",
          method: "POST",
          body: prepared.body,
          expectedOwnerUserId: initiatingOwnerUserId,
          expectedTimeZone: prepared.expectedTimeZone,
          expectation: { kind: "create", sourceLocalDate: date, request: prepared.body },
          successMessage: `${prepared.body.name} added and the activity history refreshed.`,
        })
      ) {
        setName("");
        setDuration("");
        setEnergy("");
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid activity entry.");
    }
  }

  async function updateEntry() {
    if (!session || !edit || !day) return;
    try {
      const prepared = prepareActivityUpdate(
        edit.name,
        edit.duration,
        edit.energy,
        edit.localDate,
        edit.localTime,
        edit.entry,
        day,
      );
      const initiatingOwnerUserId = session.user.id;
      const intentKey = `update:${initiatingOwnerUserId}:${edit.entry.id}:${edit.entry.revision}:${prepared.expectedTimeZone ?? "no-zone-guard"}:${JSON.stringify(prepared.body)}`;
      if (
        await mutate({
          intentKey,
          path: `/api/activities/entries/${encodeURIComponent(edit.entry.id)}${prepared.expectedTimeZone ? "?profileTimeZonePrecondition=v1" : ""}`,
          method: "PATCH",
          body: prepared.body,
          expectedOwnerUserId: initiatingOwnerUserId,
          revision: edit.entry.revision,
          ...(prepared.expectedTimeZone ? { expectedTimeZone: prepared.expectedTimeZone } : {}),
          expectation: {
            kind: "update",
            entryId: edit.entry.id,
            sourceLocalDate: edit.entry.localDate,
            request: prepared.body,
          },
          successMessage:
            edit.localDate === edit.entry.localDate
              ? "Activity updated and the day history refreshed."
              : `Activity moved to ${edit.localDate}; this source day was refreshed.`,
        })
      ) {
        setEdit(null);
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter valid activity details.");
    }
  }

  async function deleteEntry(entry: ActivityEntry) {
    if (!session) return;
    if (!window.confirm(`Delete ${entry.name} from this activity history?`)) return;
    const initiatingOwnerUserId = session.user.id;
    const intentKey = `delete:${initiatingOwnerUserId}:${entry.id}:${entry.revision}`;
    if (
      await mutate({
        intentKey,
        path: `/api/activities/entries/${encodeURIComponent(entry.id)}`,
        method: "DELETE",
        expectedOwnerUserId: initiatingOwnerUserId,
        revision: entry.revision,
        expectation: { kind: "delete", entryId: entry.id, sourceLocalDate: entry.localDate },
        successMessage: "Activity deleted and the day history refreshed.",
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
      setMessage("Sign out could not be confirmed. Your activity log remains open; retry.");
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
          <Link href={`/hydration${dateQuery}`}>Hydration</Link>
          <Link aria-current="page" href={`/activities${dateQuery}`}>
            Activity
          </Link>
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

      <section className="dashboard activityDashboard" aria-busy={state === "loading"}>
        <header className="dashboardHeader diaryHeader">
          <div>
            <p className="kicker">Private local-day activity log</p>
            <h1>Activity</h1>
          </div>
          <span className="statusPill">
            {day?.timeZone ?? session?.profile.timeZone ?? "Local time"}
          </span>
        </header>

        <fieldset className="dateNavigator">
          <legend className="srOnly">Activity date</legend>
          <button
            aria-label="Previous day"
            disabled={!date || controlsDisabled}
            onClick={() => setDate(shiftLocalDate(date, -1))}
            type="button"
          >
            ←
          </button>
          <label htmlFor="activity-date">Local date</label>
          <input
            disabled={!date || controlsDisabled}
            id="activity-date"
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
          className={`activityStatus activityStatus--${messageIsError ? "error" : state}`}
          role={messageIsError ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
        {state === "error" && session && date ? (
          <button
            className="buttonQuiet activityRetry"
            disabled={busy !== null}
            onClick={() => void loadDay(date)}
            type="button"
          >
            Retry day view
          </button>
        ) : null}

        <div className="activityGrid">
          <section className="retentionSection" aria-labelledby="activity-total-heading">
            <p className="kicker">Logged local-day duration</p>
            <h2 id="activity-total-heading" className="activityTotal">
              {day ? `${day.totalDurationMinutes.toLocaleString("en-US")} min` : "—"}
            </h2>
            <p className="finePrint">
              Sum of logged durations for {date || "this day"}. Overlapping activities are each
              counted.
            </p>
          </section>

          <section className="retentionSection" aria-labelledby="activity-add-heading">
            <div className="sectionHeading">
              <div>
                <p className="kicker">New entry</p>
                <h2 id="activity-add-heading">Add activity</h2>
              </div>
            </div>
            <form
              className="workspaceForm activityForm"
              onSubmit={(event) => {
                event.preventDefault();
                void createEntry();
              }}
            >
              <label className="formField">
                <span>Activity name</span>
                <input
                  disabled={createDisabled}
                  maxLength={240}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Trail run"
                  required
                  value={name}
                />
              </label>
              <label className="formField">
                <span>Duration (minutes)</span>
                <input
                  aria-describedby="activity-duration-help"
                  disabled={createDisabled}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={(event) => setDuration(event.target.value)}
                  placeholder="30"
                  required
                  value={duration}
                />
              </label>
              <small className="fieldHelp" id="activity-duration-help">
                Whole minutes, 1 to 1,440 per entry.
              </small>
              <label className="formField">
                <span>Self-reported calories (optional)</span>
                <input
                  aria-describedby="activity-energy-help"
                  disabled={createDisabled}
                  inputMode="decimal"
                  maxLength={9}
                  onChange={(event) => setEnergy(event.target.value)}
                  placeholder="250"
                  value={energy}
                />
              </label>
              <small className="fieldHelp" id="activity-energy-help">
                Optional calories are your own estimate. They are recorded for history only and do
                not change nutrition goals or remaining calories.
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
          className="retentionSection activityEntries"
          aria-labelledby="activity-entries-heading"
        >
          <div className="sectionHeading">
            <div>
              <p className="kicker">Bounded day log</p>
              <h2 id="activity-entries-heading">Entries</h2>
            </div>
            <p>{day ? `${day.entries.length} of 64 maximum` : "Up to 64 per local day"}</p>
          </div>
          {day?.entries.length ? (
            <ul className="recordList">
              {day.entries.map((entry) => (
                <li key={entry.id} aria-label={activityEntryAccessibilityLabel(entry)}>
                  {edit?.entry.id === entry.id ? (
                    <form
                      className="activityEditor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateEntry();
                      }}
                    >
                      <label className="formField">
                        <span>Activity name</span>
                        <input
                          disabled={controlsDisabled}
                          maxLength={240}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, name: event.target.value } : current,
                            )
                          }
                          required
                          value={edit.name}
                        />
                      </label>
                      <label className="formField">
                        <span>Duration (minutes)</span>
                        <input
                          disabled={controlsDisabled}
                          inputMode="numeric"
                          maxLength={4}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, duration: event.target.value } : current,
                            )
                          }
                          required
                          value={edit.duration}
                        />
                      </label>
                      <label className="formField">
                        <span>Self-reported calories (optional)</span>
                        <input
                          aria-describedby={`activity-edit-energy-help-${entry.id}`}
                          disabled={controlsDisabled}
                          inputMode="decimal"
                          maxLength={9}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, energy: event.target.value } : current,
                            )
                          }
                          value={edit.energy}
                        />
                      </label>
                      <small className="fieldHelp" id={`activity-edit-energy-help-${entry.id}`}>
                        History only; this does not change goals or remaining calories.
                      </small>
                      <label className="formField">
                        <span>Local date</span>
                        <input
                          disabled={controlsDisabled}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, localDate: event.target.value } : current,
                            )
                          }
                          required
                          type="date"
                          value={edit.localDate}
                        />
                      </label>
                      <label className="formField">
                        <span>Local time</span>
                        <input
                          disabled={controlsDisabled}
                          onChange={(event) =>
                            setEdit((current) =>
                              current ? { ...current, localTime: event.target.value } : current,
                            )
                          }
                          required
                          type="time"
                          value={edit.localTime}
                        />
                      </label>
                      <small className="fieldHelp">
                        Moving an entry uses the profile time zone shown at the top of this page.
                      </small>
                      <div className="entryActions">
                        <button className="buttonPrimary" disabled={controlsDisabled} type="submit">
                          Save activity
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
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.durationMinutes.toLocaleString("en-US")} min ·{" "}
                          {entry.selfReportedEnergyKilocalories
                            ? `${entry.selfReportedEnergyKilocalories} kcal (self-reported) · `
                            : "No calorie estimate · "}
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
                              name: entry.name,
                              duration: String(entry.durationMinutes),
                              energy: entry.selfReportedEnergyKilocalories ?? "",
                              localDate: entry.localDate,
                              localTime: entry.localTime.slice(0, 5),
                            })
                          }
                          type="button"
                        >
                          Edit activity
                        </button>
                        <button
                          className="buttonDanger"
                          disabled={controlsDisabled}
                          onClick={() => void deleteEntry(entry)}
                          type="button"
                        >
                          Delete {entry.name}
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : state === "ready" ? (
            <p className="activityEmpty">No activity entries for this local day.</p>
          ) : null}
        </section>
      </section>
    </>
  );
}
