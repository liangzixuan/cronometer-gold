"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { type ActivityDay, parseActivityDay } from "../../lib/activity";
import {
  activityDailyOverviewCard,
  type DailyOverviewRequestIdentity,
  type DailyOverviewScopedCardState,
  dailyOverviewCardForIdentity,
  dailyOverviewFence,
  dailyOverviewRequestMatches,
  dailyOverviewRequiresPrivateUiClosure,
  failedDailyOverviewCard,
  hydrationDailyOverviewCard,
  loadingDailyOverviewCard,
  scopedDailyOverviewCard,
} from "../../lib/daily-overview";
import {
  createOperationId,
  DIARY_PAGE_SIZE,
  type DiaryDay,
  type DiaryEditorOrigin,
  type DiaryEntry,
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
  quickAddOccurredAt,
  quoteRevision,
  resolveDiaryRouteDate,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import {
  createDiaryGroupDraft,
  emptyDiaryGroupDraft,
  prepareDiaryGroupDraftSave,
} from "../../lib/diary-group-draft";
import { type HydrationDay, parseHydrationDay } from "../../lib/hydration";
import { confirmBrowserLogout } from "../../lib/private-api";
import { AppNavigation } from "../ui/AppNavigation";
import { Icon } from "../ui/Icon";
import { CalmOverview } from "./CalmOverview";
import { DailySummary } from "./DailySummary";
import { DiaryDayNote } from "./DiaryDayNote";
import { TodayOverviewCards } from "./TodayOverviewCards";

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

interface RepeatDestination {
  readonly explicitDate: string | null;
  readonly entry: DiaryEntry;
  readonly sourcePage: DiaryPage;
  readonly session: SessionSummary;
  readonly targetDate: string;
  readonly mealSlot: string;
  readonly viewEpoch: number;
  readonly requestGeneration: number;
  readonly privateGeneration: number;
  readonly lifecycleEpoch: number;
}

interface RepeatOperation {
  readonly customDestination: boolean;
  readonly sourceEntryId: string;
  readonly sourceRevision: string;
  readonly sourceDate: string;
  readonly expectedTimeZone: string;
  readonly targetDate: string;
  readonly entryName: string;
  readonly key: string;
  readonly operationId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly occurredAt: string; readonly mealSlot: MealSlot };
  readonly serializedBody: string;
}

interface MutationOwner {
  readonly sourceDate: string;
  readonly token: number;
  readonly viewEpoch: number;
}

function dailyOverviewIdentity(
  session: SessionSummary | null,
  localDate: string,
  sessionGeneration: number,
  requestGeneration: number,
): DailyOverviewRequestIdentity | null {
  if (!session || !isLocalDate(localDate)) return null;
  return {
    ownerUserId: session.user.id,
    profileRevision: session.profile.revision,
    profileTimeZone: session.profile.timeZone,
    localDate,
    sessionGeneration,
    requestGeneration,
  };
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

function entryPortionLabel(entry: DiaryEntry): string {
  return entry.portion.kind === "serving"
    ? `${entry.portion.amount} × ${entry.portion.servingLabel}`
    : `${entry.portion.grams} g`;
}

function entryNutrientRows(entry: DiaryEntry) {
  const occurrences = new Map<string, number>();
  return entry.nutrients.map((nutrient) => {
    const occurrence = (occurrences.get(nutrient.nutrientId) ?? 0) + 1;
    occurrences.set(nutrient.nutrientId, occurrence);
    return { nutrient, key: `${nutrient.nutrientId}:${occurrence}` };
  });
}

function loadedMessage(page: DiaryPage): string {
  const loaded = page.data.entries.length;
  const total = page.page.totalEntries;
  if (total === 0) return "No foods logged for this local day.";
  return `${loaded} of ${total} ${total === 1 ? "entry" : "entries"} loaded. Nutrition totals include all ${total}.`;
}

interface DiaryClientProps {
  readonly view?: "diary" | "overview";
}

export function DiaryClient({ view = "diary" }: DiaryClientProps = {}) {
  const viewRoute = view === "overview" ? "/overview" : "/dashboard";
  const router = useRouter();
  const searchParams = useSearchParams();
  const explicitDate = searchParams.get("date");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState(() => resolveDiaryRouteDate(explicitDate, null) ?? "");
  const [diaryPage, setDiaryPage] = useState<DiaryPage | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [pageState, setPageState] = useState<PageLoadState>("idle");
  const [message, setMessage] = useState("Opening your private diary…");
  const [editor, setEditorState] = useState<EntryEditor | null>(null);
  const [repeatDestination, setRepeatDestination] = useState<RepeatDestination | null>(null);
  const repeatDestinationRef = useRef(repeatDestination);
  const repeatDestinationGeneration = useRef(0);
  const closeRepeatDestination = useCallback(() => {
    repeatDestinationGeneration.current += 1;
    repeatDestinationRef.current = null;
    setRepeatDestination(null);
  }, []);
  const [mealVisibility, setMealVisibility] = useState<{
    readonly scope: string;
    readonly collapsed: ReadonlySet<MealSlot>;
  }>(() => ({ scope: "", collapsed: new Set() }));
  const [entryNutrientChoices, setEntryNutrientChoices] = useState<
    ReadonlyMap<DiaryEntry, { readonly open: boolean }>
  >(() => new Map());
  const entryNutrientChoicesRef = useRef(entryNutrientChoices);
  const entryNutrientEpoch = useRef(0);
  const entryNutrientActive = useRef(false);
  const entryNutrientInstalledScope = useRef<{
    ownerUserId: string | null;
    timeZone: string | null;
    closed: boolean;
  } | null>(null);
  const mealVisibilityRef = useRef(mealVisibility);
  mealVisibilityRef.current = mealVisibility;
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [diaryGroupDraft, setDiaryGroupDraft] = useState(emptyDiaryGroupDraft);
  const [diaryGroupSettingsOpen, setDiaryGroupSettingsOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [hydrationOverview, setHydrationOverview] = useState<DailyOverviewScopedCardState>(() =>
    scopedDailyOverviewCard(null, loadingDailyOverviewCard()),
  );
  const [activityOverview, setActivityOverview] = useState<DailyOverviewScopedCardState>(() =>
    scopedDailyOverviewCard(null, loadingDailyOverviewCard()),
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const mealVisibilityGeneration = useRef(0);
  const explicitDateRef = useRef(explicitDate);
  explicitDateRef.current = explicitDate;
  const operationIds = useRef(new Map<string, string>());
  const repeatOperations = useRef(new Map<string, RepeatOperation>());
  const renderedRepeatOperations = new Map(repeatOperations.current);
  const loadController = useRef<AbortController | null>(null);
  const hydrationOverviewController = useRef<AbortController | null>(null);
  const activityOverviewController = useRef<AbortController | null>(null);
  const profileController = useRef<AbortController | null>(null);
  const timeZoneRefreshController = useRef<AbortController | null>(null);
  const pageRequestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const hydrationOverviewGeneration = useRef(0);
  const activityOverviewGeneration = useRef(0);
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
  const mealViewEpoch = viewEpoch.current;
  const mealRequestGeneration = requestGeneration.current;
  const mealPrivateGeneration = privateUiGeneration.current;
  const renderedMealVisibilityGeneration = mealVisibilityGeneration.current;
  const mealViewScope = JSON.stringify([
    session?.user.id ?? null,
    date,
    mealViewEpoch,
    mealPrivateGeneration,
  ]);
  const collapsedMeals =
    mealVisibility.scope === mealViewScope ? mealVisibility.collapsed : new Set<MealSlot>();

  const installedNutrientScope = entryNutrientInstalledScope.current;
  if (session && installedNutrientScope && !installedNutrientScope.closed) {
    if (installedNutrientScope.ownerUserId === null) {
      // The initial diary and session reads can finish in either order.
      installedNutrientScope.ownerUserId = session.user.id;
      installedNutrientScope.timeZone = session.profile.timeZone;
    } else if (
      installedNutrientScope.ownerUserId !== session.user.id ||
      installedNutrientScope.timeZone !== session.profile.timeZone
    ) {
      installedNutrientScope.closed = true;
      entryNutrientEpoch.current += 1;
      entryNutrientChoicesRef.current = new Map();
    }
  }
  const renderedNutrientEpoch = entryNutrientEpoch.current;
  if (
    repeatDestinationRef.current &&
    (repeatDestinationRef.current.explicitDate !== explicitDate ||
      repeatDestinationRef.current.sourcePage !== diaryPage ||
      repeatDestinationRef.current.session !== session ||
      repeatDestinationRef.current.viewEpoch !== mealViewEpoch ||
      repeatDestinationRef.current.requestGeneration !== mealRequestGeneration ||
      repeatDestinationRef.current.privateGeneration !== mealPrivateGeneration ||
      repeatDestinationRef.current.lifecycleEpoch !== renderedNutrientEpoch)
  ) {
    repeatDestinationRef.current = null;
    repeatDestinationGeneration.current += 1;
  }
  const renderedRepeatDestinationGeneration = repeatDestinationGeneration.current;
  const closeEntryNutrients = useCallback(() => {
    closeRepeatDestination();
    entryNutrientEpoch.current += 1;
    const next = new Map<DiaryEntry, { readonly open: boolean }>();
    entryNutrientChoicesRef.current = next;
    setEntryNutrientChoices(next);
  }, [closeRepeatDestination]);

  function canInspectEntryNutrients(entry: DiaryEntry) {
    const currentPage = diaryPageRef.current;
    const currentMeals = mealVisibilityRef.current;
    const mealHidden =
      currentMeals.scope === mealViewScope &&
      currentMeals.collapsed.has(entry.mealSlot) &&
      !currentPage?.data.entries.some(
        (candidate) =>
          candidate.mealSlot === entry.mealSlot && candidate.id === editorRef.current?.entryId,
      ) &&
      activeMutation.current === null &&
      profileController.current === null;
    return (
      entryNutrientActive.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      entryNutrientEpoch.current === renderedNutrientEpoch &&
      entryNutrientInstalledScope.current !== null &&
      !entryNutrientInstalledScope.current.closed &&
      entryNutrientInstalledScope.current.ownerUserId === session?.user.id &&
      entryNutrientInstalledScope.current.timeZone === session?.profile.timeZone &&
      !privateUiClosed.current &&
      privateUiGeneration.current === mealPrivateGeneration &&
      viewEpoch.current === mealViewEpoch &&
      explicitDateRef.current === explicitDate &&
      resolveDiaryRouteDate(explicitDate, session?.profile.timeZone ?? null) === date &&
      dateRef.current === date &&
      session !== null &&
      sessionRef.current?.user.id === session.user.id &&
      sessionRef.current?.profile.timeZone === session.profile.timeZone &&
      currentPage?.data.localDate === date &&
      currentPage.data.entries.includes(entry) &&
      !mealHidden
    );
  }

  function toggleEntryNutrients(entry: DiaryEntry) {
    const renderedChoice = entryNutrientChoices.get(entry);
    if (
      !canInspectEntryNutrients(entry) ||
      mealVisibilityGeneration.current !== renderedMealVisibilityGeneration ||
      entryNutrientChoicesRef.current.get(entry) !== renderedChoice
    )
      return;
    const next = new Map(entryNutrientChoicesRef.current);
    next.set(entry, { open: !renderedChoice?.open });
    entryNutrientChoicesRef.current = next;
    setEntryNutrientChoices(next);
  }

  useEffect(() => {
    entryNutrientActive.current = true;
    closeEntryNutrients();
    const visibilityChanged = () => {
      entryNutrientActive.current = document.visibilityState !== "hidden";
      closeEntryNutrients();
    };
    const pageHidden = () => {
      entryNutrientActive.current = false;
      closeEntryNutrients();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", visibilityChanged);
    return () => {
      entryNutrientActive.current = false;
      repeatDestinationRef.current = null;
      repeatDestinationGeneration.current += 1;
      entryNutrientEpoch.current += 1;
      entryNutrientChoicesRef.current = new Map();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", visibilityChanged);
    };
  }, [closeEntryNutrients]);

  const setEditor = useCallback(
    (next: EntryEditor | null) => {
      closeRepeatDestination();
      editorRef.current = next;
      setEditorState(next);
    },
    [closeRepeatDestination],
  );

  function canUseMealControls() {
    return (
      !privateUiClosed.current &&
      privateUiGeneration.current === mealPrivateGeneration &&
      viewEpoch.current === mealViewEpoch &&
      mealVisibilityGeneration.current === renderedMealVisibilityGeneration &&
      requestGeneration.current === mealRequestGeneration &&
      !pageRequestBusy.current &&
      explicitDateRef.current === explicitDate &&
      resolveDiaryRouteDate(explicitDate, session?.profile.timeZone ?? null) === date &&
      dateRef.current === date &&
      session !== null &&
      sessionRef.current?.user.id === session.user.id &&
      diaryPage !== null &&
      diaryPageRef.current === diaryPage &&
      state === "ready" &&
      activeMutation.current === null &&
      profileController.current === null &&
      !profileBusy
    );
  }

  function toggleMeal(mealSlot: MealSlot) {
    if (!canUseMealControls()) return;
    if (
      diaryPageRef.current?.data.entries.some(
        (entry) => entry.mealSlot === mealSlot && entry.id === editorRef.current?.entryId,
      )
    )
      return;
    closeRepeatDestination();
    const collapsed = new Set(collapsedMeals);
    if (collapsed.has(mealSlot)) collapsed.delete(mealSlot);
    else collapsed.add(mealSlot);
    mealVisibilityGeneration.current += 1;
    const next = { scope: mealViewScope, collapsed };
    mealVisibilityRef.current = next;
    setMealVisibility(next);
  }

  function expandAllMeals() {
    if (!canUseMealControls() || collapsedMeals.size === 0) return;
    mealVisibilityGeneration.current += 1;
    const next = { scope: mealViewScope, collapsed: new Set<MealSlot>() };
    mealVisibilityRef.current = next;
    setMealVisibility(next);
  }

  function beginEntryEdit(entry: DiaryEntry) {
    if (!canUseMealControls() || !session || !diary?.entries.includes(entry)) return;
    setEditor(editState(entry, diary, session.profile.timeZone));
  }

  const signInAgain = useCallback(() => {
    closeEntryNutrients();
    privateUiClosed.current = true;
    privateUiGeneration.current += 1;
    requestGeneration.current += 1;
    viewEpoch.current += 1;
    mutationSequence.current += 1;
    activeMutation.current = null;
    loadController.current?.abort();
    hydrationOverviewGeneration.current += 1;
    activityOverviewGeneration.current += 1;
    hydrationOverviewController.current?.abort();
    hydrationOverviewController.current = null;
    activityOverviewController.current?.abort();
    activityOverviewController.current = null;
    profileController.current?.abort();
    profileController.current = null;
    timeZoneRefreshController.current?.abort();
    timeZoneRefreshController.current = null;
    pageRequestBusy.current = false;
    operationIds.current.clear();
    repeatOperations.current.clear();
    setDiaryPage(null);
    setEditor(null);
    setSession(null);
    setMutationBusy(null);
    setProfileBusy(false);
    setHydrationOverview(scopedDailyOverviewCard(null, loadingDailyOverviewCard()));
    setActivityOverview(scopedDailyOverviewCard(null, loadingDailyOverviewCard()));
    setDiaryGroupSettingsOpen(false);
    setDiaryGroupDraft(emptyDiaryGroupDraft());
    setPageState("idle");
    setState("loading");
    setMessage("Closing your private diary…");
    setDate("");
    router.replace("/login");
    router.refresh();
  }, [router, setEditor, closeEntryNutrients]);

  const transitionCommittedDate = useCallback(
    (next: string, rewriteUrl: boolean) => {
      if (privateUiClosed.current || !isLocalDate(next)) return;
      if (next === dateRef.current) {
        if (rewriteUrl) {
          router.replace(`${viewRoute}?date=${encodeURIComponent(next)}`, { scroll: false });
        }
        return;
      }
      closeEntryNutrients();
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      hydrationOverviewGeneration.current += 1;
      activityOverviewGeneration.current += 1;
      hydrationOverviewController.current?.abort();
      hydrationOverviewController.current = null;
      activityOverviewController.current?.abort();
      activityOverviewController.current = null;
      pageRequestBusy.current = false;
      setMutationBusy(null);
      setEditor(null);
      setDiaryPage(null);
      setHydrationOverview(scopedDailyOverviewCard(null, loadingDailyOverviewCard()));
      setActivityOverview(scopedDailyOverviewCard(null, loadingDailyOverviewCard()));
      setPageState("idle");
      setDate(next);
      if (rewriteUrl) {
        router.replace(`${viewRoute}?date=${encodeURIComponent(next)}`, { scroll: false });
      }
    },
    [router, viewRoute, setEditor, closeEntryNutrients],
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
      closeEntryNutrients();
      entryNutrientInstalledScope.current = null;
      const nutrientRequestScope = {
        ownerUserId: sessionRef.current?.user.id ?? null,
        timeZone: sessionRef.current?.profile.timeZone ?? null,
        closed: false,
      };
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
        entryNutrientInstalledScope.current = nutrientRequestScope;
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
    [signInAgain, setEditor, closeEntryNutrients],
  );

  const loadOverviewCard = useCallback(
    async (kind: "hydration" | "activity", requestedDate: string) => {
      const initiatingSession = sessionRef.current;
      if (
        privateUiClosed.current ||
        !initiatingSession ||
        !isLocalDate(requestedDate) ||
        dateRef.current !== requestedDate
      ) {
        return false;
      }

      const generationRef =
        kind === "hydration" ? hydrationOverviewGeneration : activityOverviewGeneration;
      const controllerRef =
        kind === "hydration" ? hydrationOverviewController : activityOverviewController;
      const setCard = kind === "hydration" ? setHydrationOverview : setActivityOverview;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const expected = dailyOverviewIdentity(
        initiatingSession,
        requestedDate,
        privateUiGeneration.current,
        generation,
      );
      if (!expected) return false;
      const currentIdentity = () =>
        dailyOverviewIdentity(
          sessionRef.current,
          dateRef.current,
          privateUiGeneration.current,
          generationRef.current,
        );
      const isLocallyCurrent = () =>
        controllerRef.current === controller &&
        !controller.signal.aborted &&
        !privateUiClosed.current &&
        dailyOverviewRequestMatches(expected, currentIdentity());

      setCard(scopedDailyOverviewCard(expected, loadingDailyOverviewCard()));
      try {
        const endpoint =
          kind === "hydration"
            ? `/api/hydration?date=${encodeURIComponent(requestedDate)}`
            : `/api/activities?date=${encodeURIComponent(requestedDate)}`;
        const response = await fetch(endpoint, {
          cache: "no-store",
          headers: {
            accept: "application/json",
            "x-expected-owner-user-id": expected.ownerUserId,
          },
          signal: controller.signal,
        });
        if (!isLocallyCurrent()) return false;
        if (dailyOverviewRequiresPrivateUiClosure(kind, response.status, null)) {
          return signInAgain();
        }
        const body = await json(response);
        if (!isLocallyCurrent()) return false;
        if (dailyOverviewRequiresPrivateUiClosure(kind, response.status, responseCode(body))) {
          return signInAgain();
        }
        if (!response.ok) {
          throw new Error(
            responseError(
              body,
              kind === "hydration"
                ? "The plain-water summary could not be loaded."
                : "The manual-activity summary could not be loaded.",
            ),
          );
        }

        const day: HydrationDay | ActivityDay =
          kind === "hydration" ? parseHydrationDay(body) : parseActivityDay(body);
        if (!isLocallyCurrent()) return false;

        const sessionResponse = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!isLocallyCurrent()) return false;
        if (sessionResponse.status === 401) return signInAgain();
        const sessionBody = await json(sessionResponse);
        if (!isLocallyCurrent()) return false;
        if (!sessionResponse.ok) {
          throw new Error(
            responseError(sessionBody, "Your session could not be revalidated safely."),
          );
        }
        const revalidatedSession = parseSession(sessionBody);
        const fence = dailyOverviewFence({
          expected,
          current: currentIdentity(),
          revalidatedSession,
          response: day,
        });
        if (fence === "owner-changed") return signInAgain();
        if (fence === "profile-changed") {
          if (dailyOverviewRequestMatches(expected, currentIdentity())) {
            setSession((current) =>
              current?.user.id === expected.ownerUserId ? revalidatedSession : current,
            );
          }
          return false;
        }
        if (fence === "response-mismatch") {
          throw new TypeError(
            kind === "hydration"
              ? "The hydration service returned another local day or time zone."
              : "The activity service returned another local day or time zone.",
          );
        }
        if (fence !== "current" || !isLocallyCurrent()) return false;
        setCard(
          scopedDailyOverviewCard(
            expected,
            kind === "hydration"
              ? hydrationDailyOverviewCard(day as HydrationDay)
              : activityDailyOverviewCard(day as ActivityDay),
          ),
        );
        return true;
      } catch (error) {
        if (!isLocallyCurrent()) return false;
        setCard(
          scopedDailyOverviewCard(
            expected,
            failedDailyOverviewCard(
              error instanceof Error
                ? error.message
                : kind === "hydration"
                  ? "The plain-water summary could not be loaded."
                  : "The manual-activity summary could not be loaded.",
            ),
          ),
        );
        return false;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
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
          setDiaryGroupDraft(createDiaryGroupDraft(nextSession));
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

  useEffect(() => {
    if (session && isLocalDate(date)) {
      void loadOverviewCard("hydration", date);
      void loadOverviewCard("activity", date);
    }
    return () => {
      hydrationOverviewGeneration.current += 1;
      activityOverviewGeneration.current += 1;
      hydrationOverviewController.current?.abort();
      hydrationOverviewController.current = null;
      activityOverviewController.current?.abort();
      activityOverviewController.current = null;
    };
  }, [date, loadOverviewCard, session]);

  useEffect(
    () => () => {
      repeatOperations.current.clear();
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      hydrationOverviewGeneration.current += 1;
      activityOverviewGeneration.current += 1;
      hydrationOverviewController.current?.abort();
      hydrationOverviewController.current = null;
      activityOverviewController.current?.abort();
      activityOverviewController.current = null;
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
    closeRepeatDestination();
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
      setDiaryGroupDraft(createDiaryGroupDraft(nextSession));
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

  function canRepeatEntry(entry: DiaryEntry) {
    return !(
      !session ||
      !diary ||
      privateUiClosed.current ||
      privateUiGeneration.current !== mealPrivateGeneration ||
      viewEpoch.current !== mealViewEpoch ||
      requestGeneration.current !== mealRequestGeneration ||
      !entryNutrientActive.current ||
      (typeof document !== "undefined" && document.visibilityState === "hidden") ||
      entryNutrientEpoch.current !== renderedNutrientEpoch ||
      entryNutrientInstalledScope.current?.ownerUserId !== session.user.id ||
      explicitDateRef.current !== explicitDate ||
      dateRef.current !== date ||
      sessionRef.current !== session ||
      diaryPageRef.current !== diaryPage ||
      !diary.entries.includes(entry) ||
      state !== "ready" ||
      pageRequestBusy.current ||
      activeMutation.current !== null ||
      profileController.current !== null ||
      timeZoneRefreshController.current !== null ||
      profileBusy
    );
  }

  function pendingRepeat(entry: DiaryEntry) {
    return session
      ? repeatOperations.current.get(JSON.stringify([session.user.id, entry.id]))
      : undefined;
  }

  function renderedPendingRepeat(entry: DiaryEntry) {
    return session
      ? renderedRepeatOperations.get(JSON.stringify([session.user.id, entry.id]))
      : undefined;
  }

  function currentRepeatDestination(choice: RepeatDestination) {
    return (
      repeatDestinationRef.current === choice &&
      choice.explicitDate === explicitDateRef.current &&
      choice.sourcePage === diaryPageRef.current &&
      choice.session === sessionRef.current &&
      choice.viewEpoch === viewEpoch.current &&
      choice.requestGeneration === requestGeneration.current &&
      choice.privateGeneration === privateUiGeneration.current &&
      choice.lifecycleEpoch === entryNutrientEpoch.current &&
      editorRef.current === null &&
      canRepeatEntry(choice.entry) &&
      canInspectEntryNutrients(choice.entry)
    );
  }

  function openRepeatDestination(entry: DiaryEntry) {
    if (
      !session ||
      !diaryPage ||
      !canRepeatEntry(entry) ||
      !canInspectEntryNutrients(entry) ||
      editorRef.current !== null ||
      pendingRepeat(entry) ||
      repeatDestinationGeneration.current !== renderedRepeatDestinationGeneration ||
      mealVisibilityGeneration.current !== renderedMealVisibilityGeneration
    )
      return;
    const next: RepeatDestination = {
      explicitDate,
      entry,
      sourcePage: diaryPage,
      session,
      targetDate: localDateInTimeZone(new Date(), session.profile.timeZone),
      mealSlot: entry.mealSlot,
      viewEpoch: mealViewEpoch,
      requestGeneration: mealRequestGeneration,
      privateGeneration: mealPrivateGeneration,
      lifecycleEpoch: renderedNutrientEpoch,
    };
    repeatDestinationGeneration.current += 1;
    repeatDestinationRef.current = next;
    setRepeatDestination(next);
  }

  function changeRepeatDestination(
    choice: RepeatDestination,
    field: "targetDate" | "mealSlot",
    value: string,
  ) {
    if (!currentRepeatDestination(choice) || choice[field] === value) return;
    const next = { ...choice, [field]: value };
    repeatDestinationGeneration.current += 1;
    repeatDestinationRef.current = next;
    setRepeatDestination(next);
  }

  async function repeatEntry(
    entry: DiaryEntry,
    destination?: RepeatDestination,
    retry?: RepeatOperation,
  ) {
    if (!session || !diary || !canRepeatEntry(entry)) return;
    if (destination && !currentRepeatDestination(destination)) return;
    const ownerUserId = session.user.id;
    const privateGeneration = privateUiGeneration.current;
    const slot = JSON.stringify([ownerUserId, entry.id]);
    let pending = repeatOperations.current.get(slot);
    if (retry && (pending !== retry || !canInspectEntryNutrients(entry))) return;
    if (pending && (destination || (pending.customDestination && !retry))) return;
    if (!pending) {
      const now = new Date();
      const targetDate =
        destination?.targetDate ?? localDateInTimeZone(now, session.profile.timeZone);
      const targetMeal = diaryGroups.find((group) => group.mealSlot === destination?.mealSlot);
      if (destination && (!isLocalDate(targetDate) || !targetMeal)) {
        setMessage("Choose a valid repeat date and one of your configured meals.");
        return;
      }
      let occurredAt: string;
      try {
        occurredAt = destination
          ? quickAddOccurredAt(targetDate, session.profile.timeZone, now)
          : localDateTimeToInstant(
              targetDate,
              localTimeInTimeZone(now, session.profile.timeZone).slice(0, 5),
              session.profile.timeZone,
            );
      } catch {
        setMessage(
          "That repeat date has no usable time in your profile time zone. Choose another date.",
        );
        return;
      }
      const body = { occurredAt, mealSlot: targetMeal?.mealSlot ?? entry.mealSlot };
      const key = diaryRepeatOperationKey(entry.id, entry.revision, session.profile.timeZone, body);
      const requestOperationId = operationId(key);
      pending = {
        customDestination: destination !== undefined,
        sourceEntryId: entry.id,
        sourceRevision: entry.revision,
        sourceDate: diary.localDate,
        expectedTimeZone: session.profile.timeZone,
        targetDate,
        entryName: entryName(entry),
        key,
        operationId: requestOperationId,
        url: `/api/diary/entries/${encodeURIComponent(entry.id)}/repeat?date=${encodeURIComponent(diary.localDate)}&profileTimeZonePrecondition=v1`,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": requestOperationId,
          "if-match": quoteRevision(entry.revision),
          "x-expected-profile-time-zone": session.profile.timeZone,
        },
        body,
        serializedBody: JSON.stringify(body),
      };
      repeatOperations.current.set(slot, pending);
    }
    const operation = pending;
    const privateOwnerIsCurrent = () =>
      !privateUiClosed.current &&
      privateUiGeneration.current === privateGeneration &&
      sessionRef.current?.user.id === ownerUserId;
    const requestIsCurrent = () =>
      privateOwnerIsCurrent() && repeatOperations.current.get(slot) === operation;
    const responseIsCurrent = () =>
      privateOwnerIsCurrent() &&
      (!repeatOperations.current.has(slot) || repeatOperations.current.get(slot) === operation);
    const resolvedMessage =
      "An earlier response already resolved this Repeat. Refresh your diary for current details.";
    const retireOperation = () => {
      if (!requestIsCurrent()) return;
      repeatOperations.current.delete(slot);
      operationIds.current.delete(operation.key);
    };
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Repeating the pinned ${operation.entryName} version for ${operation.targetDate}…`);
    try {
      const response = await fetch(operation.url, {
        method: "POST",
        headers: operation.headers,
        body: operation.serializedBody,
        cache: "no-store",
      });
      if (!responseIsCurrent()) return;
      if (response.status === 401) {
        if (requestIsCurrent()) return signInAgain();
        if (mutationIsCurrent(owner)) setMessage(resolvedMessage);
        return;
      }
      const responseBody = await json(response);
      if (!responseIsCurrent()) return;
      if (!response.ok && !requestIsCurrent()) {
        if (mutationIsCurrent(owner)) setMessage(resolvedMessage);
        return;
      }
      if (response.status === 409 && responseCode(responseBody) === "DIARY_TIME_ZONE_CHANGED") {
        retireOperation();
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
        retireOperation();
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
          body: operation.body,
          entryId: operation.sourceEntryId,
          entryRevision: operation.sourceRevision,
          expectedTimeZone: operation.expectedTimeZone,
          kind: "repeat",
          operationId: operation.operationId,
          sourceLocalDate: operation.sourceDate,
        })
      ) {
        throw new TypeError("The server returned a correction receipt for a different repeat.");
      }
      retireOperation();
      const repeatedDate = mutation.entry?.localDate ?? operation.targetDate;
      await reportMutationReceipt(
        owner,
        mutation,
        repeatedDate === owner.sourceDate
          ? `Pinned entry version repeated in ${diaryGroupLabel(diaryGroups, operation.body.mealSlot)} with fresh authoritative totals.`
          : `Pinned entry version repeated in ${diaryGroupLabel(diaryGroups, operation.body.mealSlot)} for ${repeatedDate}.`,
        "The entry was repeated, but fresh diary data could not be confirmed. Choose Retry.",
      );
    } catch (error) {
      if (privateOwnerIsCurrent() && mutationIsCurrent(owner)) {
        if (requestIsCurrent()) {
          setMessage(
            `${error instanceof Error ? error.message : "The entry could not be repeated."} Choose Repeat again to retry the same operation for ${operation.targetDate} safely.`,
          );
        } else if (!repeatOperations.current.has(slot)) {
          setMessage(resolvedMessage);
        }
      }
    } finally {
      if (privateOwnerIsCurrent()) finishMutation(owner);
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
    let prepared: ReturnType<typeof prepareDiaryGroupDraftSave>;
    try {
      prepared = prepareDiaryGroupDraftSave(diaryGroupDraft, initiatingOwnerUserId);
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
          "if-match": prepared.ifMatch,
        },
        body: JSON.stringify(prepared.body),
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
        setDiaryGroupDraft(createDiaryGroupDraft(freshSession));
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
      setDiaryGroupDraft(createDiaryGroupDraft({ ...session, profile }));
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
    ? diaryGroupDraft.groups.some((group, index) => {
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
  const hydrationOverviewForCurrentIdentity = dailyOverviewCardForIdentity(
    hydrationOverview,
    dailyOverviewIdentity(
      session,
      date,
      privateUiGeneration.current,
      hydrationOverviewGeneration.current,
    ),
  );
  const activityOverviewForCurrentIdentity = dailyOverviewCardForIdentity(
    activityOverview,
    dailyOverviewIdentity(
      session,
      date,
      privateUiGeneration.current,
      activityOverviewGeneration.current,
    ),
  );

  const keyNutrientCodes = [
    "energy",
    "protein",
    "carbohydrate",
    "fat",
    "fiber",
    "calcium",
    "iron",
    "vitamin-d",
  ];
  const nutrientRows = (keyOnly: boolean) => {
    const totals = diary?.totals ?? [];
    const selected = keyOnly
      ? keyNutrientCodes.flatMap((code) => totals.filter((nutrient) => nutrient.code === code))
      : totals.filter((nutrient) => !keyNutrientCodes.includes(nutrient.code));
    return selected.map((nutrient) => {
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
    });
  };

  const overviewCards =
    session && hasCommittedDate ? (
      <TodayOverviewCards
        activity={activityOverviewForCurrentIdentity}
        date={date}
        hydration={hydrationOverviewForCurrentIdentity}
        onRetryActivity={() => void loadOverviewCard("activity", date)}
        onRetryHydration={() => void loadOverviewCard("hydration", date)}
      />
    ) : null;
  const dayNote =
    session && hasCommittedDate ? (
      <DiaryDayNote
        key={`${session.user.id}:${mealPrivateGeneration}`}
        session={session}
        localDate={date}
        privateGeneration={mealPrivateGeneration}
        isPrivateCurrent={() =>
          !privateUiClosed.current &&
          privateUiGeneration.current === mealPrivateGeneration &&
          sessionRef.current?.user.id === session.user.id
        }
        isViewCurrent={() =>
          !privateUiClosed.current &&
          privateUiGeneration.current === mealPrivateGeneration &&
          viewEpoch.current === mealViewEpoch &&
          sessionRef.current === session &&
          dateRef.current === date &&
          explicitDateRef.current === explicitDate &&
          (explicitDate === null || explicitDate === date)
        }
        onUnauthorized={signInAgain}
        onReturn={chooseDate}
      />
    ) : null;

  const isOverviewCurrent = useCallback(
    () =>
      !privateUiClosed.current &&
      privateUiGeneration.current === mealPrivateGeneration &&
      viewEpoch.current === mealViewEpoch &&
      requestGeneration.current === mealRequestGeneration &&
      sessionRef.current === session &&
      dateRef.current === date &&
      explicitDateRef.current === explicitDate &&
      (explicitDate === null || explicitDate === date),
    [session, date, explicitDate, mealPrivateGeneration, mealViewEpoch, mealRequestGeneration],
  );

  const dailySummary =
    session && diary && diaryPage && state === "ready" ? (
      <DailySummary totals={diary.totals} totalEntries={diaryPage.page.totalEntries} />
    ) : null;

  return (
    <>
      <aside className="sidebar ledgerSidebar">
        <Link className="brand brandDark" href="/">
          <Icon name="leaf" />
          <span>Nourishing</span>
        </Link>
        <AppNavigation
          date={hasCommittedDate ? date : undefined}
          active={view === "overview" ? "dashboard" : "diary"}
        />
        <details className="ledgerAccount">
          <summary>Account</summary>
          <div className="ledgerAccountPanel">
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
            <p className="wellnessNote">General wellness information. Not medical advice.</p>
          </div>
        </details>
      </aside>

      <section
        className={`dashboard ${view === "overview" ? "overviewDashboard" : "diaryDashboard"}`}
        id="today"
      >
        <div className="ledgerToolbar">
          <header
            className={`dashboardHeader ${view === "overview" ? "overviewHeader" : "diaryHeader"}`}
          >
            <div>
              <p className="kicker">
                {view === "overview" ? "Your daily overview" : "Private local-day diary"}
              </p>
              <h1>{view === "overview" ? "Your day at a glance" : "Diary"}</h1>
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
              <Icon name="chevron-left" />
            </button>
            <label className="srOnly" htmlFor="diary-date">
              Local date
            </label>
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
              <Icon name="chevron-right" />
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
          {hasCommittedDate ? (
            <Link className="buttonPrimary ledgerAddFood" href={`/foods${dateQuery}`}>
              <Icon name="plus" />
              Add food
            </Link>
          ) : null}
        </div>

        {view === "overview" &&
        hasCommittedDate &&
        !(session && diary && diaryPage && state === "ready") ? (
          <nav aria-label="Dashboard actions" className="overviewQuickLinks">
            <Link className="secondaryAction" href={`/dashboard${dateQuery}`}>
              Open diary
            </Link>
            <Link className="secondaryAction" href={`/reports?to=${encodeURIComponent(date)}`}>
              Nutrition report
            </Link>
          </nav>
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

        {view === "overview" && session && diary && diaryPage && state === "ready" ? (
          <CalmOverview
            key={`${session.user.id}:${mealPrivateGeneration}`}
            day={diary}
            totalEntries={diaryPage.page.totalEntries}
            completeDayLoaded={completeDayLoaded}
            session={session}
            isCurrent={isOverviewCurrent}
            onUnauthorized={signInAgain}
          />
        ) : null}
        {view === "overview" ? (
          <div className="calmOverviewSupport">
            {overviewCards}
            {dayNote ? (
              <details className="calmNote">
                <summary>
                  Day note <span>View or edit note</span>
                </summary>
                {dayNote}
              </details>
            ) : null}
          </div>
        ) : null}
        {view === "diary" ? (
          <div className="ledgerWorkspace">
            <div className="ledgerContent">
              {dailySummary}
              {view === "diary" && diary && diaryPage && state === "ready" ? (
                <>
                  <p className="diaryPageCount" id="diary-page-count">
                    {diary.entries.length} of {diaryPage.page.totalEntries} entries loaded.
                    Nutrition totals include all {diaryPage.page.totalEntries}.
                  </p>
                  {diary.entries.length > 0 ? (
                    <button
                      aria-controls="diary-entry-groups"
                      className="buttonQuiet"
                      disabled={!canUseMealControls()}
                      onClick={expandAllMeals}
                      type="button"
                    >
                      Expand all meals
                    </button>
                  ) : null}
                  {!completeDayLoaded ? (
                    <p className="fieldHelp">Load the complete day before changing entry order.</p>
                  ) : null}
                </>
              ) : null}

              {view === "diary" &&
              diary &&
              diaryPage?.page.totalEntries === 0 &&
              state === "ready" ? (
                <section className="emptyDiary" aria-labelledby="empty-diary-title">
                  <div>
                    <p className="kicker">Nothing logged</p>
                    <h2 id="empty-diary-title">Start with a food you actually ate.</h2>
                    <p>
                      Choose a source-attributed food and its reviewed default serving. Unknown
                      nutrients will remain unknown.
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

              {view === "diary" && diary && diary.entries.length > 0 ? (
                <div className="diaryLedgerBody">
                  <div
                    aria-busy={pageState === "loading"}
                    aria-describedby="diary-page-count"
                    className="mealLedger"
                    id="diary-entry-groups"
                  >
                    <div className="ledgerTableHead" aria-hidden="true">
                      <span>Food</span>
                      <span>Amount</span>
                      <span>kcal</span>
                      <span />
                    </div>
                    {diaryGroups.map((group) => {
                      const entries = diary.entries.filter(
                        (entry) => entry.mealSlot === group.mealSlot,
                      );
                      const containsEditor = entries.some((entry) => entry.id === editor?.entryId);
                      const collapsed =
                        collapsedMeals.has(group.mealSlot) && !containsEditor && !controlsBusy;
                      return (
                        <section
                          className="mealSection"
                          key={group.mealSlot}
                          aria-labelledby={`meal-${group.mealSlot}`}
                        >
                          <div className="mealHeading">
                            <h2 id={`meal-${group.mealSlot}`}>{group.label}</h2>
                            <div className="mealActions">
                              <button
                                aria-controls={`meal-entries-${group.mealSlot}`}
                                aria-expanded={!collapsed}
                                aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                                className="buttonQuiet"
                                disabled={
                                  controlsBusy ||
                                  state !== "ready" ||
                                  pageState === "loading" ||
                                  !session ||
                                  containsEditor
                                }
                                onClick={() => toggleMeal(group.mealSlot)}
                                type="button"
                              >
                                {collapsed ? "Expand" : "Collapse"}
                              </button>
                            </div>
                          </div>
                          {collapsed && entries.length > 0 ? (
                            <p className="fieldHelp">Loaded entries hidden.</p>
                          ) : null}
                          <div className="mealBody">
                            <div className="mealEntries" id={`meal-entries-${group.mealSlot}`}>
                              {entries.length === 0 ? (
                                <p className="emptyMeal">
                                  {diaryPage?.page.nextCursor
                                    ? "No entries loaded for this meal yet"
                                    : "No entries"}
                                </p>
                              ) : collapsed ? null : (
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
                                                setEditor({
                                                  ...editor,
                                                  quantity: event.target.value,
                                                })
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
                                                setEditor({
                                                  ...editor,
                                                  localDate: event.target.value,
                                                })
                                              }
                                              type="date"
                                              value={editor.localDate}
                                            />
                                          </label>
                                          <label>
                                            Local time
                                            <input
                                              onChange={(event) =>
                                                setEditor({
                                                  ...editor,
                                                  localTime: event.target.value,
                                                })
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
                                          <small
                                            className="entryNoteHint"
                                            id={`entry-note-help-${entry.id}`}
                                          >
                                            Clear the field and save to remove this note from the
                                            current display only. Immutable prior revisions remain
                                            in your private account export until whole-account
                                            erasure. Character count:{" "}
                                            {diaryEntryNoteCharacterCount(editor.note)}
                                            of 2,000.
                                          </small>
                                          <small className="entryTimeHint">
                                            Changed date and time are interpreted in{" "}
                                            {editor.originTimeZone}.
                                          </small>
                                          <div className="entryActions">
                                            <button
                                              aria-label={`Clear note field for ${entryName(entry)}`}
                                              disabled={
                                                mutationBusy !== null || editor.note.length === 0
                                              }
                                              onClick={() => setEditor({ ...editor, note: "" })}
                                              type="button"
                                            >
                                              Clear field
                                            </button>
                                            <button
                                              aria-label={`Save changes to ${entryName(entry)}`}
                                              disabled={
                                                mutationBusy !== null || diary.status === "locked"
                                              }
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
                                        <article className="diaryEntry ledgerEntryRow">
                                          <div className="ledgerRowName">
                                            <h3>{entryName(entry)}</h3>
                                          </div>
                                          <div className="ledgerRowPortion">
                                            <span className="srOnly">Amount: </span>
                                            {entryPortionLabel(entry)}
                                          </div>
                                          <div className="ledgerRowEnergy">
                                            <span className="srOnly">Energy: </span>
                                            {entryEnergyDisplay(entry)}
                                          </div>
                                          <div className="ledgerRowActions">
                                            <button
                                              aria-label={`Edit ${entryName(entry)}`}
                                              disabled={
                                                mutationBusy !== null ||
                                                diary.status === "locked" ||
                                                session === null
                                              }
                                              onClick={() => beginEntryEdit(entry)}
                                              type="button"
                                            >
                                              Edit
                                            </button>
                                          </div>
                                        </article>
                                      )}
                                      <details
                                        className="ledgerMore"
                                        open={
                                          repeatDestination?.entry === entry ||
                                          renderedPendingRepeat(entry) !== undefined
                                            ? true
                                            : undefined
                                        }
                                      >
                                        <summary
                                          aria-label={`More actions and details for ${entryName(entry)}`}
                                        >
                                          <Icon name="more" />
                                          <span>More</span>
                                        </summary>
                                        <div className="ledgerMoreContent">
                                          <div className="ledgerEntryEvidence">
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
                                            <small>Logged at {entry.localTime.slice(0, 5)}</small>
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
                                                <small>
                                                  {entry.recipe.retentionPolicy.assumption}
                                                </small>
                                                {entry.recipe.warnings.map((warning) => (
                                                  <small key={warning.code}>
                                                    {warning.message}
                                                  </small>
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
                                          {editor?.entryId !== entry.id ? (
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
                                                aria-label={
                                                  renderedPendingRepeat(entry)?.customDestination
                                                    ? `Retry repeat for ${entryName(entry)}`
                                                    : `Repeat ${entryName(entry)} today`
                                                }
                                                disabled={mutationBusy !== null}
                                                onClick={() =>
                                                  void repeatEntry(
                                                    entry,
                                                    undefined,
                                                    renderedPendingRepeat(entry)?.customDestination
                                                      ? renderedPendingRepeat(entry)
                                                      : undefined,
                                                  )
                                                }
                                                type="button"
                                              >
                                                {mutationBusy === entry.id
                                                  ? "Working…"
                                                  : renderedPendingRepeat(entry)?.customDestination
                                                    ? "Retry pinned repeat"
                                                    : "Repeat today"}
                                              </button>
                                              <button
                                                aria-label={`Repeat ${entryName(entry)} to another day or meal`}
                                                disabled={
                                                  mutationBusy !== null ||
                                                  editor !== null ||
                                                  renderedPendingRepeat(entry) !== undefined
                                                }
                                                onClick={() => openRepeatDestination(entry)}
                                                type="button"
                                              >
                                                Repeat to…
                                              </button>
                                              <button
                                                aria-label={`Delete ${entryName(entry)}`}
                                                className="dangerAction"
                                                disabled={
                                                  mutationBusy !== null || diary.status === "locked"
                                                }
                                                onClick={() => void deleteEntry(entry)}
                                                type="button"
                                              >
                                                {mutationBusy === entry.id ? "Working…" : "Delete"}
                                              </button>
                                            </div>
                                          ) : null}
                                          {canInspectEntryNutrients(entry) &&
                                          renderedPendingRepeat(entry) ? (
                                            <section
                                              aria-label={`Pending repeat for ${entryName(entry)}`}
                                            >
                                              <p className="fieldHelp">
                                                Pending repeat:{" "}
                                                {renderedPendingRepeat(entry)?.targetDate} ·{" "}
                                                {diaryGroupLabel(
                                                  diaryGroups,
                                                  renderedPendingRepeat(entry)?.body.mealSlot ??
                                                    entry.mealSlot,
                                                )}{" "}
                                                · {renderedPendingRepeat(entry)?.expectedTimeZone}.
                                                The destination and pinned source version stay fixed
                                                until this operation is resolved.
                                              </p>
                                              {!renderedPendingRepeat(entry)?.customDestination ? (
                                                <button
                                                  type="button"
                                                  disabled={mutationBusy !== null}
                                                  onClick={() =>
                                                    void repeatEntry(
                                                      entry,
                                                      undefined,
                                                      renderedPendingRepeat(entry),
                                                    )
                                                  }
                                                >
                                                  Retry pinned repeat
                                                </button>
                                              ) : null}
                                            </section>
                                          ) : null}
                                          {repeatDestination?.entry === entry &&
                                          currentRepeatDestination(repeatDestination) ? (
                                            <section
                                              className="entryEditor"
                                              aria-label={`Repeat destination for ${entryName(entry)}`}
                                            >
                                              <h3>Repeat {entryName(entry)} to…</h3>
                                              <label>
                                                Repeat date
                                                <input
                                                  type="date"
                                                  value={repeatDestination.targetDate}
                                                  onChange={(event) =>
                                                    changeRepeatDestination(
                                                      repeatDestination,
                                                      "targetDate",
                                                      event.target.value,
                                                    )
                                                  }
                                                />
                                              </label>
                                              <label>
                                                Repeat meal
                                                <select
                                                  value={repeatDestination.mealSlot}
                                                  onChange={(event) =>
                                                    changeRepeatDestination(
                                                      repeatDestination,
                                                      "mealSlot",
                                                      event.target.value,
                                                    )
                                                  }
                                                >
                                                  {diaryGroups.map((group) => (
                                                    <option
                                                      key={group.mealSlot}
                                                      value={group.mealSlot}
                                                    >
                                                      {group.label}
                                                    </option>
                                                  ))}
                                                </select>
                                              </label>
                                              <p className="fieldHelp">
                                                Today uses the current time; another date uses noon
                                                in {session?.profile.timeZone}. The logged quantity,
                                                note and nutrient snapshot are repeated unchanged.
                                              </p>
                                              <div className="entryActions">
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    void repeatEntry(entry, repeatDestination)
                                                  }
                                                >
                                                  Confirm repeat destination
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    if (currentRepeatDestination(repeatDestination))
                                                      closeRepeatDestination();
                                                  }}
                                                >
                                                  Cancel repeat destination
                                                </button>
                                              </div>
                                            </section>
                                          ) : null}
                                          {canInspectEntryNutrients(entry) ? (
                                            <section
                                              aria-label={`Logged nutrients for ${entryName(entry)}, ${entryPortionLabel(entry)} at ${entry.localTime.slice(0, 5)}`}
                                              style={{
                                                minWidth: 0,
                                                paddingBottom: 16,
                                                overflowWrap: "anywhere",
                                              }}
                                            >
                                              <div className="entryActions">
                                                <button
                                                  aria-label={`${entryNutrientChoices.get(entry)?.open ? "Hide" : "Show"} nutrients for ${entryName(entry)}, ${entryPortionLabel(entry)} at ${entry.localTime.slice(0, 5)}`}
                                                  aria-expanded={
                                                    entryNutrientChoices.get(entry)?.open ?? false
                                                  }
                                                  aria-controls={`entry-nutrients-${entry.id}`}
                                                  onClick={() => toggleEntryNutrients(entry)}
                                                  type="button"
                                                >
                                                  {entryNutrientChoices.get(entry)?.open
                                                    ? "Hide nutrients"
                                                    : "Show nutrients"}
                                                </button>
                                              </div>
                                              <div id={`entry-nutrients-${entry.id}`}>
                                                {entryNutrientChoices.get(entry)?.open ? (
                                                  <>
                                                    <p className="fieldHelp">
                                                      Nutrition for this saved logged portion:{" "}
                                                      {entryPortionLabel(entry)}. Entry revision{" "}
                                                      {entry.revision}.
                                                      {editor?.entryId === entry.id
                                                        ? " Unsaved edits are not included."
                                                        : ""}
                                                    </p>
                                                    {entry.nutrients.length === 0 ? (
                                                      <p className="fieldHelp">
                                                        Nutrient details are unavailable for this
                                                        logged portion.
                                                      </p>
                                                    ) : (
                                                      <dl>
                                                        {entryNutrientRows(entry).map(
                                                          ({ nutrient, key }) => {
                                                            const display =
                                                              nutrientDisplay(nutrient);
                                                            return (
                                                              <div
                                                                key={key}
                                                                className={`nutrientTotal nutrientTotal--${nutrient.completeness}`}
                                                                style={{
                                                                  gridTemplateColumns:
                                                                    "minmax(0, 1fr)",
                                                                  gap: 4,
                                                                }}
                                                              >
                                                                <dt>
                                                                  {nutrient.name} ({nutrient.unit})
                                                                </dt>
                                                                <dd style={{ textAlign: "left" }}>
                                                                  {display.amount}
                                                                  <small>
                                                                    {display.qualification}
                                                                  </small>
                                                                </dd>
                                                              </div>
                                                            );
                                                          },
                                                        )}
                                                      </dl>
                                                    )}
                                                  </>
                                                ) : null}
                                              </div>
                                            </section>
                                          ) : null}
                                        </div>
                                      </details>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                          <div className="mealFooter">
                            <Link
                              className="mealAddFood"
                              href={`/foods?date=${date}&meal=${group.mealSlot}`}
                            >
                              <Icon name="plus" /> Add food to {group.label}
                            </Link>
                          </div>
                        </section>
                      );
                    })}
                  </div>

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
              <div className="ledgerGroupSettings">
                {view === "diary" ? (
                  <div className="diaryGroupSettingsLauncher">
                    <button
                      aria-controls="diary-group-settings"
                      aria-expanded={diaryGroupSettingsOpen}
                      className="secondaryAction"
                      disabled={!session || controlsBusy}
                      onClick={() => {
                        const opening = !diaryGroupSettingsOpen;
                        if (opening && session) setDiaryGroupDraft(createDiaryGroupDraft(session));
                        setDiaryGroupSettingsOpen(opening);
                      }}
                      type="button"
                    >
                      {diaryGroupSettingsOpen
                        ? "Close diary group settings"
                        : "Customize diary groups"}
                    </button>
                  </div>
                ) : null}

                {view === "diary" && diaryGroupSettingsOpen && session ? (
                  <section
                    aria-labelledby="diary-group-settings-title"
                    className="diaryGroupSettings"
                    id="diary-group-settings"
                  >
                    <div>
                      <p className="kicker">Your diary layout</p>
                      <h2 id="diary-group-settings-title">Name and order meal groups</h2>
                      <p>
                        Labels and order change everywhere you choose a diary destination. Existing
                        entries keep their stable saved destination.
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
                        {diaryGroupDraft.groups.map((group, index) => (
                          <li key={group.mealSlot}>
                            <label htmlFor={`diary-group-${group.mealSlot}`}>
                              Group {index + 1} label
                              <input
                                disabled={profileBusy}
                                id={`diary-group-${group.mealSlot}`}
                                maxLength={120}
                                onChange={(event) =>
                                  setDiaryGroupDraft((current) => ({
                                    ...current,
                                    groups: current.groups.map((candidate) =>
                                      candidate.mealSlot === group.mealSlot
                                        ? { ...candidate, label: event.target.value }
                                        : candidate,
                                    ),
                                  }))
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
                                  setDiaryGroupDraft((current) => ({
                                    ...current,
                                    groups: moveDiaryGroup(current.groups, index, -1),
                                  }))
                                }
                                type="button"
                              >
                                Move up
                              </button>
                              <button
                                aria-label={`Move group ${index + 1} down`}
                                disabled={
                                  profileBusy || index === diaryGroupDraft.groups.length - 1
                                }
                                onClick={() =>
                                  setDiaryGroupDraft((current) => ({
                                    ...current,
                                    groups: moveDiaryGroup(current.groups, index, 1),
                                  }))
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
                        Use four unique labels, each 1–40 characters. Reset prepares Breakfast,
                        Lunch, Dinner, and Snacks; nothing changes until you save.
                      </p>
                      <div className="entryActions">
                        <button
                          disabled={profileBusy}
                          onClick={() => {
                            setDiaryGroupDraft((current) => ({
                              ...current,
                              groups: defaultDiaryGroups,
                            }));
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
                            setDiaryGroupDraft(createDiaryGroupDraft(session));
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
              </div>
            </div>
            <div className="ledgerRail">
              {diary && diaryPage && state === "ready" ? (
                <aside className="nutritionSummary" aria-labelledby="nutrition-summary-title">
                  <div className="ledgerPanelHeading">
                    <h2 id="nutrition-summary-title">Nutrient summary</h2>
                    <Link href={`/reports?to=${encodeURIComponent(date)}`}>
                      Open nutrition report
                    </Link>
                  </div>
                  {diary.totals.length === 0 ? (
                    <p>No nutrient totals are available yet.</p>
                  ) : (
                    <>
                      <dl>{nutrientRows(true)}</dl>
                      <details className="ledgerOtherNutrients">
                        <summary>More nutrients</summary>
                        <dl>{nutrientRows(false)}</dl>
                      </details>
                    </>
                  )}
                  <Link className="ledgerSavedTargets" href={`/goals${dateQuery}`}>
                    <Icon name="settings" /> Saved targets
                  </Link>
                  <p className="totalsNote">
                    These totals cover all {diaryPage.page.totalEntries} diary entries, including
                    entries not loaded yet. Partial nutrient totals are lower bounds. Unknown values
                    are never counted as zero.
                  </p>
                </aside>
              ) : null}
              {overviewCards}
              {dayNote}
            </div>
          </div>
        ) : null}

        {diary?.status === "locked" ? (
          <p className="lockedNotice">This day is locked and cannot be edited.</p>
        ) : null}
      </section>
    </>
  );
}
