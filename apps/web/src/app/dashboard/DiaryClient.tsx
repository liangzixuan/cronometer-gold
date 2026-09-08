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
  type DiaryGroup,
  type DiaryMutationResult,
  type DiaryPage,
  defaultDiaryGroups,
  diaryCorrectionMatchesRequest,
  diaryEditErrorMessage,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryEntryNoteCharacterCount,
  diaryGroupLabel,
  diaryPagePath,
  diaryRepeatOperationKey,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  isPositiveDecimal,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  mealLabel,
  mergeDiaryPages,
  moveDiaryGroup,
  nutrientDisplay,
  parseDiaryCorrectionMutation,
  parseDiaryDayReorder,
  parseDiaryPage,
  parseProfileResponse,
  parseSession,
  prepareDiaryDayReorderOperation,
  prepareDiaryEntryNotePatch,
  prepareDiaryGroups,
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

function responseCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function editState(entry: DiaryEntry, day: DiaryDay, currentProfileTimeZone: string): EntryEditor {
  const occurredAt = new Date(entry.occurredAt);
  const localDate = localDateInTimeZone(occurredAt, currentProfileTimeZone);
  const localTime = localTimeInTimeZone(occurredAt, currentProfileTimeZone).slice(0, 5);
  return {
    ...diaryEditorOrigin(day, entry, currentProfileTimeZone),
    originalEntryLocalDate: localDate,
    quantity: entry.portion.kind === "serving" ? entry.portion.amount : entry.portion.grams,
    note: entry.note ?? "",
    mealSlot: entry.mealSlot,
    localDate,
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
  const [diaryGroupDraft, setDiaryGroupDraft] = useState<readonly DiaryGroup[]>(defaultDiaryGroups);
  const [diaryGroupSettingsOpen, setDiaryGroupSettingsOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const operationIds = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const profileController = useRef<AbortController | null>(null);
  const timeZoneRefreshController = useRef<AbortController | null>(null);
  const pageRequestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const viewEpoch = useRef(0);
  const mutationSequence = useRef(0);
  const activeMutation = useRef<number | null>(null);
  const privateUiGeneration = useRef(0);
  const privateUiClosed = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const dateRef = useRef(date);
  dateRef.current = date;
  const diaryPageRef = useRef(diaryPage);
  diaryPageRef.current = diaryPage;
  const diary = diaryPage?.data.localDate === date ? diaryPage.data : null;
  const diaryGroups = session?.profile.diaryGroups ?? defaultDiaryGroups;

  const signInAgain = useCallback(() => {
    privateUiClosed.current = true;
    privateUiGeneration.current += 1;
    requestGeneration.current += 1;
    viewEpoch.current += 1;
    mutationSequence.current += 1;
    activeMutation.current = null;
    loadController.current?.abort();
    profileController.current?.abort();
    profileController.current = null;
    timeZoneRefreshController.current?.abort();
    timeZoneRefreshController.current = null;
    pageRequestBusy.current = false;
    operationIds.current.clear();
    setDiaryPage(null);
    setEditor(null);
    setSession(null);
    setMutationBusy(null);
    setProfileBusy(false);
    setDiaryGroupSettingsOpen(false);
    setDiaryGroupDraft(defaultDiaryGroups);
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
          setDiaryGroupDraft(nextSession.profile.diaryGroups);
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
      privateUiGeneration.current += 1;
      profileController.current?.abort();
      profileController.current = null;
      timeZoneRefreshController.current?.abort();
      timeZoneRefreshController.current = null;
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

  async function refreshProfileAfterTimeZoneChange(owner: MutationOwner): Promise<string | null> {
    timeZoneRefreshController.current?.abort();
    const controller = new AbortController();
    timeZoneRefreshController.current = controller;
    const originalUserId = sessionRef.current?.user.id ?? null;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        signInAgain();
        return null;
      }
      const body = await json(response);
      if (!response.ok) return null;
      const nextSession = parseSession(body);
      if (
        controller.signal.aborted ||
        !mutationIsCurrent(owner) ||
        (originalUserId !== null && nextSession.user.id !== originalUserId)
      ) {
        if (originalUserId !== null && nextSession.user.id !== originalUserId) signInAgain();
        return null;
      }
      setSession(nextSession);
      setDiaryGroupDraft(nextSession.profile.diaryGroups);
      return nextSession.profile.timeZone;
    } catch {
      return null;
    } finally {
      if (timeZoneRefreshController.current === controller) {
        timeZoneRefreshController.current = null;
      }
    }
  }

  async function saveEntry() {
    if (!editor || !diary) return;
    const entry = diary.entries.find((candidate) => candidate.id === editor.entryId);
    if (!entry) {
      setEditor(null);
      setMessage("That entry is no longer present. Fresh diary data is required.");
      return;
    }
    if (!diaryEditorOriginMatches(editor, diary, entry, session?.profile.timeZone ?? null)) {
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
      const requestOperationId = operationId(key);
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(editor.entryId)}?date=${encodeURIComponent(editor.originLocalDate)}${timestampChanged ? "&profileTimeZonePrecondition=v1" : ""}`,
        {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": requestOperationId,
            "if-match": quoteRevision(editor.originEntryRevision),
            ...(timestampChanged ? { "x-expected-profile-time-zone": editor.originTimeZone } : {}),
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (
        timestampChanged &&
        response.status === 409 &&
        responseCode(responseBody) === "DIARY_TIME_ZONE_CHANGED"
      ) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        setEditor(null);
        const currentTimeZone = await refreshProfileAfterTimeZoneChange(owner);
        if (!mutationIsCurrent(owner)) return;
        await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            `Your profile time zone changed${currentTimeZone ? ` to ${currentTimeZone}` : ""}. No edit was made; review the local date and time before saving again.`,
          );
        }
        return;
      }
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
      const mutation = parseDiaryCorrectionMutation(responseBody);
      if (
        !diaryCorrectionMatchesRequest(mutation, {
          body,
          entryId: editor.entryId,
          entryRevision: editor.originEntryRevision,
          expectedTimeZone: timestampChanged ? editor.originTimeZone : null,
          kind: "update",
          operationId: requestOperationId,
          sourceLocalDate: editor.originLocalDate,
        })
      ) {
        throw new TypeError("The server returned a correction receipt for a different edit.");
      }
      operationIds.current.delete(key);
      if (!mutationIsCurrent(owner)) return;
      setEditor(null);
      await reportMutationReceipt(
        owner,
        mutation,
        `Diary entry saved in ${diaryGroupLabel(diaryGroups, editor.mealSlot)} with fresh totals.`,
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
      !window.confirm(
        `Delete ${entryName(entry)} from ${diaryGroupLabel(diaryGroups, entry.mealSlot)}?`,
      )
    ) {
      return;
    }
    const key = `delete:${entry.id}:${diary.revision}`;
    const requestOperationId = operationId(key);
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage("Deleting the diary entry…");
    try {
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(entry.id)}?date=${encodeURIComponent(owner.sourceDate)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            "idempotency-key": requestOperationId,
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
      const mutation = parseDiaryCorrectionMutation(body);
      if (
        !diaryCorrectionMatchesRequest(mutation, {
          body: null,
          entryId: entry.id,
          entryRevision: entry.revision,
          expectedTimeZone: null,
          kind: "delete",
          operationId: requestOperationId,
          sourceLocalDate: owner.sourceDate,
        })
      ) {
        throw new TypeError("The server returned a correction receipt for a different deletion.");
      }
      operationIds.current.delete(key);
      await reportMutationReceipt(
        owner,
        mutation,
        `${entryName(entry)} deleted from ${diaryGroupLabel(diaryGroups, entry.mealSlot)} and totals refreshed.`,
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
    const key = diaryRepeatOperationKey(entry.id, entry.revision, session.profile.timeZone, body);
    const requestOperationId = operationId(key);
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Repeating the pinned ${entryName(entry)} version…`);
    try {
      const response = await fetch(
        `/api/diary/entries/${encodeURIComponent(entry.id)}/repeat?date=${encodeURIComponent(owner.sourceDate)}&profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": requestOperationId,
            "if-match": quoteRevision(entry.revision),
            "x-expected-profile-time-zone": session.profile.timeZone,
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 409 && responseCode(responseBody) === "DIARY_TIME_ZONE_CHANGED") {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const currentTimeZone = await refreshProfileAfterTimeZoneChange(owner);
        if (!mutationIsCurrent(owner)) return;
        await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            `Your profile time zone changed${currentTimeZone ? ` to ${currentTimeZone}` : ""}. Nothing was repeated; review the destination day before trying again.`,
          );
        }
        return;
      }
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
      const mutation = parseDiaryCorrectionMutation(responseBody);
      if (
        !diaryCorrectionMatchesRequest(mutation, {
          body,
          entryId: entry.id,
          entryRevision: entry.revision,
          expectedTimeZone: session.profile.timeZone,
          kind: "repeat",
          operationId: requestOperationId,
          sourceLocalDate: owner.sourceDate,
        })
      ) {
        throw new TypeError("The server returned a correction receipt for a different repeat.");
      }
      operationIds.current.delete(key);
      const repeatedDate = mutation.entry?.localDate ?? targetDate;
      await reportMutationReceipt(
        owner,
        mutation,
        repeatedDate === owner.sourceDate
          ? `Pinned entry version repeated in ${diaryGroupLabel(diaryGroups, entry.mealSlot)} with fresh authoritative totals.`
          : `Pinned entry version repeated in ${diaryGroupLabel(diaryGroups, entry.mealSlot)} for ${repeatedDate}.`,
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

  async function reorderEntry(entry: DiaryEntry, direction: "down" | "up") {
    const sourcePage = diaryPage;
    if (!sourcePage || sourcePage.data.localDate !== date || !diary || !session) {
      setMessage("Your current profile time zone is required before changing diary order.");
      return;
    }
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Moving ${entryName(entry)} ${direction}…`);
    try {
      const operation = await prepareDiaryDayReorderOperation(
        sourcePage,
        session.profile.timeZone,
        entry.id,
        direction,
      );
      if (!mutationIsCurrent(owner) || diaryPageRef.current !== sourcePage) {
        setMessage("The diary changed while the order was being prepared. Review the fresh day.");
        return;
      }
      const key = `reorder:${owner.sourceDate}:${operation.expectedDayRevision}:${operation.expectedProfileTimeZone}:${operation.expectedOrderDigest}:${operation.expectedResultOrderDigest}`;
      const requestOperationId = operationId(key);
      const response = await fetch(
        `/api/diary/days/${encodeURIComponent(owner.sourceDate)}/order?profileTimeZonePrecondition=v1`,
        {
          method: "PUT",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": requestOperationId,
            "if-match": quoteRevision(operation.expectedDayRevision),
            "x-expected-diary-order-digest": operation.expectedOrderDigest,
            "x-expected-profile-time-zone": operation.expectedProfileTimeZone,
          },
          body: JSON.stringify(operation.body),
          cache: "no-store",
        },
      );
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const reloaded = await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The diary order changed elsewhere. The complete day was refreshed; move it again if needed."
              : "The diary order changed elsewhere, but fresh data could not be confirmed. Choose Retry.",
          );
        }
        return;
      }
      if (response.status === 409 && responseCode(responseBody) === "DIARY_TIME_ZONE_CHANGED") {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const currentTimeZone = await refreshProfileAfterTimeZoneChange(owner);
        if (!mutationIsCurrent(owner)) return;
        await loadDiary(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            `Your profile time zone changed${currentTimeZone ? ` to ${currentTimeZone}` : ""}. The order was not changed; review this day before trying again.`,
          );
        }
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(responseBody, "The diary order could not be saved."));
      }
      const result = parseDiaryDayReorder(responseBody);
      if (
        result.receipt.operationId !== requestOperationId ||
        result.receipt.localDate !== owner.sourceDate ||
        result.receipt.timeZone !== operation.dayTimeZone ||
        result.receipt.expectedDayRevision !== operation.expectedDayRevision ||
        result.receipt.previousOrderDigest !== operation.expectedOrderDigest ||
        result.receipt.orderDigest !== operation.expectedResultOrderDigest
      ) {
        throw new TypeError("The server returned a receipt for a different diary order.");
      }
      operationIds.current.delete(key);
      const reloaded = await loadDiary(owner.sourceDate);
      if (mutationIsCurrent(owner)) {
        setMessage(
          reloaded
            ? `${entryName(entry)} moved ${direction}; the complete authoritative day was refreshed.`
            : "The order was saved, but fresh diary data could not be confirmed. Choose Retry.",
        );
      }
    } catch (error) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${error instanceof Error ? error.message : "The diary order could not be saved."} Choose Move again to retry safely.`,
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function saveDiaryGroups() {
    if (!session || profileBusy || profileController.current || privateUiClosed.current) return;
    const initiatingOwnerUserId = session.user.id;
    const generation = privateUiGeneration.current;
    let prepared: readonly DiaryGroup[];
    try {
      prepared = prepareDiaryGroups(diaryGroupDraft);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The diary group labels could not be validated.",
      );
      return;
    }
    const controller = new AbortController();
    profileController.current = controller;
    const requestOwnsUi = () =>
      profileController.current === controller &&
      !controller.signal.aborted &&
      !privateUiClosed.current &&
      privateUiGeneration.current === generation &&
      sessionRef.current?.user.id === initiatingOwnerUserId;
    setProfileBusy(true);
    setMessage("Saving your diary group names and order…");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "if-match": quoteRevision(session.profile.revision),
        },
        body: JSON.stringify({ expectedOwnerUserId: initiatingOwnerUserId, diaryGroups: prepared }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!requestOwnsUi()) return;
      if (response.status === 401) return signInAgain();
      const body = await json(response);
      if (!requestOwnsUi()) return;
      if (response.status === 409 && responseCode(body) === "PROFILE_OWNER_CHANGED") {
        return signInAgain();
      }
      if (response.status === 412) {
        const freshResponse = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!requestOwnsUi()) return;
        if (freshResponse.status === 401) return signInAgain();
        const freshBody = await json(freshResponse);
        if (!requestOwnsUi()) return;
        if (!freshResponse.ok) {
          throw new Error(
            "Your profile changed elsewhere, but fresh settings could not be loaded.",
          );
        }
        const freshSession = parseSession(freshBody);
        if (freshSession.user.id !== initiatingOwnerUserId) return signInAgain();
        if (!requestOwnsUi()) return;
        setSession((current) =>
          current?.user.id === initiatingOwnerUserId ? freshSession : current,
        );
        setDiaryGroupDraft(freshSession.profile.diaryGroups);
        setMessage("Your profile changed elsewhere. Fresh diary group settings were loaded.");
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(body, "The diary groups could not be saved."));
      }
      const profile = parseProfileResponse(body);
      if (!requestOwnsUi()) return;
      setSession((current) =>
        current?.user.id === initiatingOwnerUserId ? { ...current, profile } : current,
      );
      setDiaryGroupDraft(profile.diaryGroups);
      setDiaryGroupSettingsOpen(false);
      setMessage("Diary group names and order saved everywhere you log food.");
    } catch (error) {
      if (!requestOwnsUi()) return;
      setMessage(error instanceof Error ? error.message : "The diary groups could not be saved.");
    } finally {
      if (profileController.current === controller) {
        profileController.current = null;
        if (
          !privateUiClosed.current &&
          privateUiGeneration.current === generation &&
          sessionRef.current?.user.id === initiatingOwnerUserId
        ) {
          setProfileBusy(false);
        }
      }
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
  const diaryGroupsChanged = session
    ? diaryGroupDraft.some((group, index) => {
        const saved = session.profile.diaryGroups[index];
        return !saved || group.mealSlot !== saved.mealSlot || group.label !== saved.label;
      })
    : false;
  const controlsBusy = mutationBusy !== null || profileBusy;
  const completeDayLoaded =
    diaryPage !== null &&
    diaryPage.data.localDate === date &&
    diaryPage.page.nextCursor === null &&
    diaryPage.data.entries.length === diaryPage.page.totalEntries;

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
          <Link href={`/hydration${dateQuery}`}>Hydration</Link>
          <Link href={hasCommittedDate ? `/reports?to=${encodeURIComponent(date)}` : "/reports"}>
            Reports
          </Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        {session && !session.user.emailVerified ? (
          <Link className="verificationLink" href="/verify-email">
            Verify email
          </Link>
        ) : null}
        <button
          className="signOutButton"
          disabled={controlsBusy}
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
            {session?.profile.timeZone ?? diary?.timeZone ?? "Local time"}
          </span>
        </header>

        <fieldset className="dateNavigator">
          <legend className="srOnly">Diary date</legend>
          <button
            disabled={!hasCommittedDate || controlsBusy}
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
            disabled={!hasCommittedDate || controlsBusy}
            id="diary-date"
            onChange={(event) => chooseDate(event.target.value)}
            type="date"
            value={date}
          />
          <button
            disabled={!hasCommittedDate || controlsBusy}
            onClick={() => {
              if (hasCommittedDate) chooseDate(shiftLocalDate(date, 1));
            }}
            type="button"
            aria-label="Next day"
          >
            →
          </button>
          <button
            disabled={!session || controlsBusy}
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

        <div className="diaryGroupSettingsLauncher">
          <button
            aria-controls="diary-group-settings"
            aria-expanded={diaryGroupSettingsOpen}
            className="secondaryAction"
            disabled={!session || controlsBusy}
            onClick={() => {
              const opening = !diaryGroupSettingsOpen;
              if (opening && session) setDiaryGroupDraft(session.profile.diaryGroups);
              setDiaryGroupSettingsOpen(opening);
            }}
            type="button"
          >
            {diaryGroupSettingsOpen ? "Close diary group settings" : "Customize diary groups"}
          </button>
        </div>

        {diaryGroupSettingsOpen && session ? (
          <section
            aria-labelledby="diary-group-settings-title"
            className="diaryGroupSettings"
            id="diary-group-settings"
          >
            <div>
              <p className="kicker">Your diary layout</p>
              <h2 id="diary-group-settings-title">Name and order meal groups</h2>
              <p>
                Labels and order change everywhere you choose a diary destination. Existing entries
                keep their stable saved destination.
              </p>
            </div>
            <form
              aria-busy={profileBusy}
              onSubmit={(event) => {
                event.preventDefault();
                void saveDiaryGroups();
              }}
            >
              <ol className="diaryGroupList">
                {diaryGroupDraft.map((group, index) => (
                  <li key={group.mealSlot}>
                    <label htmlFor={`diary-group-${group.mealSlot}`}>
                      Group {index + 1} label
                      <input
                        disabled={profileBusy}
                        id={`diary-group-${group.mealSlot}`}
                        maxLength={120}
                        onChange={(event) =>
                          setDiaryGroupDraft((current) =>
                            current.map((candidate) =>
                              candidate.mealSlot === group.mealSlot
                                ? { ...candidate, label: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                        value={group.label}
                      />
                    </label>
                    <small>Stable destination: {mealLabel(group.mealSlot)}</small>
                    <div className="entryActions">
                      <button
                        aria-label={`Move group ${index + 1} up`}
                        disabled={profileBusy || index === 0}
                        onClick={() =>
                          setDiaryGroupDraft((current) => moveDiaryGroup(current, index, -1))
                        }
                        type="button"
                      >
                        Move up
                      </button>
                      <button
                        aria-label={`Move group ${index + 1} down`}
                        disabled={profileBusy || index === diaryGroupDraft.length - 1}
                        onClick={() =>
                          setDiaryGroupDraft((current) => moveDiaryGroup(current, index, 1))
                        }
                        type="button"
                      >
                        Move down
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="fieldHelp">
                Use four unique labels, each 1–40 characters. Reset prepares Breakfast, Lunch,
                Dinner, and Snacks; nothing changes until you save.
              </p>
              <div className="entryActions">
                <button
                  disabled={profileBusy}
                  onClick={() => {
                    setDiaryGroupDraft(defaultDiaryGroups);
                    setMessage(
                      "Default diary group names and order prepared. Choose Save groups to apply them.",
                    );
                  }}
                  type="button"
                >
                  Reset defaults
                </button>
                <button
                  disabled={profileBusy}
                  onClick={() => {
                    setDiaryGroupDraft(session.profile.diaryGroups);
                    setDiaryGroupSettingsOpen(false);
                  }}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="buttonPrimary"
                  disabled={profileBusy || mutationBusy !== null || !diaryGroupsChanged}
                  type="submit"
                >
                  {profileBusy ? "Saving…" : "Save groups"}
                </button>
              </div>
            </form>
          </section>
        ) : null}

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
          <>
            <p className="diaryPageCount" id="diary-page-count">
              {diary.entries.length} of {diaryPage.page.totalEntries} entries loaded. Nutrition
              totals include all {diaryPage.page.totalEntries}.
            </p>
            {!completeDayLoaded ? (
              <p className="fieldHelp">Load the complete day before changing entry order.</p>
            ) : null}
          </>
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
            <Link
              className="emptyDiaryAction"
              href={`/foods?date=${date}&meal=${diaryGroups[0]?.mealSlot ?? "breakfast"}`}
            >
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
              {diaryGroups.map((group) => {
                const entries = diary.entries.filter((entry) => entry.mealSlot === group.mealSlot);
                return (
                  <section
                    className="mealSection"
                    key={group.mealSlot}
                    aria-labelledby={`meal-${group.mealSlot}`}
                  >
                    <div className="mealHeading">
                      <h2 id={`meal-${group.mealSlot}`}>{group.label}</h2>
                      <Link href={`/foods?date=${date}&meal=${group.mealSlot}`}>Add food</Link>
                    </div>
                    {entries.length === 0 ? (
                      <p className="emptyMeal">
                        {diaryPage?.page.nextCursor
                          ? "No entries loaded for this meal yet"
                          : "No entries"}
                      </p>
                    ) : (
                      <ul>
                        {entries.map((entry, entryIndex) => (
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
                                    {diaryGroups.map((groupOption) => (
                                      <option
                                        key={groupOption.mealSlot}
                                        value={groupOption.mealSlot}
                                      >
                                        {groupOption.label}
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
                                    aria-label={`Move ${entryName(entry)} up within ${group.label}`}
                                    disabled={
                                      mutationBusy !== null ||
                                      editor !== null ||
                                      diary.status === "locked" ||
                                      !completeDayLoaded ||
                                      entryIndex === 0
                                    }
                                    onClick={() => void reorderEntry(entry, "up")}
                                    type="button"
                                  >
                                    Move up
                                  </button>
                                  <button
                                    aria-label={`Move ${entryName(entry)} down within ${group.label}`}
                                    disabled={
                                      mutationBusy !== null ||
                                      editor !== null ||
                                      diary.status === "locked" ||
                                      !completeDayLoaded ||
                                      entryIndex === entries.length - 1
                                    }
                                    onClick={() => void reorderEntry(entry, "down")}
                                    type="button"
                                  >
                                    Move down
                                  </button>
                                  <button
                                    aria-label={`Edit ${entryName(entry)}`}
                                    disabled={
                                      mutationBusy !== null ||
                                      diary.status === "locked" ||
                                      session === null
                                    }
                                    onClick={() => {
                                      if (session) {
                                        setEditor(
                                          editState(entry, diary, session.profile.timeZone),
                                        );
                                      }
                                    }}
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
