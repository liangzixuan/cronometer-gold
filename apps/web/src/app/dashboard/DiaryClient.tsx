"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createOperationId,
  DIARY_PAGE_SIZE,
  type DiaryDay,
  type DiaryEditorOrigin,
  type DiaryEntry,
  type DiaryMutationResult,
  type DiaryPage,
  diaryEditErrorMessage,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryEntryNoteCharacterCount,
  diaryPagePath,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  isPositiveDecimal,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  mealLabel,
  mealSlots,
  mergeDiaryPages,
  nutrientDisplay,
  parseDiaryMutation,
  parseDiaryPage,
  parseSession,
  prepareDiaryEntryNotePatch,
  quoteRevision,
  resolveDiaryRouteDate,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";
type PageLoadState = "idle" | "loading" | "error";

interface EntryEditor extends DiaryEditorOrigin {
  readonly originalEntryLocalDate: string;
  readonly quantity: string;
  readonly note: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
  readonly originalLocalTime: string;
}

interface MutationOwner {
  readonly sourceDate: string;
  readonly token: number;
  readonly viewEpoch: number;
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

function editState(entry: DiaryEntry, day: DiaryDay): EntryEditor {
  const localTime = entry.localTime.slice(0, 5);
  return {
    ...diaryEditorOrigin(day, entry),
    originalEntryLocalDate: entry.localDate,
    quantity: entry.portion.kind === "serving" ? entry.portion.amount : entry.portion.grams,
    note: entry.note ?? "",
    mealSlot: entry.mealSlot,
    localDate: entry.localDate,
    localTime,
    originalLocalTime: localTime,
  };
}

function entryName(entry: DiaryEntry): string {
  return entry.entryKind === "food" ? entry.food.name : entry.recipe.name;
}

function loadedMessage(page: DiaryPage): string {
  const loaded = page.data.entries.length;
  const total = page.page.totalEntries;
  if (total === 0) return "No foods logged for this local day.";
  return `${loaded} of ${total} ${total === 1 ? "entry" : "entries"} loaded. Nutrition totals include all ${total}.`;
}

export function DiaryClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const explicitDate = searchParams.get("date");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState(() => resolveDiaryRouteDate(explicitDate, null) ?? "");
  const [diaryPage, setDiaryPage] = useState<DiaryPage | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [pageState, setPageState] = useState<PageLoadState>("idle");
  const [message, setMessage] = useState("Opening your private diary…");
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const operationIds = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const pageRequestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const viewEpoch = useRef(0);
  const mutationSequence = useRef(0);
  const activeMutation = useRef<number | null>(null);
  const privateUiGeneration = useRef(0);
  const privateUiClosed = useRef(false);
  const dateRef = useRef(date);
  dateRef.current = date;
  const diary = diaryPage?.data.localDate === date ? diaryPage.data : null;

  const signInAgain = useCallback(() => {
    privateUiClosed.current = true;
    privateUiGeneration.current += 1;
    requestGeneration.current += 1;
    viewEpoch.current += 1;
    mutationSequence.current += 1;
    activeMutation.current = null;
    loadController.current?.abort();
    pageRequestBusy.current = false;
    operationIds.current.clear();
    setDiaryPage(null);
    setEditor(null);
    setSession(null);
    setMutationBusy(null);
    setPageState("idle");
    setState("loading");
    setMessage("Closing your private diary…");
    setDate("");
    router.replace("/login");
    router.refresh();
  }, [router]);

  const transitionCommittedDate = useCallback(
    (next: string, rewriteUrl: boolean) => {
      if (privateUiClosed.current || !isLocalDate(next)) return;
      if (next === dateRef.current) {
        if (rewriteUrl) {
          router.replace(`/dashboard?date=${encodeURIComponent(next)}`, { scroll: false });
        }
        return;
      }
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      pageRequestBusy.current = false;
      setMutationBusy(null);
      setEditor(null);
      setDiaryPage(null);
      setPageState("idle");
      setDate(next);
      if (rewriteUrl) {
        router.replace(`/dashboard?date=${encodeURIComponent(next)}`, { scroll: false });
      }
    },
    [router],
  );

  const loadDiary = useCallback(
    async (requestedDate: string, refreshedAfterStalePage = false) => {
      if (
        privateUiClosed.current ||
        !isLocalDate(requestedDate) ||
        dateRef.current !== requestedDate
      ) {
        return false;
      }
      const generation = requestGeneration.current + 1;
      requestGeneration.current = generation;
      loadController.current?.abort();
      pageRequestBusy.current = false;
      const controller = new AbortController();
      loadController.current = controller;
      const isCurrent = () =>
        requestGeneration.current === generation &&
        loadController.current === controller &&
        !controller.signal.aborted &&
        dateRef.current === requestedDate;
      setEditor(null);
      setDiaryPage(null);
      setPageState("idle");
      setState("loading");
      setMessage(`Loading ${requestedDate}…`);
      try {
        const response = await fetch(diaryPagePath(requestedDate), {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!isCurrent()) return false;
        if (response.status === 401) {
          signInAgain();
          return false;
        }
        const body = await json(response);
        if (!isCurrent()) return false;
        if (!response.ok) throw new Error(responseError(body, "The diary could not be loaded."));
        const next = mergeDiaryPages(null, parseDiaryPage(body));
        if (!isCurrent()) return false;
        setDiaryPage(next);
        setState("ready");
        const nextMessage = refreshedAfterStalePage
          ? "The diary changed while more entries were loading. Page one was refreshed safely."
          : loadedMessage(next);
        setMessage(nextMessage);
        if (refreshedAfterStalePage) {
          requestAnimationFrame(() => {
            if (isCurrent()) statusRef.current?.focus();
          });
        }
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        setDiaryPage(null);
        setState("error");
        setMessage(error instanceof Error ? error.message : "The diary could not be loaded.");
        return false;
      }
    },
    [signInAgain],
  );

  useEffect(() => {
    const controller = new AbortController();
    const generation = privateUiGeneration.current;
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
        if (
          !controller.signal.aborted &&
          !privateUiClosed.current &&
          privateUiGeneration.current === generation
        ) {
          setSession(nextSession);
        }
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !privateUiClosed.current &&
          privateUiGeneration.current === generation
        ) {
          setState("error");
          setMessage(
            error instanceof Error ? error.message : "Your session could not be verified.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [signInAgain]);

  useEffect(() => {
    const routeDate = resolveDiaryRouteDate(explicitDate, session?.profile.timeZone ?? null);
    if (routeDate) transitionCommittedDate(routeDate, false);
  }, [explicitDate, session, transitionCommittedDate]);

  useEffect(() => {
    if (isLocalDate(date)) void loadDiary(date);
    return () => {
      requestGeneration.current += 1;
      loadController.current?.abort();
      pageRequestBusy.current = false;
    };
  }, [date, loadDiary]);

  useEffect(
    () => () => {
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
    },
    [],
  );

  function chooseDate(next: string) {
    transitionCommittedDate(next, true);
  }

  async function loadMore() {
    const current = diaryPage;
    const nextCursor = current?.page.nextCursor;
    if (
      !current ||
      current.data.localDate !== date ||
      nextCursor === null ||
      nextCursor === undefined ||
      pageRequestBusy.current
    ) {
      return;
    }
    const requestedDate = date;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    pageRequestBusy.current = true;
    const controller = new AbortController();
    loadController.current = controller;
    const isCurrent = () =>
      requestGeneration.current === generation &&
      loadController.current === controller &&
      !controller.signal.aborted &&
      dateRef.current === requestedDate;
    setPageState("loading");
    setMessage(`Loading more entries for ${requestedDate}…`);
    try {
      const response = await fetch(diaryPagePath(requestedDate, nextCursor), {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401) return signInAgain();
      const body = await json(response);
      if (!isCurrent()) return;
      if (isDiaryPageStaleProblem(response.status, body)) {
        setDiaryPage(null);
        setPageState("idle");
        await loadDiary(requestedDate, true);
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(body, "More diary entries could not be loaded."));
      }
      const merged = mergeDiaryPages(current, parseDiaryPage(body));
      if (!isCurrent()) return;
      setDiaryPage(merged);
      setPageState("idle");
      setMessage(loadedMessage(merged));
    } catch (error) {
      if (!isCurrent()) return;
      setPageState("error");
      setMessage(
        `${error instanceof Error ? error.message : "More diary entries could not be loaded."} Loaded entries remain available; choose Load more to retry.`,
      );
    } finally {
      if (requestGeneration.current === generation && loadController.current === controller) {
        pageRequestBusy.current = false;
      }
    }
  }

  function operationId(key: string): string {
    const existing = operationIds.current.get(key);
    if (existing) return existing;
    const created = createOperationId();
    operationIds.current.set(key, created);
    return created;
  }

  function beginMutation(sourceDate: string, busyKey: string): MutationOwner {
    const token = mutationSequence.current + 1;
    mutationSequence.current = token;
    activeMutation.current = token;
    setMutationBusy(busyKey);
    return { sourceDate, token, viewEpoch: viewEpoch.current };
  }

  function mutationIsCurrent(owner: MutationOwner): boolean {
    return (
      activeMutation.current === owner.token &&
      viewEpoch.current === owner.viewEpoch &&
      dateRef.current === owner.sourceDate &&
      !privateUiClosed.current
    );
  }

  function finishMutation(owner: MutationOwner): void {
    if (activeMutation.current !== owner.token) return;
    activeMutation.current = null;
    setMutationBusy(null);
  }

  async function reportMutationReceipt(
    owner: MutationOwner,
    mutation: DiaryMutationResult,
    successMessage: string,
    reloadFailureMessage: string,
  ): Promise<void> {
    if (!mutationIsCurrent(owner)) return;
    if (!mutation.affectedDays.some((day) => day.localDate === owner.sourceDate)) {
      setMessage(successMessage);
      return;
    }
    const reloaded = await loadDiary(owner.sourceDate);
    if (!mutationIsCurrent(owner)) return;
    setMessage(reloaded ? successMessage : reloadFailureMessage);
  }

  async function saveEntry() {
    if (!editor || !diary) return;
    const entry = diary.entries.find((candidate) => candidate.id === editor.entryId);
    if (!entry) {
      setEditor(null);
      setMessage("That entry is no longer present. Fresh diary data is required.");
      return;
    }
    if (!diaryEditorOriginMatches(editor, diary, entry)) {
      setEditor(null);
      setMessage(
        "The diary changed after editing began. Review the fresh entry before editing again.",
      );
      return;
    }
    if (!isPositiveDecimal(editor.quantity)) {
      setMessage("Quantity must be a positive decimal number.");
      return;
    }
    let notePatch: { readonly note?: string | null };
    try {
      notePatch = prepareDiaryEntryNotePatch(editor.note, entry.note);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The private note could not be validated.",
      );
      return;
    }
    const owner = beginMutation(editor.originLocalDate, editor.entryId);
    setMessage("Saving the diary entry…");
    try {
      const timestampChanged =
        editor.localDate !== editor.originalEntryLocalDate ||
        editor.localTime !== editor.originalLocalTime;
      const body = {
        portion:
          entry.portion.kind === "serving"
            ? entry.entryKind === "food"
              ? { kind: "serving", servingId: entry.portion.servingId, amount: editor.quantity }
              : { kind: "serving", amount: editor.quantity }
            : { kind: "grams", grams: editor.quantity },
        mealSlot: editor.mealSlot,
        ...notePatch,
        ...(timestampChanged
          ? {
              occurredAt: localDateTimeToInstant(
                editor.localDate,
                editor.localTime,
                editor.originTimeZone,
              ),
            }
          : {}),
      };
      const key = diaryEditorOperationKey(editor, body);
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(editor.entryId)}?date=${encodeURIComponent(editor.originLocalDate)}`,
        {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": operationId(key),
            "if-match": quoteRevision(editor.originEntryRevision),
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        setEditor(null);
        const reloaded = await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The diary changed elsewhere. Fresh values were loaded; review your edit again."
              : "The diary changed elsewhere, but fresh data could not be confirmed. Choose Retry.",
          );
        }
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The entry could not be saved."));
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      if (!mutationIsCurrent(owner)) return;
      setEditor(null);
      await reportMutationReceipt(
        owner,
        mutation,
        "Diary entry saved with fresh totals.",
        "The entry was saved, but fresh diary data could not be confirmed. Choose Retry.",
      );
    } catch (error) {
      if (mutationIsCurrent(owner)) setMessage(diaryEditErrorMessage(error));
    } finally {
      finishMutation(owner);
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
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage("Deleting the diary entry…");
    try {
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(entry.id)}?date=${encodeURIComponent(owner.sourceDate)}`,
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
        if (!mutationIsCurrent(owner)) return;
        const reloaded = await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The diary changed elsewhere. Fresh values were loaded; delete again if needed."
              : "The diary changed elsewhere, but fresh data could not be confirmed. Choose Retry.",
          );
        }
        return;
      }
      if (!response.ok) throw new Error(responseError(body, "The entry could not be deleted."));
      const mutation = parseDiaryMutation(body);
      operationIds.current.delete(key);
      await reportMutationReceipt(
        owner,
        mutation,
        "Diary entry deleted and totals refreshed.",
        "The entry was deleted, but fresh diary data could not be confirmed. Choose Retry.",
      );
    } catch (error) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${error instanceof Error ? error.message : "The entry could not be deleted."} Choose Delete again to retry safely.`,
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function repeatEntry(entry: DiaryEntry) {
    if (!session || !diary) {
      setMessage("Your profile time zone is required before repeating an entry.");
      return;
    }
    const now = new Date();
    const targetDate = localDateInTimeZone(now, session.profile.timeZone);
    const targetTime = localTimeInTimeZone(now, session.profile.timeZone).slice(0, 5);
    const body = {
      occurredAt: localDateTimeToInstant(targetDate, targetTime, session.profile.timeZone),
      mealSlot: entry.mealSlot,
    };
    const key = `repeat:${entry.id}:${entry.revision}:${JSON.stringify(body)}`;
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Repeating the pinned ${entryName(entry)} version…`);
    try {
      const response = await fetch(`/api/diary/entries/${encodeURIComponent(entry.id)}/repeat`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operationId(key),
          "if-match": quoteRevision(entry.revision),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const reloaded = await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The source entry changed. Fresh details were loaded; review before repeating."
              : "The source entry changed, but fresh data could not be confirmed. Choose Retry.",
          );
        }
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(responseBody, "The entry could not be repeated."));
      }
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      const repeatedDate = mutation.entry?.localDate ?? targetDate;
      await reportMutationReceipt(
        owner,
        mutation,
        repeatedDate === owner.sourceDate
          ? "Pinned entry version repeated with fresh authoritative totals."
          : `Pinned entry version repeated for ${repeatedDate}.`,
        "The entry was repeated, but fresh diary data could not be confirmed. Choose Retry.",
      );
    } catch (error) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${error instanceof Error ? error.message : "The entry could not be repeated."} Choose Repeat again to retry the same operation safely.`,
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function signOut() {
    const token = mutationSequence.current + 1;
    mutationSequence.current = token;
    activeMutation.current = token;
    setMutationBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed && activeMutation.current === token && !privateUiClosed.current) {
      activeMutation.current = null;
      setMessage("Sign out could not be confirmed. Your diary remains open; please retry.");
      setMutationBusy(null);
    }
  }

  const hasCommittedDate = isLocalDate(date);
  const dateQuery = hasCommittedDate ? `?date=${encodeURIComponent(date)}` : "";

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link aria-current="page" href={`/dashboard${dateQuery}`}>
            Diary
          </Link>
          <Link href={`/foods${dateQuery}`}>Foods</Link>
          <Link href={`/recipes${dateQuery}`}>Recipes</Link>
          <Link href={`/goals${dateQuery}`}>Goals</Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={mutationBusy !== null}
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
              {!hasCommittedDate
                ? "Opening diary…"
                : session && date === localDateInTimeZone(new Date(), session.profile.timeZone)
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
            disabled={!hasCommittedDate || mutationBusy !== null}
            onClick={() => {
              if (hasCommittedDate) chooseDate(shiftLocalDate(date, -1));
            }}
            type="button"
            aria-label="Previous day"
          >
            ←
          </button>
          <label htmlFor="diary-date">Local date</label>
          <input
            disabled={!hasCommittedDate || mutationBusy !== null}
            id="diary-date"
            onChange={(event) => chooseDate(event.target.value)}
            type="date"
            value={date}
          />
          <button
            disabled={!hasCommittedDate || mutationBusy !== null}
            onClick={() => {
              if (hasCommittedDate) chooseDate(shiftLocalDate(date, 1));
            }}
            type="button"
            aria-label="Next day"
          >
            →
          </button>
          <button
            disabled={!session || mutationBusy !== null}
            onClick={() => {
              if (session) {
                chooseDate(localDateInTimeZone(new Date(), session.profile.timeZone));
              }
            }}
            type="button"
          >
            Today
          </button>
        </fieldset>

        <p
          className={`diaryStatus diaryStatus--${pageState === "error" ? "error" : state}`}
          role="status"
          aria-live="polite"
          ref={statusRef}
          tabIndex={-1}
        >
          {message}
        </p>
        {state === "error" ? (
          <button
            className="secondaryAction"
            disabled={!hasCommittedDate || mutationBusy !== null}
            onClick={() => void loadDiary(date)}
            type="button"
          >
            Retry
          </button>
        ) : null}

        {diary && diaryPage && state === "ready" ? (
          <p className="diaryPageCount" id="diary-page-count">
            {diary.entries.length} of {diaryPage.page.totalEntries} entries loaded. Nutrition totals
            include all {diaryPage.page.totalEntries}.
          </p>
        ) : null}

        {diary && diaryPage?.page.totalEntries === 0 && state === "ready" ? (
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
            <div
              aria-busy={pageState === "loading"}
              aria-describedby="diary-page-count"
              className="mealLedger"
              id="diary-entry-groups"
            >
              {mealSlots.map((meal) => {
                const entries = diary.entries.filter((entry) => entry.mealSlot === meal);
                return (
                  <section className="mealSection" key={meal} aria-labelledby={`meal-${meal}`}>
                    <div className="mealHeading">
                      <h2 id={`meal-${meal}`}>{mealLabel(meal)}</h2>
                      <Link href={`/foods?date=${date}&meal=${meal}`}>Add food</Link>
                    </div>
                    {entries.length === 0 ? (
                      <p className="emptyMeal">
                        {diaryPage?.page.nextCursor
                          ? "No entries loaded for this meal yet"
                          : "No entries"}
                      </p>
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
                                <label
                                  className="entryNoteField"
                                  htmlFor={`entry-note-${entry.id}`}
                                >
                                  Private note
                                  <textarea
                                    aria-describedby={`entry-note-help-${entry.id}`}
                                    id={`entry-note-${entry.id}`}
                                    maxLength={4_000}
                                    onChange={(event) =>
                                      setEditor({ ...editor, note: event.target.value })
                                    }
                                    rows={4}
                                    value={editor.note}
                                  />
                                </label>
                                <small className="entryNoteHint" id={`entry-note-help-${entry.id}`}>
                                  Clear the field and save to remove this note from the current
                                  display only. Immutable prior revisions remain in your private
                                  account export until whole-account erasure. Character count:{" "}
                                  {diaryEntryNoteCharacterCount(editor.note)}
                                  of 2,000.
                                </small>
                                <small className="entryTimeHint">
                                  Changed date and time are interpreted in {editor.originTimeZone}.
                                </small>
                                <div className="entryActions">
                                  <button
                                    aria-label={`Clear note field for ${entryName(entry)}`}
                                    disabled={mutationBusy !== null || editor.note.length === 0}
                                    onClick={() => setEditor({ ...editor, note: "" })}
                                    type="button"
                                  >
                                    Clear field
                                  </button>
                                  <button
                                    aria-label={`Save changes to ${entryName(entry)}`}
                                    disabled={mutationBusy !== null || diary.status === "locked"}
                                    onClick={() => void saveEntry()}
                                    type="button"
                                  >
                                    {mutationBusy === entry.id ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    aria-label={`Cancel editing ${entryName(entry)}`}
                                    disabled={mutationBusy !== null}
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
                                  {entry.note !== null ? (
                                    <div className="entryNote">
                                      <small>Private note</small>
                                      <p>{entry.note}</p>
                                    </div>
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
                                      {entry.foodProvenance.kind === "private_custom"
                                        ? `Owner-entered private food · pinned version ${entry.foodProvenance.customFoodVersionNumber}`
                                        : `${entry.foodProvenance.source.attributionRequired ? entry.foodProvenance.source.attributionText : entry.foodProvenance.source.displayName} · ${entry.foodProvenance.source.licenseExpression}`}
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
                                    aria-label={`Edit ${entryName(entry)}`}
                                    disabled={mutationBusy !== null || diary.status === "locked"}
                                    onClick={() => setEditor(editState(entry, diary))}
                                    type="button"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    aria-label={`Repeat ${entryName(entry)} today`}
                                    disabled={mutationBusy !== null}
                                    onClick={() => void repeatEntry(entry)}
                                    type="button"
                                  >
                                    {mutationBusy === entry.id ? "Working…" : "Repeat today"}
                                  </button>
                                  <button
                                    aria-label={`Delete ${entryName(entry)}`}
                                    className="dangerAction"
                                    disabled={mutationBusy !== null || diary.status === "locked"}
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
                These totals cover all {diaryPage?.page.totalEntries ?? diary.entries.length} diary
                entries, including entries not loaded yet. Partial nutrient totals are lower bounds.
                Unknown values are never counted as zero.
              </p>
            </aside>

            {diaryPage && diaryPage.page.totalEntries > DIARY_PAGE_SIZE ? (
              <div className="diaryLoadMore">
                <button
                  aria-controls="diary-entry-groups"
                  aria-describedby="diary-page-count"
                  aria-disabled={
                    diaryPage.page.nextCursor === null ||
                    pageState === "loading" ||
                    mutationBusy !== null
                  }
                  className="secondaryAction"
                  disabled={pageState === "loading" || mutationBusy !== null}
                  onClick={() => void loadMore()}
                  type="button"
                >
                  {pageState === "loading"
                    ? "Loading more…"
                    : pageState === "error"
                      ? "Retry load more"
                      : diaryPage.page.nextCursor === null
                        ? "All entries loaded"
                        : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {diary?.status === "locked" ? (
          <p className="lockedNotice">This day is locked and cannot be edited.</p>
        ) : null}
      </section>
    </>
  );
}
