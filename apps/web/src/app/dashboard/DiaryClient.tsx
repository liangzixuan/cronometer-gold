"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createOperationId,
  currentLocalDate,
  type DiaryDay,
  type DiaryEntry,
  diaryEditErrorMessage,
  entryEnergyDisplay,
  isLocalDate,
  isPositiveDecimal,
  localDateInTimeZone,
  localDateTimeToInstant,
  type MealSlot,
  mealLabel,
  mealSlots,
  nutrientDisplay,
  parseDiaryDay,
  parseDiaryMutation,
  parseSession,
  quoteRevision,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface EntryEditor {
  readonly entryId: string;
  readonly originalDate: string;
  readonly quantity: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
  readonly originalLocalTime: string;
  readonly timeZone: string;
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
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.length <= 500 ? error : fallback;
}

function editState(entry: DiaryEntry, currentProfileTimeZone: string): EntryEditor {
  const localTime = entry.localTime.slice(0, 5);
  return {
    entryId: entry.id,
    originalDate: entry.localDate,
    quantity: entry.portion.kind === "serving" ? entry.portion.amount : entry.portion.grams,
    mealSlot: entry.mealSlot,
    localDate: entry.localDate,
    localTime,
    originalLocalTime: localTime,
    timeZone: currentProfileTimeZone,
  };
}

function entryName(entry: DiaryEntry): string {
  return entry.entryKind === "food" ? entry.food.name : entry.recipe.name;
}

export function DiaryClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const explicitDate = searchParams.get("date");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState(() =>
    explicitDate && isLocalDate(explicitDate) ? explicitDate : currentLocalDate(),
  );
  const [diary, setDiary] = useState<DiaryDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private diary…");
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const operationIds = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);

  const signInAgain = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const loadDiary = useCallback(
    async (requestedDate: string) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      setState("loading");
      setMessage(`Loading ${requestedDate}…`);
      try {
        const response = await fetch(`/api/diary?date=${encodeURIComponent(requestedDate)}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) return signInAgain();
        const body = await json(response);
        if (!response.ok) throw new Error(responseError(body, "The diary could not be loaded."));
        const next = parseDiaryDay(body);
        if (controller.signal.aborted) return;
        setDiary(next);
        setState("ready");
        setMessage(
          next.entries.length === 0
            ? "No foods logged for this local day."
            : `${next.entries.length} ${next.entries.length === 1 ? "entry" : "entries"} loaded.`,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setDiary(null);
        setState("error");
        setMessage(error instanceof Error ? error.message : "The diary could not be loaded.");
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
        const body = await json(response);
        if (!response.ok)
          throw new Error(responseError(body, "Your session could not be verified."));
        const nextSession = parseSession(body);
        if (!controller.signal.aborted) {
          setSession(nextSession);
          if (!(explicitDate && isLocalDate(explicitDate))) {
            setDate(localDateInTimeZone(new Date(), nextSession.profile.timeZone));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState("error");
          setMessage(
            error instanceof Error ? error.message : "Your session could not be verified.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [explicitDate, signInAgain]);

  useEffect(() => {
    void loadDiary(date);
    return () => loadController.current?.abort();
  }, [date, loadDiary]);

  function chooseDate(next: string) {
    if (!isLocalDate(next)) return;
    setEditor(null);
    setDate(next);
  }

  function operationId(key: string): string {
    const existing = operationIds.current.get(key);
    if (existing) return existing;
    const created = createOperationId();
    operationIds.current.set(key, created);
    return created;
  }

  async function saveEntry() {
    if (!editor || !diary || !isPositiveDecimal(editor.quantity)) {
      setMessage("Quantity must be a positive decimal number.");
      return;
    }
    const entry = diary.entries.find((candidate) => candidate.id === editor.entryId);
    if (!entry) {
      setEditor(null);
      setMessage("That entry is no longer present. Fresh diary data is required.");
      return;
    }
    setMutationBusy(editor.entryId);
    setMessage("Saving the diary entry…");
    try {
      const timestampChanged =
        editor.localDate !== editor.originalDate || editor.localTime !== editor.originalLocalTime;
      const body = {
        portion:
          entry.portion.kind === "serving"
            ? entry.entryKind === "food"
              ? { kind: "serving", servingId: entry.portion.servingId, amount: editor.quantity }
              : { kind: "serving", amount: editor.quantity }
            : { kind: "grams", grams: editor.quantity },
        mealSlot: editor.mealSlot,
        ...(timestampChanged
          ? {
              occurredAt: localDateTimeToInstant(
                editor.localDate,
                editor.localTime,
                editor.timeZone,
              ),
            }
          : {}),
      };
      const key = `edit:${editor.entryId}:${JSON.stringify(body)}:${diary.revision}`;
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(editor.entryId)}?date=${encodeURIComponent(editor.originalDate)}`,
        {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": operationId(key),
            "if-match": quoteRevision(entry.revision),
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        setEditor(null);
        await loadDiary(editor.originalDate);
        setMessage(
          "The diary changed elsewhere. Fresh values were loaded; review your edit again.",
        );
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The entry could not be saved."));
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      setEditor(null);
      const savedDate = mutation.entry?.localDate ?? editor.localDate;
      if (savedDate !== editor.originalDate) {
        setDate(savedDate);
      } else {
        await loadDiary(editor.originalDate);
        setMessage("Diary entry saved with fresh totals.");
      }
    } catch (error) {
      setMessage(diaryEditErrorMessage(error));
    } finally {
      setMutationBusy(null);
    }
  }

  async function deleteEntry(entry: DiaryEntry) {
    if (
      !diary ||
      !window.confirm(`Delete ${entryName(entry)} from ${mealLabel(entry.mealSlot)}?`)
    ) {
      return;
    }
    const key = `delete:${entry.id}:${diary.revision}`;
    setMutationBusy(entry.id);
    setMessage("Deleting the diary entry…");
    try {
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(entry.id)}?date=${encodeURIComponent(date)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            "idempotency-key": operationId(key),
            "if-match": quoteRevision(entry.revision),
          },
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const body = await json(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        await loadDiary(date);
        setMessage(
          "The diary changed elsewhere. Fresh values were loaded; delete again if needed.",
        );
        return;
      }
      if (!response.ok) throw new Error(responseError(body, "The entry could not be deleted."));
      parseDiaryMutation(body);
      operationIds.current.delete(key);
      await loadDiary(date);
      setMessage("Diary entry deleted and totals refreshed.");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "The entry could not be deleted."} Choose Delete again to retry safely.`,
      );
    } finally {
      setMutationBusy(null);
    }
  }

  async function signOut() {
    setMutationBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed) {
      setMessage("Sign out could not be confirmed. Your diary remains open; please retry.");
      setMutationBusy(null);
    }
  }

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link aria-current="page" href={`/dashboard?date=${date}`}>
            Diary
          </Link>
          <Link href={`/foods?date=${date}`}>Foods</Link>
          <Link href={`/recipes?date=${date}`}>Recipes</Link>
          <Link href={`/goals?date=${date}`}>Goals</Link>
          <span aria-disabled="true">Trends · soon</span>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={mutationBusy === "logout"}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
        <p className="wellnessNote">Wellness information only—not medical advice.</p>
      </aside>

      <section className="dashboard diaryDashboard" id="today">
        <header className="dashboardHeader diaryHeader">
          <div>
            <p className="kicker">Private local-day diary</p>
            <h1>
              {date ===
              (session
                ? localDateInTimeZone(new Date(), session.profile.timeZone)
                : currentLocalDate())
                ? "Today"
                : date}
            </h1>
          </div>
          <span className="statusPill">
            {diary?.timeZone ?? session?.profile.timeZone ?? "Local time"}
          </span>
        </header>

        <fieldset className="dateNavigator">
          <legend className="srOnly">Diary date</legend>
          <button
            onClick={() => chooseDate(shiftLocalDate(date, -1))}
            type="button"
            aria-label="Previous day"
          >
            ←
          </button>
          <label htmlFor="diary-date">Local date</label>
          <input
            id="diary-date"
            onChange={(event) => chooseDate(event.target.value)}
            type="date"
            value={date}
          />
          <button
            onClick={() => chooseDate(shiftLocalDate(date, 1))}
            type="button"
            aria-label="Next day"
          >
            →
          </button>
          <button
            onClick={() =>
              chooseDate(
                session
                  ? localDateInTimeZone(new Date(), session.profile.timeZone)
                  : currentLocalDate(),
              )
            }
            type="button"
          >
            Today
          </button>
        </fieldset>

        <p className={`diaryStatus diaryStatus--${state}`} role="status" aria-live="polite">
          {message}
        </p>
        {state === "error" ? (
          <button className="secondaryAction" onClick={() => void loadDiary(date)} type="button">
            Retry
          </button>
        ) : null}

        {diary && diary.entries.length === 0 && state === "ready" ? (
          <section className="emptyDiary" aria-labelledby="empty-diary-title">
            <div>
              <p className="kicker">Nothing logged</p>
              <h2 id="empty-diary-title">Start with a food you actually ate.</h2>
              <p>
                Choose a source-attributed food and its reviewed default serving. Unknown nutrients
                will remain unknown.
              </p>
            </div>
            <Link className="emptyDiaryAction" href={`/foods?date=${date}`}>
              Find a food
            </Link>
          </section>
        ) : null}

        {diary && diary.entries.length > 0 ? (
          <div className="diaryGrid">
            <div className="mealLedger">
              {mealSlots.map((meal) => {
                const entries = diary.entries.filter((entry) => entry.mealSlot === meal);
                return (
                  <section className="mealSection" key={meal} aria-labelledby={`meal-${meal}`}>
                    <div className="mealHeading">
                      <h2 id={`meal-${meal}`}>{mealLabel(meal)}</h2>
                      <Link href={`/foods?date=${date}&meal=${meal}`}>Add food</Link>
                    </div>
                    {entries.length === 0 ? (
                      <p className="emptyMeal">No entries</p>
                    ) : (
                      <ul>
                        {entries.map((entry) => (
                          <li key={entry.id}>
                            {editor?.entryId === entry.id ? (
                              <div className="entryEditor">
                                <label>
                                  Quantity
                                  <input
                                    inputMode="decimal"
                                    maxLength={18}
                                    onChange={(event) =>
                                      setEditor({ ...editor, quantity: event.target.value })
                                    }
                                    value={editor.quantity}
                                  />
                                </label>
                                <label>
                                  Meal
                                  <select
                                    onChange={(event) =>
                                      setEditor({
                                        ...editor,
                                        mealSlot: event.target.value as MealSlot,
                                      })
                                    }
                                    value={editor.mealSlot}
                                  >
                                    {mealSlots.map((slot) => (
                                      <option key={slot} value={slot}>
                                        {mealLabel(slot)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  Local date
                                  <input
                                    onChange={(event) =>
                                      setEditor({ ...editor, localDate: event.target.value })
                                    }
                                    type="date"
                                    value={editor.localDate}
                                  />
                                </label>
                                <label>
                                  Local time
                                  <input
                                    onChange={(event) =>
                                      setEditor({ ...editor, localTime: event.target.value })
                                    }
                                    type="time"
                                    value={editor.localTime}
                                  />
                                </label>
                                <small>
                                  Changed date and time are interpreted in {editor.timeZone}.
                                </small>
                                <div className="entryActions">
                                  <button
                                    disabled={
                                      mutationBusy === entry.id || diary.status === "locked"
                                    }
                                    onClick={() => void saveEntry()}
                                    type="button"
                                  >
                                    {mutationBusy === entry.id ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    disabled={mutationBusy === entry.id}
                                    onClick={() => setEditor(null)}
                                    type="button"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <article className="diaryEntry">
                                <div>
                                  <h3>{entryName(entry)}</h3>
                                  {entry.entryKind === "food" && entry.food.brandName ? (
                                    <p>{entry.food.brandName}</p>
                                  ) : null}
                                  {entry.entryKind === "recipe" ? (
                                    <p>Recipe version {entry.recipe.versionNumber}</p>
                                  ) : null}
                                  <small>
                                    {entry.portion.kind === "serving"
                                      ? `${entry.portion.amount} ${entry.portion.servingLabel}`
                                      : `${entry.portion.grams} g`}{" "}
                                    · {entry.localTime.slice(0, 5)} · {entryEnergyDisplay(entry)}
                                  </small>
                                  {entry.timeZone !== diary.timeZone ? (
                                    <small>Logged in {entry.timeZone}</small>
                                  ) : null}
                                  {entry.entryKind === "food" ? (
                                    <small>
                                      {entry.source.attributionRequired
                                        ? entry.source.attributionText
                                        : entry.source.displayName}{" "}
                                      · {entry.source.licenseExpression}
                                    </small>
                                  ) : (
                                    <div className="entryProvenance">
                                      <small>{entry.recipe.retentionPolicy.assumption}</small>
                                      {entry.recipe.warnings.map((warning) => (
                                        <small key={warning.code}>{warning.message}</small>
                                      ))}
                                      {entry.sources.map((source) => (
                                        <small key={`${source.code}:${source.releaseId}`}>
                                          {source.attributionRequired
                                            ? source.attributionText
                                            : source.displayName}{" "}
                                          · {source.licenseExpression}
                                        </small>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="entryActions">
                                  <button
                                    disabled={
                                      mutationBusy === entry.id || diary.status === "locked"
                                    }
                                    onClick={() => setEditor(editState(entry, diary.timeZone))}
                                    type="button"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="dangerAction"
                                    disabled={
                                      mutationBusy === entry.id || diary.status === "locked"
                                    }
                                    onClick={() => void deleteEntry(entry)}
                                    type="button"
                                  >
                                    {mutationBusy === entry.id ? "Working…" : "Delete"}
                                  </button>
                                </div>
                              </article>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>

            <aside className="nutritionSummary" aria-labelledby="nutrition-summary-title">
              <p className="kicker">Authoritative snapshot totals</p>
              <h2 id="nutrition-summary-title">Nutrition</h2>
              {diary.totals.length === 0 ? (
                <p>No nutrient totals are available yet.</p>
              ) : (
                <dl>
                  {diary.totals.map((nutrient) => {
                    const display = nutrientDisplay(nutrient);
                    return (
                      <div
                        key={nutrient.nutrientId}
                        className={`nutrientTotal nutrientTotal--${nutrient.completeness}`}
                      >
                        <dt>{nutrient.name}</dt>
                        <dd>
                          {display.amount}
                          <small>{display.qualification}</small>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
              <p className="totalsNote">
                Partial totals are lower bounds. Unknown values are never counted as zero.
              </p>
            </aside>
          </div>
        ) : null}

        {diary?.status === "locked" ? (
          <p className="lockedNotice">This day is locked and cannot be edited.</p>
        ) : null}
      </section>
    </>
  );
}
