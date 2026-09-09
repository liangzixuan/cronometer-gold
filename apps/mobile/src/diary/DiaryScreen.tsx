import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { parseActivityDay } from "../activity/activity";
import { apiUrl, authenticatedHeaders, jsonBody, responseError } from "../api/private-api";
import { parseHydrationDay } from "../hydration/hydration";
import { palette } from "../theme";
import {
  bindDiaryReorderDigestEvidence,
  buildDiaryReorderPlan,
  createDiaryUnauthorizedSingleFlight,
  DIARY_PAGE_SIZE,
  type DiaryEditorOrigin,
  type DiaryEntry,
  type DiaryGroup,
  DiaryOrderBaselineMismatchError,
  type DiaryPage,
  type DiaryUnauthorizedSingleFlight,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryGroupLabel,
  diaryNoteFromDraft,
  diaryPagePath,
  diaryRouteTransitionGeneration,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  isPositiveDecimal,
  isProfileOwnerChangedProblem,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  MAX_DIARY_NOTE_LENGTH,
  type MealSlot,
  mergeDiaryPages,
  moveDiaryGroup,
  normalizeDiaryGroups,
  nutrientDisplay,
  type ProfileSummary,
  parseDiaryPage,
  parseProfileResponse,
  profileRequestIdentityMatches,
  quickAddOccurredAt,
  resetDiaryGroups,
  shiftLocalDate,
} from "./diary";
import type {
  DiaryEntryUpdateRequestBody,
  QuickAddOutboxController,
  QuickAddOutboxControllerState,
  QuickAddReceipt,
} from "./quick-add-outbox";
import {
  DiaryOutboxCapacityError,
  DiaryOutboxDependencyError,
  MAX_QUICK_ADD_OUTBOX_ITEMS,
  QuickAddEnqueueAmbiguousError,
} from "./quick-add-outbox";
import {
  acceptTodaySupportingSummary,
  activityTodaySummary,
  beginTodaySupportingSummaryLoad,
  hydrationTodaySummary,
  isTodayActivityOwnerChangedProblem,
  loadingTodaySupportingSummaries,
  type TodaySummaryKind,
  type TodaySummaryReplacement,
  type TodaySummaryRequestFence,
  todaySummaryCardForRender,
  todaySummaryError,
  todaySummaryRequestMatches,
  todaySupportingSummaryPath,
} from "./today-summary";

type LoadState = "loading" | "ready" | "error";
type PageLoadState = "idle" | "loading" | "error";

interface Editor extends DiaryEditorOrigin {
  readonly originalEntryLocalDate: string;
  readonly quantity: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
  readonly originalLocalTime: string;
  readonly note: string;
}

interface MutationOwner {
  readonly sourceDate: string;
  readonly token: number;
  readonly viewEpoch: number;
}

interface DiaryScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly expectedOwnerUserId: string;
  readonly profileTimeZone: string;
  readonly profileRevision: string;
  readonly diaryGroups: readonly DiaryGroup[];
  readonly sessionEpoch: number;
  readonly requestedDate?: string;
  readonly refreshKey?: string;
  readonly supportingSummaryRefreshKey: number;
  readonly onSearch: (date: string, meal: MealSlot, timeZone: string) => void;
  readonly onRecipes: () => void;
  readonly onGoals: () => void;
  readonly onReports: () => void;
  readonly onHydration: (date: string) => void;
  readonly onActivity: (date: string) => void;
  readonly onHealth: () => void;
  readonly onProfileUpdated: (profile: ProfileSummary) => void;
  readonly onUnauthorized: () => Promise<void>;
  readonly quickAddOutboxController: QuickAddOutboxController;
  readonly quickAddOutboxState: QuickAddOutboxControllerState;
  readonly subscribeQuickAddReceipts: (listener: (receipt: QuickAddReceipt) => void) => () => void;
}

function editorFor(
  entry: DiaryEntry,
  day: DiaryPage["data"],
  currentProfileTimeZone: string,
): Editor {
  const instant = new Date(entry.occurredAt);
  const localDate = localDateInTimeZone(instant, currentProfileTimeZone);
  const localTime = localTimeInTimeZone(instant, currentProfileTimeZone);
  return {
    ...diaryEditorOrigin(day, entry, currentProfileTimeZone),
    originalEntryLocalDate: localDate,
    quantity: entry.portion.kind === "serving" ? entry.portion.amount : entry.portion.grams,
    mealSlot: entry.mealSlot,
    localDate,
    localTime,
    originalLocalTime: localTime,
    note: entry.note ?? "",
  };
}

function entryName(entry: DiaryEntry): string {
  return entry.entryKind === "food" ? entry.food.name : entry.recipe.name;
}

function entryPortionLabel(entry: DiaryEntry): string {
  return entry.portion.kind === "grams"
    ? `${entry.portion.grams} g`
    : `${entry.portion.amount} ${entry.portion.servingLabel}`;
}

function loadedMessage(page: DiaryPage): string {
  const loaded = page.data.entries.length;
  const total = page.page.totalEntries;
  if (total === 0) return "No foods logged for this local day.";
  return `${loaded} of ${total} ${total === 1 ? "entry" : "entries"} loaded. Nutrition totals include all ${total}.`;
}

function queuedQuickAddMessage(state: QuickAddOutboxControllerState): string | null {
  const queued =
    state.pendingCount === 1
      ? "1 queued diary change"
      : `${state.pendingCount} queued diary changes`;
  switch (state.status) {
    case "idle":
      return null;
    case "pending":
      return `${queued} ${state.pendingCount === 1 ? "is" : "are"} not yet included in diary totals.`;
    case "draining":
      return `Sending ${queued}. ${state.pendingCount === 1 ? "It is" : "They are"} not reflected in the diary until the server confirms each change.`;
    case "blocked":
      return state.blockedReason === "time_zone_changed"
        ? `${queued} stopped because your diary time zone changed. Discard the stale ${state.foodName} change, reload the diary, and authorize it again in the current time zone.`
        : state.httpStatus === 412
          ? `${queued} stopped because ${state.foodName} changed elsewhere. Discard this stale change, reload the diary, and authorize it again from the fresh revision.`
          : `${queued} stopped at ${state.foodName} (${state.servingLabel}) for ${state.localDate} after HTTP ${state.httpStatus}. The exact request is retained and no optimistic result was applied.`;
    case "unavailable":
      if (state.reason === "storage") {
        return "Queued diary delivery is unavailable because secure storage could not be read. Do not assume a queued change was applied.";
      }
      if (state.reason === "credential") {
        return `${queued} ${state.pendingCount === 1 ? "is" : "are"} paused until authentication is restored and ${state.pendingCount === 1 ? "is" : "are"} not included in diary totals.`;
      }
      return `${queued} ${state.pendingCount === 1 ? "is" : "are"} retained after a ${state.reason === "network" ? "network" : "server response"} interruption and ${state.pendingCount === 1 ? "is" : "are"} not included in diary totals.`;
    case "owner_mismatch":
      return "Queued diary delivery was fenced because its private owner could not be verified. Private-device cleanup is required, and no queued change is treated as applied.";
    case "closed":
      return state.pendingCount > 0
        ? `Diary delivery is closed with ${queued}; ${state.pendingCount === 1 ? "it is" : "they are"} not included in diary totals.`
        : null;
  }
}

export function DiaryScreen({
  apiBase,
  accessToken,
  expectedOwnerUserId,
  profileTimeZone,
  profileRevision,
  diaryGroups,
  sessionEpoch,
  requestedDate,
  refreshKey,
  supportingSummaryRefreshKey,
  onSearch,
  onRecipes,
  onGoals,
  onReports,
  onHydration,
  onActivity,
  onHealth,
  onProfileUpdated,
  onUnauthorized,
  quickAddOutboxController,
  quickAddOutboxState,
  subscribeQuickAddReceipts,
}: DiaryScreenProps) {
  const initialDate =
    requestedDate && isLocalDate(requestedDate)
      ? requestedDate
      : localDateInTimeZone(new Date(), profileTimeZone);
  const [date, setDate] = useState(initialDate);
  const [dateDraft, setDateDraft] = useState(initialDate);
  const [diaryPage, setDiaryPage] = useState<DiaryPage | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [pageState, setPageState] = useState<PageLoadState>("idle");
  const [message, setMessage] = useState("Opening your private diary…");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState<readonly DiaryGroup[]>(() =>
    diaryGroups.map((group) => ({ ...group })),
  );
  const [groupBusy, setGroupBusy] = useState(false);
  const [outboxAction, setOutboxAction] = useState<"retry" | "discard" | null>(null);
  const [pendingCorrectionEntries, setPendingCorrectionEntries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingReorderDates, setPendingReorderDates] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingDiaryDates, setPendingDiaryDates] = useState<ReadonlySet<string>>(() => new Set());
  const [routeReloadGeneration, setRouteReloadGeneration] = useState(0);
  const [supportingSummaries, setSupportingSummaries] = useState(loadingTodaySupportingSummaries);
  const loadController = useRef<AbortController | null>(null);
  const profileController = useRef<AbortController | null>(null);
  const supportingSummaryControllers = useRef<Record<TodaySummaryKind, AbortController | null>>({
    hydration: null,
    activity: null,
  });
  const supportingSummaryGenerations = useRef<Record<TodaySummaryKind, number>>({
    hydration: 0,
    activity: 0,
  });
  const expectedOwnerUserIdRef = useRef(expectedOwnerUserId);
  expectedOwnerUserIdRef.current = expectedOwnerUserId;
  const sessionEpochRef = useRef(sessionEpoch);
  sessionEpochRef.current = sessionEpoch;
  const profileRevisionRef = useRef(profileRevision);
  profileRevisionRef.current = profileRevision;
  const profileTimeZoneRef = useRef(profileTimeZone);
  profileTimeZoneRef.current = profileTimeZone;
  const supportingSummaryRefreshKeyRef = useRef(supportingSummaryRefreshKey);
  supportingSummaryRefreshKeyRef.current = supportingSummaryRefreshKey;
  const previousProfileIdentity = useRef({ expectedOwnerUserId, sessionEpoch });
  const pageRequestBusy = useRef(false);
  const requestGeneration = useRef(0);
  const viewEpoch = useRef(0);
  const mutationSequence = useRef(0);
  const activeMutation = useRef<number | null>(null);
  const privateUiClosed = useRef(false);
  const unauthorizedFlight = useRef<DiaryUnauthorizedSingleFlight | null>(null);
  const appliedRouteGeneration = useRef(diaryRouteTransitionGeneration(requestedDate, refreshKey));
  const dateRef = useRef(date);
  dateRef.current = date;
  const supportingSummaryIdentityKey = JSON.stringify([
    expectedOwnerUserId,
    sessionEpoch,
    profileRevision,
    profileTimeZone,
  ]);
  const diary = diaryPage?.data.localDate === date ? diaryPage.data : null;
  const queuedMessage = queuedQuickAddMessage(quickAddOutboxState);

  const closeForUnauthorized = useCallback(() => {
    unauthorizedFlight.current ??= createDiaryUnauthorizedSingleFlight();
    if (!privateUiClosed.current) {
      privateUiClosed.current = true;
      viewEpoch.current += 1;
      mutationSequence.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      profileController.current?.abort();
      for (const kind of ["hydration", "activity"] as const) {
        supportingSummaryGenerations.current[kind] += 1;
        supportingSummaryControllers.current[kind]?.abort();
        supportingSummaryControllers.current[kind] = null;
      }
      pageRequestBusy.current = false;
      dateRef.current = "";
      setDiaryPage(null);
      setEditor(null);
      setGroupEditorOpen(false);
      setGroupBusy(false);
      setBusyEntry(null);
      setPageState("idle");
      setState("loading");
      setSupportingSummaries(loadingTodaySupportingSummaries());
      setMessage("Closing your private diary…");
      setDateDraft("");
      setDate("");
    }
    return unauthorizedFlight.current.run(onUnauthorized);
  }, [onUnauthorized]);

  const load = useCallback(
    async (requested: string, refreshedAfterStalePage = false) => {
      if (privateUiClosed.current || dateRef.current !== requested) return false;
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
        !privateUiClosed.current &&
        dateRef.current === requested;
      setEditor(null);
      setDiaryPage(null);
      setPageState("idle");
      setState("loading");
      setMessage(`Loading ${requested}…`);
      try {
        const url = apiUrl(apiBase, diaryPagePath(requested));
        const response = await fetch(url.toString(), {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        });
        if (!isCurrent()) return false;
        if (response.status === 401) {
          await closeForUnauthorized();
          return false;
        }
        const body = await jsonBody(response);
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
        if (refreshedAfterStalePage) AccessibilityInfo.announceForAccessibility(nextMessage);
        return true;
      } catch (caught) {
        if (!isCurrent()) return false;
        setDiaryPage(null);
        setState("error");
        setMessage(caught instanceof Error ? caught.message : "The diary could not be loaded.");
        return false;
      }
    },
    [accessToken, apiBase, closeForUnauthorized],
  );

  const loadSupportingSummary = useCallback(
    async (kind: TodaySummaryKind, requested: string) => {
      if (privateUiClosed.current || dateRef.current !== requested) return;
      supportingSummaryControllers.current[kind]?.abort();
      const controller = new AbortController();
      supportingSummaryControllers.current[kind] = controller;
      const generation = supportingSummaryGenerations.current[kind] + 1;
      supportingSummaryGenerations.current[kind] = generation;
      const fence: TodaySummaryRequestFence = {
        generation,
        kind,
        ownerUserId: expectedOwnerUserIdRef.current,
        sessionEpoch: sessionEpochRef.current,
        profileRevision: profileRevisionRef.current,
        profileTimeZone: profileTimeZoneRef.current,
        localDate: requested,
        refreshKey: supportingSummaryRefreshKeyRef.current,
      };
      const isCurrent = () =>
        supportingSummaryControllers.current[kind] === controller &&
        !controller.signal.aborted &&
        !privateUiClosed.current &&
        todaySummaryRequestMatches(
          fence,
          {
            kind,
            ownerUserId: expectedOwnerUserIdRef.current,
            sessionEpoch: sessionEpochRef.current,
            profileRevision: profileRevisionRef.current,
            profileTimeZone: profileTimeZoneRef.current,
            localDate: dateRef.current,
            refreshKey: supportingSummaryRefreshKeyRef.current,
          },
          supportingSummaryGenerations.current[kind],
        );
      const accept = (replacement: TodaySummaryReplacement) => {
        setSupportingSummaries((current) =>
          acceptTodaySupportingSummary(
            current,
            fence,
            {
              kind,
              ownerUserId: expectedOwnerUserIdRef.current,
              sessionEpoch: sessionEpochRef.current,
              profileRevision: profileRevisionRef.current,
              profileTimeZone: profileTimeZoneRef.current,
              localDate: dateRef.current,
              refreshKey: supportingSummaryRefreshKeyRef.current,
            },
            supportingSummaryGenerations.current[kind],
            replacement,
          ),
        );
      };

      setSupportingSummaries((current) => beginTodaySupportingSummaryLoad(current, fence));

      try {
        const response = await fetch(
          apiUrl(apiBase, todaySupportingSummaryPath(kind, requested)).toString(),
          {
            headers:
              kind === "activity"
                ? {
                    ...authenticatedHeaders(accessToken),
                    "x-expected-owner-user-id": fence.ownerUserId,
                  }
                : authenticatedHeaders(accessToken),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!isCurrent()) return;
        if (response.status === 401) {
          await closeForUnauthorized();
          return;
        }
        const body = await jsonBody(response);
        if (!isCurrent()) return;
        if (kind === "activity" && isTodayActivityOwnerChangedProblem(response.status, body)) {
          await closeForUnauthorized();
          return;
        }
        if (!response.ok) {
          throw new Error(
            responseError(
              body,
              kind === "hydration"
                ? "The water summary could not be loaded."
                : "The activity summary could not be loaded.",
            ),
          );
        }

        if (kind === "hydration") {
          const day = parseHydrationDay(body);
          if (day.localDate !== fence.localDate || day.timeZone !== fence.profileTimeZone) {
            throw new TypeError("The water summary returned another profile-local day.");
          }
          if (!isCurrent()) return;
          accept({ kind: "hydration", card: hydrationTodaySummary(day) });
        } else {
          const day = parseActivityDay(body);
          if (day.localDate !== fence.localDate || day.timeZone !== fence.profileTimeZone) {
            throw new TypeError("The activity summary returned another profile-local day.");
          }
          if (!isCurrent()) return;
          accept({ kind: "activity", card: activityTodaySummary(day) });
        }
      } catch (caught) {
        if (!isCurrent()) return;
        const message =
          caught instanceof Error
            ? caught.message
            : kind === "hydration"
              ? "The water summary could not be loaded."
              : "The activity summary could not be loaded.";
        if (kind === "hydration") {
          accept({ kind: "hydration", card: todaySummaryError(message) });
        } else {
          accept({ kind: "activity", card: todaySummaryError(message) });
        }
      } finally {
        if (supportingSummaryControllers.current[kind] === controller) {
          supportingSummaryControllers.current[kind] = null;
        }
      }
    },
    [accessToken, apiBase, closeForUnauthorized],
  );

  const transitionCommittedDate = useCallback((next: string, forceReload = false) => {
    if (privateUiClosed.current || !isLocalDate(next)) return;
    setDateDraft(next);
    const dateChanged = next !== dateRef.current;
    if (!dateChanged && !forceReload) return;
    viewEpoch.current += 1;
    activeMutation.current = null;
    requestGeneration.current += 1;
    loadController.current?.abort();
    for (const kind of ["hydration", "activity"] as const) {
      supportingSummaryGenerations.current[kind] += 1;
      supportingSummaryControllers.current[kind]?.abort();
      supportingSummaryControllers.current[kind] = null;
    }
    pageRequestBusy.current = false;
    setBusyEntry(null);
    setEditor(null);
    setDiaryPage(null);
    setPageState("idle");
    setState("loading");
    setSupportingSummaries(loadingTodaySupportingSummaries());
    setMessage(`Loading ${next}…`);
    if (dateChanged) setDate(next);
    else setRouteReloadGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    const generation = diaryRouteTransitionGeneration(requestedDate, refreshKey);
    if (generation === null) {
      appliedRouteGeneration.current = null;
      return;
    }
    if (generation === appliedRouteGeneration.current || !requestedDate) return;
    appliedRouteGeneration.current = generation;
    transitionCommittedDate(requestedDate, true);
  }, [refreshKey, requestedDate, transitionCommittedDate]);

  useEffect(
    () =>
      subscribeQuickAddReceipts((receipt) => {
        const current = dateRef.current;
        if (
          privateUiClosed.current ||
          !isLocalDate(current) ||
          !receipt.mutation.affectedDays.some((day) => day.localDate === current)
        ) {
          return;
        }
        transitionCommittedDate(current, true);
      }),
    [subscribeQuickAddReceipts, transitionCommittedDate],
  );

  useEffect(() => {
    void quickAddOutboxState;
    let active = true;
    void quickAddOutboxController
      .pendingDependencies()
      .then((dependencies) => {
        if (!active || privateUiClosed.current) return;
        setPendingCorrectionEntries(new Set(dependencies.correctedEntryIds));
        setPendingReorderDates(new Set(dependencies.reorderedLocalDates));
        setPendingDiaryDates(new Set(dependencies.pendingLocalDates));
      })
      .catch(() => {
        if (!active) return;
        setPendingCorrectionEntries(new Set());
        setPendingReorderDates(new Set());
        setPendingDiaryDates(new Set());
      });
    return () => {
      active = false;
    };
  }, [quickAddOutboxController, quickAddOutboxState]);

  useEffect(() => {
    void routeReloadGeneration;
    if (isLocalDate(date)) void load(date);
    return () => {
      requestGeneration.current += 1;
      loadController.current?.abort();
      pageRequestBusy.current = false;
    };
  }, [date, load, routeReloadGeneration]);

  useEffect(() => {
    void supportingSummaryRefreshKey;
    void supportingSummaryIdentityKey;
    if (!privateUiClosed.current && isLocalDate(date)) {
      void loadSupportingSummary("hydration", date);
      void loadSupportingSummary("activity", date);
    }
    return () => {
      for (const kind of ["hydration", "activity"] as const) {
        supportingSummaryGenerations.current[kind] += 1;
        supportingSummaryControllers.current[kind]?.abort();
        supportingSummaryControllers.current[kind] = null;
      }
    };
  }, [date, loadSupportingSummary, supportingSummaryIdentityKey, supportingSummaryRefreshKey]);

  useEffect(() => {
    if (!groupEditorOpen && !groupBusy) {
      setGroupDraft(diaryGroups.map((group) => ({ ...group })));
    }
  }, [diaryGroups, groupBusy, groupEditorOpen]);

  useEffect(() => {
    const previous = previousProfileIdentity.current;
    if (
      previous.expectedOwnerUserId === expectedOwnerUserId &&
      previous.sessionEpoch === sessionEpoch
    ) {
      return;
    }
    previousProfileIdentity.current = { expectedOwnerUserId, sessionEpoch };
    profileController.current?.abort();
    profileController.current = null;
    setGroupBusy(false);
    setGroupEditorOpen(false);
    setGroupDraft(diaryGroups.map((group) => ({ ...group })));
    setMessage("The signed-in account changed. Diary group settings were closed.");
  }, [diaryGroups, expectedOwnerUserId, sessionEpoch]);

  useEffect(
    () => () => {
      privateUiClosed.current = true;
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      profileController.current?.abort();
      for (const kind of ["hydration", "activity"] as const) {
        supportingSummaryGenerations.current[kind] += 1;
        supportingSummaryControllers.current[kind]?.abort();
        supportingSummaryControllers.current[kind] = null;
      }
    },
    [],
  );

  function beginMutation(sourceDate: string, busyKey: string): MutationOwner {
    const token = mutationSequence.current + 1;
    mutationSequence.current = token;
    activeMutation.current = token;
    setBusyEntry(busyKey);
    return { sourceDate, token, viewEpoch: viewEpoch.current };
  }

  function finishMutation(owner: MutationOwner): void {
    if (activeMutation.current !== owner.token) return;
    activeMutation.current = null;
    setBusyEntry(null);
  }

  function selectDate(next: string) {
    if (privateUiClosed.current) return;
    if (!isLocalDate(next)) {
      setDateDraft(dateRef.current);
      setMessage("Date must use YYYY-MM-DD and be a real calendar day.");
      return;
    }
    transitionCommittedDate(next);
  }

  async function loadMore() {
    const current = diaryPage;
    const nextCursor = current?.page.nextCursor;
    if (
      privateUiClosed.current ||
      !current ||
      current.data.localDate !== date ||
      nextCursor === null ||
      nextCursor === undefined ||
      pageRequestBusy.current
    ) {
      return;
    }
    const requested = date;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    pageRequestBusy.current = true;
    const controller = new AbortController();
    loadController.current = controller;
    const isCurrent = () =>
      requestGeneration.current === generation &&
      loadController.current === controller &&
      !controller.signal.aborted &&
      dateRef.current === requested;
    setPageState("loading");
    setMessage(`Loading more entries for ${requested}…`);
    try {
      const response = await fetch(
        apiUrl(apiBase, diaryPagePath(requested, nextCursor)).toString(),
        {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        },
      );
      if (!isCurrent()) return;
      if (response.status === 401) {
        await closeForUnauthorized();
        return;
      }
      const body = await jsonBody(response);
      if (!isCurrent()) return;
      if (isDiaryPageStaleProblem(response.status, body)) {
        setDiaryPage(null);
        setPageState("idle");
        await load(requested, true);
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
    } catch (caught) {
      if (!isCurrent()) return;
      setPageState("error");
      setMessage(
        `${caught instanceof Error ? caught.message : "More diary entries could not be loaded."} Loaded entries remain available; press Load more to retry.`,
      );
    } finally {
      if (requestGeneration.current === generation && loadController.current === controller) {
        pageRequestBusy.current = false;
      }
    }
  }

  async function save() {
    if (privateUiClosed.current || !editor || !diary) return;
    if (!isPositiveDecimal(editor.quantity)) {
      setMessage("Quantity must be a positive decimal number.");
      return;
    }
    const entry = diary.entries.find((candidate) => candidate.id === editor.entryId);
    if (!entry) {
      setEditor(null);
      setMessage("That entry is no longer present. Fresh diary data is required.");
      return;
    }
    if (!diaryEditorOriginMatches(editor, diary, entry, profileTimeZone)) {
      setEditor(null);
      setMessage(
        "The diary changed after editing began. Review the fresh entry before editing again.",
      );
      return;
    }
    let note: string | null | undefined;
    if (editor.note !== (entry.note ?? "")) {
      try {
        note = diaryNoteFromDraft(editor.note);
      } catch (caught) {
        setMessage(caught instanceof Error ? caught.message : "The private note is invalid.");
        return;
      }
    }
    const timestampChanged =
      editor.localDate !== editor.originalEntryLocalDate ||
      editor.localTime !== editor.originalLocalTime;
    let occurredAt: string | undefined;
    if (timestampChanged) {
      try {
        occurredAt = localDateTimeToInstant(
          editor.localDate,
          editor.localTime,
          editor.originTimeZone,
        );
      } catch (caught) {
        setMessage(caught instanceof Error ? caught.message : "The local time is invalid.");
        return;
      }
    }
    const body: DiaryEntryUpdateRequestBody = {
      portion:
        entry.portion.kind === "serving"
          ? entry.entryKind === "food"
            ? { kind: "serving", servingId: entry.portion.servingId, amount: editor.quantity }
            : { kind: "serving", amount: editor.quantity }
          : { kind: "grams", grams: editor.quantity },
      mealSlot: editor.mealSlot,
      ...(occurredAt ? { occurredAt } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    const owner = beginMutation(editor.originLocalDate, editor.entryId);
    setMessage("Securing this diary edit on your device before sending…");
    try {
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "update",
        entryId: entry.id,
        expectedEntryRevision: editor.originEntryRevision,
        entryName: entryName(entry),
        portionLabel: entryPortionLabel(entry),
        localDate: editor.originLocalDate,
        mealSlot: entry.mealSlot,
        body,
      });
      setEditor(null);
      setMessage(
        `${entryName(entry)} changes are queued securely. The visible entry and totals stay unchanged until the server confirms the exact edit.`,
      );
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (caught) {
      if (caught instanceof QuickAddEnqueueAmbiguousError) {
        setEditor(null);
        void quickAddOutboxController.requestDrain(caught.operationId);
        setMessage(
          "Secure storage could not confirm whether this edit was queued. Do not save it again until the queue status recovers.",
        );
      } else if (caught instanceof DiaryOutboxCapacityError) {
        setMessage(
          "This private note makes the protected diary envelope larger than the reviewed 1,600-byte slot. Shorten the note; it was not truncated or sent online.",
        );
      } else if (caught instanceof DiaryOutboxDependencyError) {
        setMessage(`${caught.message} Wait for it to finish or resolve the blocked queue head.`);
      } else {
        setMessage(
          caught instanceof Error
            ? caught.message
            : "The edit was not queued. Refresh this diary and try again.",
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function remove(entry: DiaryEntry) {
    if (privateUiClosed.current || !diary) return;
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage("Securing this deletion on your device before sending…");
    try {
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "delete",
        entryId: entry.id,
        expectedEntryRevision: entry.revision,
        entryName: entryName(entry),
        portionLabel: entryPortionLabel(entry),
        localDate: diary.localDate,
        mealSlot: entry.mealSlot,
      });
      setMessage(
        `${entryName(entry)} is queued for deletion. It remains visible and counted until the server confirms the exact revision.`,
      );
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (caught) {
      if (caught instanceof QuickAddEnqueueAmbiguousError) {
        void quickAddOutboxController.requestDrain(caught.operationId);
        setMessage(
          "Secure storage could not confirm whether the deletion was queued. Do not delete again until queue status recovers.",
        );
      } else if (caught instanceof DiaryOutboxDependencyError) {
        setMessage(`${caught.message} Wait for it to finish or resolve the blocked queue head.`);
      } else {
        setMessage(
          caught instanceof Error
            ? caught.message
            : "The deletion was not queued. Refresh this diary and try again.",
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function repeat(entry: DiaryEntry) {
    if (privateUiClosed.current || !diary) return;
    const now = new Date();
    const targetDate = localDateInTimeZone(now, profileTimeZone);
    const occurredAt = quickAddOccurredAt(targetDate, profileTimeZone, now);
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Securing a repeat of the pinned ${entryName(entry)} version…`);
    try {
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "repeat",
        entryId: entry.id,
        expectedEntryRevision: entry.revision,
        entryName: entryName(entry),
        portionLabel: entryPortionLabel(entry),
        localDate: targetDate,
        sourceLocalDate: diary.localDate,
        mealSlot: entry.mealSlot,
        occurredAt,
        targetMealSlot: entry.mealSlot,
      });
      setMessage(
        `${entryName(entry)} is queued securely for ${targetDate}. It is not counted until the server confirms the pinned source revision.`,
      );
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (caught) {
      if (caught instanceof QuickAddEnqueueAmbiguousError) {
        void quickAddOutboxController.requestDrain(caught.operationId);
        setMessage(
          "Secure storage could not confirm whether the repeat was queued. Do not repeat it again until queue status recovers.",
        );
      } else if (caught instanceof DiaryOutboxDependencyError) {
        setMessage(`${caught.message} Wait for it to finish or resolve the blocked queue head.`);
      } else {
        setMessage(
          caught instanceof Error
            ? caught.message
            : "The repeat was not queued. Refresh this diary and try again.",
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function reorder(entry: DiaryEntry, direction: "up" | "down") {
    if (
      privateUiClosed.current ||
      !diary ||
      !diaryPage ||
      diaryPage.page.nextCursor !== null ||
      diary.entries.length !== diaryPage.page.totalEntries
    ) {
      setMessage("Load the complete diary day before changing entry order.");
      return;
    }
    const originDay = diary;
    const plan = buildDiaryReorderPlan(originDay, entry.id, direction);
    if (!plan) return;
    const owner = beginMutation(originDay.localDate, `order:${entry.id}`);
    setMessage("Securing the complete meal order on your device before sending…");
    try {
      const digestEvidence = await bindDiaryReorderDigestEvidence(originDay, plan, (payload) =>
        digestStringAsync(CryptoDigestAlgorithm.SHA256, payload),
      );
      if (
        privateUiClosed.current ||
        viewEpoch.current !== owner.viewEpoch ||
        diaryPage.data.revision !== originDay.revision ||
        diaryPage.data.orderDigest !== originDay.orderDigest ||
        dateRef.current !== originDay.localDate
      ) {
        setMessage(
          "The diary changed while preparing the order. Reload and choose the move again.",
        );
        return;
      }
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "reorder",
        localDate: originDay.localDate,
        expectedDayRevision: originDay.revision,
        dayTimeZone: originDay.timeZone,
        expectedOrderDigest: digestEvidence.expectedOrderDigest,
        expectedResultOrderDigest: digestEvidence.expectedResultOrderDigest,
        groups: plan.groups,
      });
      setMessage(
        "The complete meal order is queued securely. Entries stay in their confirmed order until the server accepts the atomic move.",
      );
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (caught) {
      if (caught instanceof DiaryOrderBaselineMismatchError) {
        setMessage(
          "The complete loaded day did not match its authoritative order proof. Nothing was queued; reload the diary before choosing the move again.",
        );
      } else if (caught instanceof QuickAddEnqueueAmbiguousError) {
        void quickAddOutboxController.requestDrain(caught.operationId);
        setMessage(
          "Secure storage could not confirm whether the order was queued. Do not reorder again until queue status recovers.",
        );
      } else if (caught instanceof DiaryOutboxDependencyError) {
        setMessage(`${caught.message} Wait for it to finish or resolve the blocked queue head.`);
      } else {
        setMessage(
          caught instanceof Error
            ? caught.message
            : "The meal order was not queued. Reload this diary and try again.",
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  function confirmRemove(entry: DiaryEntry) {
    Alert.alert(
      "Delete diary entry?",
      `${entryName(entry)} will be removed from ${diaryGroupLabel(diaryGroups, entry.mealSlot)}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void remove(entry) },
      ],
    );
  }

  function openGroupEditor() {
    setGroupDraft(diaryGroups.map((group) => ({ ...group })));
    setGroupEditorOpen(true);
  }

  function profileRequestIsCurrent(
    controller: AbortController,
    initiatingOwnerUserId: string,
    initiatingSessionEpoch: number,
  ): boolean {
    return (
      !privateUiClosed.current &&
      profileController.current === controller &&
      !controller.signal.aborted &&
      profileRequestIdentityMatches(
        expectedOwnerUserIdRef.current,
        sessionEpochRef.current,
        initiatingOwnerUserId,
        initiatingSessionEpoch,
      )
    );
  }

  async function refreshGroupsAfterConflict(
    controller: AbortController,
    initiatingOwnerUserId: string,
    initiatingSessionEpoch: number,
  ): Promise<void> {
    if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
      return;
    }
    const response = await fetch(apiUrl(apiBase, "/v1/profile").toString(), {
      headers: authenticatedHeaders(accessToken),
      signal: controller.signal,
    });
    if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
      return;
    }
    if (response.status === 401) {
      await closeForUnauthorized();
      return;
    }
    const body = await jsonBody(response);
    if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
      return;
    }
    if (!response.ok) {
      throw new Error(responseError(body, "Fresh diary groups could not be loaded."));
    }
    const profile = parseProfileResponse(body);
    if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
      return;
    }
    onProfileUpdated(profile);
    setGroupDraft(profile.diaryGroups.map((group) => ({ ...group })));
    setGroupEditorOpen(false);
    setMessage(
      "Diary groups changed elsewhere. Fresh names and order were loaded; review them before editing again.",
    );
  }

  async function saveDiaryGroups() {
    if (privateUiClosed.current || groupBusy) return;
    const renderedIdentity = previousProfileIdentity.current;
    if (
      !profileRequestIdentityMatches(
        expectedOwnerUserId,
        sessionEpoch,
        renderedIdentity.expectedOwnerUserId,
        renderedIdentity.sessionEpoch,
      )
    ) {
      return;
    }
    let normalized: readonly DiaryGroup[];
    try {
      normalized = normalizeDiaryGroups(groupDraft);
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : "The diary group settings are invalid.",
      );
      return;
    }
    const initiatingOwnerUserId = expectedOwnerUserId;
    const initiatingSessionEpoch = sessionEpoch;
    const controller = new AbortController();
    profileController.current?.abort();
    profileController.current = controller;
    setGroupBusy(true);
    setMessage("Saving diary group names and order…");
    try {
      const response = await fetch(apiUrl(apiBase, "/v1/profile").toString(), {
        method: "PATCH",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "if-match": `"${profileRevision}"`,
        }),
        body: JSON.stringify({
          diaryGroups: normalized,
          expectedOwnerUserId: initiatingOwnerUserId,
        }),
        signal: controller.signal,
      });
      if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
        return;
      }
      if (response.status === 401) {
        await closeForUnauthorized();
        return;
      }
      const body = await jsonBody(response);
      if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
        return;
      }
      if (isProfileOwnerChangedProblem(response.status, body)) {
        await closeForUnauthorized();
        return;
      }
      if (response.status === 412) {
        await refreshGroupsAfterConflict(controller, initiatingOwnerUserId, initiatingSessionEpoch);
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(body, "Diary groups could not be saved."));
      }
      const profile = parseProfileResponse(body);
      if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
        return;
      }
      onProfileUpdated(profile);
      setGroupDraft(profile.diaryGroups.map((group) => ({ ...group })));
      setGroupEditorOpen(false);
      setMessage(
        "Diary group names and order saved. Existing entries stayed in their original canonical groups.",
      );
      AccessibilityInfo.announceForAccessibility("Diary group names and order saved.");
    } catch (caught) {
      if (!profileRequestIsCurrent(controller, initiatingOwnerUserId, initiatingSessionEpoch)) {
        return;
      }
      setMessage(
        `${caught instanceof Error ? caught.message : "Diary groups could not be saved."} Refresh the profile before retrying if the result is uncertain.`,
      );
    } finally {
      if (profileController.current === controller) {
        profileController.current = null;
        setGroupBusy(false);
      }
    }
  }

  async function retryQueuedDiaryLogs() {
    if (outboxAction !== null) return;
    const current = quickAddOutboxController.getState();
    setOutboxAction("retry");
    setMessage("Retrying the exact oldest queued diary change…");
    try {
      if (current.status === "blocked") {
        await quickAddOutboxController.retryBlockedHead(current.operationId);
      } else {
        await quickAddOutboxController.requestDrain();
      }
      const after = quickAddOutboxController.getState();
      if (after.status === "idle")
        setMessage("All queued diary changes were confirmed or removed.");
      else if (after.status === "blocked")
        setMessage("The oldest diary change is still blocked. Review it before retrying again.");
      else setMessage("The retry finished; retained diary changes remain shown below.");
    } catch {
      setMessage(
        "The exact retry could not be completed. The queued diary change remains retained.",
      );
    } finally {
      setOutboxAction(null);
    }
  }

  async function discardBlockedDiaryLog(operationId: string, itemName: string) {
    if (outboxAction !== null) return;
    setOutboxAction("discard");
    setMessage(`Discarding only the blocked ${itemName} change…`);
    try {
      await quickAddOutboxController.discardBlockedHead(operationId);
      setMessage(`The blocked ${itemName} change was discarded. No server result was applied.`);
    } catch {
      setMessage("Discard could not be confirmed. The exact queued change remains retained.");
    } finally {
      setOutboxAction(null);
    }
  }

  function confirmDiscardBlockedDiaryLog(
    blocked: Extract<QuickAddOutboxControllerState, { status: "blocked" }>,
  ) {
    const target =
      blocked.operationKind === "reorder"
        ? `the whole-day order on ${blocked.localDate}`
        : `the ${diaryGroupLabel(diaryGroups, blocked.mealSlot)} change on ${blocked.localDate}`;
    Alert.alert(
      "Discard blocked diary change?",
      `This permanently removes only the queued ${blocked.foodName} ${target}. Reload and authorize it again if still needed. Later queued changes stay in order.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard queued change",
          style: "destructive",
          onPress: () => void discardBlockedDiaryLog(blocked.operationId, blocked.foodName),
        },
      ],
    );
  }

  const activeTimeZone = profileTimeZone;
  const hydrationSummaryCard = todaySummaryCardForRender(
    supportingSummaries.hydration,
    {
      kind: "hydration",
      ownerUserId: expectedOwnerUserId,
      sessionEpoch,
      profileRevision,
      profileTimeZone,
      localDate: date,
      refreshKey: supportingSummaryRefreshKey,
    },
    supportingSummaryGenerations.current.hydration,
  );
  const activitySummaryCard = todaySummaryCardForRender(
    supportingSummaries.activity,
    {
      kind: "activity",
      ownerUserId: expectedOwnerUserId,
      sessionEpoch,
      profileRevision,
      profileTimeZone,
      localDate: date,
      refreshKey: supportingSummaryRefreshKey,
    },
    supportingSummaryGenerations.current.activity,
  );
  const completeDayLoaded =
    diary !== null &&
    diaryPage !== null &&
    diaryPage.page.nextCursor === null &&
    diary.entries.length === diaryPage.page.totalEntries;
  const durableQueueUnavailable =
    quickAddOutboxState.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS ||
    quickAddOutboxState.status === "closed" ||
    quickAddOutboxState.status === "owner_mismatch" ||
    (quickAddOutboxState.status === "unavailable" &&
      (quickAddOutboxState.reason === "storage" || quickAddOutboxState.reason === "credential"));
  const repeatTargetDate = localDateInTimeZone(new Date(), profileTimeZone);

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View accessibilityRole="toolbar" style={styles.workspaceNav}>
          <Pressable accessibilityRole="button" onPress={onRecipes}>
            <Text style={styles.workspaceLink}>Recipes</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onGoals}>
            <Text style={styles.workspaceLink}>Goals</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onReports}>
            <Text style={styles.workspaceLink}>Reports</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onHydration(date)}>
            <Text style={styles.workspaceLink}>Hydration</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onActivity(date)}>
            <Text style={styles.workspaceLink}>Activity</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onHealth}>
            <Text style={styles.workspaceLink}>Health & privacy</Text>
          </Pressable>
        </View>
        <Text style={styles.kicker}>PRIVATE LOCAL-DAY DIARY</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {date === localDateInTimeZone(new Date(), activeTimeZone) ? "Today" : date}
        </Text>
        <Text style={styles.zone}>{activeTimeZone}</Text>
        <View style={styles.dateRow}>
          <Pressable
            accessibilityLabel="Previous day"
            accessibilityRole="button"
            accessibilityState={{ disabled: busyEntry !== null }}
            disabled={busyEntry !== null}
            onPress={() => selectDate(shiftLocalDate(date, -1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>←</Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Diary date YYYY-MM-DD"
            autoCapitalize="none"
            editable={busyEntry === null}
            maxLength={10}
            onEndEditing={(event) => selectDate(event.nativeEvent.text)}
            onChangeText={setDateDraft}
            onSubmitEditing={(event) => selectDate(event.nativeEvent.text)}
            returnKeyType="done"
            style={styles.dateInput}
            value={dateDraft}
          />
          <Pressable
            accessibilityLabel="Next day"
            accessibilityRole="button"
            accessibilityState={{ disabled: busyEntry !== null }}
            disabled={busyEntry !== null}
            onPress={() => selectDate(shiftLocalDate(date, 1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>→</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busyEntry !== null }}
          disabled={busyEntry !== null}
          onPress={() => selectDate(localDateInTimeZone(new Date(), activeTimeZone))}
          style={styles.todayButton}
        >
          <Text style={styles.todayText}>Jump to today</Text>
        </Pressable>

        {isLocalDate(date) ? (
          <View accessibilityLabel={`Daily overview for ${date}`} style={styles.supportingOverview}>
            <Text style={styles.kicker}>COORDINATED DAILY OVERVIEW</Text>
            <Text accessibilityRole="header" style={styles.supportingOverviewTitle}>
              Water and activity
            </Text>
            <Text style={styles.supportingOverviewIntro}>
              Each private summary loads independently for this same profile-local date.
            </Text>
            <View style={styles.supportingGrid}>
              <View style={styles.supportingCard}>
                <Text accessibilityRole="header" style={styles.supportingCardTitle}>
                  Plain water
                </Text>
                {hydrationSummaryCard.status === "loading" ? (
                  <View style={styles.supportingStatusRow}>
                    <ActivityIndicator
                      accessibilityLabel={`Loading plain-water summary for ${date}`}
                      color={palette.forest}
                    />
                    <Text style={styles.supportingStatus}>Loading water logged…</Text>
                  </View>
                ) : hydrationSummaryCard.status === "error" ? (
                  <>
                    <Text accessibilityRole="alert" style={[styles.supportingStatus, styles.error]}>
                      {hydrationSummaryCard.message}
                    </Text>
                    <Pressable
                      accessibilityLabel={`Retry plain-water summary for ${date}`}
                      accessibilityRole="button"
                      onPress={() => void loadSupportingSummary("hydration", date)}
                      style={styles.supportingRetry}
                    >
                      <Text style={styles.secondaryText}>Retry water summary</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Text accessibilityLiveRegion="polite" style={styles.supportingAmount}>
                      {hydrationSummaryCard.summary.totalMilliliters.toLocaleString("en-US")} mL
                    </Text>
                    <Text style={styles.supportingStatus}>
                      {hydrationSummaryCard.status === "empty"
                        ? "No plain-water entries on this date."
                        : `${hydrationSummaryCard.summary.entryCount} ${hydrationSummaryCard.summary.entryCount === 1 ? "entry" : "entries"} on this date.`}
                    </Text>
                  </>
                )}
                <Pressable
                  accessibilityLabel={`View or log plain water for ${date}`}
                  accessibilityRole="button"
                  onPress={() => onHydration(date)}
                  style={styles.supportingAction}
                >
                  <Text style={styles.primaryText}>View or log water</Text>
                </Pressable>
              </View>

              <View style={styles.supportingCard}>
                <Text accessibilityRole="header" style={styles.supportingCardTitle}>
                  Activity
                </Text>
                {activitySummaryCard.status === "loading" ? (
                  <View style={styles.supportingStatusRow}>
                    <ActivityIndicator
                      accessibilityLabel={`Loading activity summary for ${date}`}
                      color={palette.forest}
                    />
                    <Text style={styles.supportingStatus}>Loading recorded duration…</Text>
                  </View>
                ) : activitySummaryCard.status === "error" ? (
                  <>
                    <Text accessibilityRole="alert" style={[styles.supportingStatus, styles.error]}>
                      {activitySummaryCard.message}
                    </Text>
                    <Pressable
                      accessibilityLabel={`Retry activity summary for ${date}`}
                      accessibilityRole="button"
                      onPress={() => void loadSupportingSummary("activity", date)}
                      style={styles.supportingRetry}
                    >
                      <Text style={styles.secondaryText}>Retry activity summary</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Text accessibilityLiveRegion="polite" style={styles.supportingAmount}>
                      {activitySummaryCard.summary.totalDurationMinutes.toLocaleString("en-US")} min
                    </Text>
                    <Text style={styles.supportingStatus}>
                      {activitySummaryCard.status === "empty"
                        ? "No activities recorded on this local start date."
                        : `${activitySummaryCard.summary.entryCount} ${activitySummaryCard.summary.entryCount === 1 ? "activity" : "activities"} on this local start date.`}
                    </Text>
                  </>
                )}
                <Pressable
                  accessibilityLabel={`View or log activity for ${date}`}
                  accessibilityRole="button"
                  onPress={() => onActivity(date)}
                  style={styles.supportingAction}
                >
                  <Text style={styles.primaryText}>View or log activity</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: groupEditorOpen, disabled: groupBusy }}
          disabled={groupBusy}
          onPress={() => (groupEditorOpen ? setGroupEditorOpen(false) : openGroupEditor())}
          style={styles.groupSettingsButton}
        >
          <Text style={styles.secondaryText}>
            {groupEditorOpen ? "Close diary group settings" : "Customize diary groups"}
          </Text>
        </Pressable>

        {groupEditorOpen ? (
          <View style={styles.groupSettingsCard}>
            <Text accessibilityRole="header" style={styles.groupSettingsTitle}>
              Diary groups
            </Text>
            <Text style={styles.groupSettingsHelp}>
              Rename and reorder the four diary sections. Entries keep their canonical destinations,
              so changing a name never rewrites diary history.
            </Text>
            {groupDraft.map((group, index) => (
              <View key={group.mealSlot} style={styles.groupSettingsRow}>
                <TextInput
                  accessibilityLabel={`Name for diary group ${index + 1}`}
                  editable={!groupBusy}
                  maxLength={120}
                  onChangeText={(label) =>
                    setGroupDraft((current) =>
                      current.map((candidate) =>
                        candidate.mealSlot === group.mealSlot ? { ...candidate, label } : candidate,
                      ),
                    )
                  }
                  style={[styles.input, styles.groupNameInput]}
                  value={group.label}
                />
                <Pressable
                  accessibilityLabel={`Move ${group.label || `group ${index + 1}`} up`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: groupBusy || index === 0 }}
                  disabled={groupBusy || index === 0}
                  onPress={() =>
                    setGroupDraft((current) => moveDiaryGroup(current, group.mealSlot, -1))
                  }
                  style={styles.groupMoveButton}
                >
                  <Text style={styles.secondaryText}>↑</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={`Move ${group.label || `group ${index + 1}`} down`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: groupBusy || index === groupDraft.length - 1 }}
                  disabled={groupBusy || index === groupDraft.length - 1}
                  onPress={() =>
                    setGroupDraft((current) => moveDiaryGroup(current, group.mealSlot, 1))
                  }
                  style={styles.groupMoveButton}
                >
                  <Text style={styles.secondaryText}>↓</Text>
                </Pressable>
              </View>
            ))}
            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: groupBusy }}
                disabled={groupBusy}
                onPress={() => void saveDiaryGroups()}
                style={styles.primarySmall}
              >
                <Text style={styles.primaryText}>{groupBusy ? "Saving…" : "Save groups"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: groupBusy }}
                disabled={groupBusy}
                onPress={() => setGroupDraft(resetDiaryGroups())}
                style={styles.secondarySmall}
              >
                <Text style={styles.secondaryText}>Use defaults</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, (state === "error" || pageState === "error") && styles.error]}
        >
          {message}
        </Text>
        {queuedMessage ? (
          <View style={styles.queueCard}>
            <Text accessibilityLiveRegion="polite" style={styles.queueStatus}>
              {queuedMessage}
            </Text>
            {quickAddOutboxState.status === "blocked" ? (
              <View style={styles.queueActions}>
                {quickAddOutboxState.httpStatus !== 412 &&
                quickAddOutboxState.blockedReason !== "time_zone_changed" ? (
                  <Pressable
                    accessibilityLabel={`Retry queued ${quickAddOutboxState.foodName} change exactly`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: outboxAction !== null }}
                    disabled={outboxAction !== null}
                    onPress={() => void retryQueuedDiaryLogs()}
                    style={[styles.queueAction, outboxAction !== null && styles.disabled]}
                  >
                    <Text style={styles.secondaryText}>
                      {outboxAction === "retry" ? "Retrying…" : "Retry exact change"}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel={`Discard only queued ${quickAddOutboxState.foodName} change`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: outboxAction !== null }}
                  disabled={outboxAction !== null}
                  onPress={() => confirmDiscardBlockedDiaryLog(quickAddOutboxState)}
                  style={[
                    styles.queueAction,
                    styles.queueDangerAction,
                    outboxAction !== null && styles.disabled,
                  ]}
                >
                  <Text style={styles.queueDangerText}>
                    {outboxAction === "discard" ? "Discarding…" : "Discard only this change"}
                  </Text>
                </Pressable>
              </View>
            ) : (quickAddOutboxState.pendingCount > 0 &&
                (quickAddOutboxState.status === "pending" ||
                  (quickAddOutboxState.status === "unavailable" &&
                    quickAddOutboxState.reason !== "credential"))) ||
              (quickAddOutboxState.status === "unavailable" &&
                quickAddOutboxState.reason === "storage") ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: outboxAction !== null }}
                disabled={outboxAction !== null}
                onPress={() => void retryQueuedDiaryLogs()}
                style={[styles.queueAction, outboxAction !== null && styles.disabled]}
              >
                <Text style={styles.secondaryText}>
                  {outboxAction === "retry" ? "Retrying…" : "Retry queued changes"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {state === "loading" ? <ActivityIndicator color={palette.forest} /> : null}
        {state === "error" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busyEntry !== null }}
            disabled={busyEntry !== null}
            onPress={() => void load(date)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        ) : null}

        {diary && diaryPage && state === "ready" ? (
          <Text accessibilityLiveRegion="polite" style={styles.pageCount}>
            {diary.entries.length} of {diaryPage.page.totalEntries} entries loaded. Nutrition totals
            include all {diaryPage.page.totalEntries}.
          </Text>
        ) : null}

        {diary && diaryPage?.page.totalEntries === 0 && state === "ready" ? (
          <View style={styles.emptyCard}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>
              Start with a food you actually ate.
            </Text>
            <Text style={styles.emptyBody}>
              Unknown nutrients remain unknown; they are never filled with zero.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                onSearch(date, diaryGroups[0]?.mealSlot ?? "breakfast", profileTimeZone)
              }
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>Find a food</Text>
            </Pressable>
          </View>
        ) : null}

        {diary && diary.entries.length > 0
          ? diaryGroups.map(({ mealSlot: meal, label }) => {
              const entries = diary.entries.filter((entry) => entry.mealSlot === meal);
              return (
                <View key={meal} style={styles.mealSection}>
                  <View style={styles.mealHeading}>
                    <Text accessibilityRole="header" style={styles.mealTitle}>
                      {label}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onSearch(date, meal, profileTimeZone)}
                    >
                      <Text style={styles.addLink}>Add food</Text>
                    </Pressable>
                  </View>
                  {entries.length === 0 ? (
                    <Text style={styles.emptyMeal}>
                      {diaryPage?.page.nextCursor
                        ? "No entries loaded for this meal yet"
                        : "No entries"}
                    </Text>
                  ) : (
                    entries.map((entry, entryIndex) => (
                      <View key={entry.id} style={styles.entryCard}>
                        <Text style={styles.entryTitle}>{entryName(entry)}</Text>
                        {entry.entryKind === "food" && entry.food.brandName ? (
                          <Text style={styles.entryBrand}>{entry.food.brandName}</Text>
                        ) : null}
                        {entry.entryKind === "recipe" ? (
                          <Text style={styles.entryBrand}>
                            Recipe version {entry.recipe.versionNumber}
                          </Text>
                        ) : null}
                        <Text style={styles.entryMeta}>
                          {entry.portion.kind === "serving"
                            ? `${entry.portion.amount} ${entry.portion.servingLabel}`
                            : `${entry.portion.grams} g`}{" "}
                          · {entry.localTime.slice(0, 5)} · {entryEnergyDisplay(entry)}
                        </Text>
                        {entry.entryKind === "food" ? (
                          <Text style={styles.entrySource}>
                            {entry.foodProvenance.kind === "private_custom"
                              ? `Owner-entered private food · pinned version ${entry.foodProvenance.customFoodVersionNumber}`
                              : `${entry.foodProvenance.source.attributionRequired ? entry.foodProvenance.source.attributionText : entry.foodProvenance.source.displayName} · ${entry.foodProvenance.source.licenseExpression}`}
                          </Text>
                        ) : (
                          <View
                            accessibilityLabel={`Recipe assumptions and source provenance for ${entry.recipe.name}`}
                          >
                            <Text style={styles.entrySource}>
                              {entry.recipe.retentionPolicy.assumption}
                            </Text>
                            {entry.recipe.warnings.map((warning) => (
                              <Text key={warning.code} style={styles.entrySource}>
                                {warning.message}
                              </Text>
                            ))}
                            {entry.sources.map((source) => (
                              <Text
                                key={`${source.code}:${source.releaseId}`}
                                style={styles.entrySource}
                              >
                                {source.attributionRequired
                                  ? source.attributionText
                                  : source.displayName}{" "}
                                · {source.licenseExpression}
                              </Text>
                            ))}
                          </View>
                        )}
                        {entry.timeZone !== profileTimeZone ? (
                          <Text style={styles.entrySource}>Logged in {entry.timeZone}</Text>
                        ) : null}
                        {entry.note !== null ? (
                          <View style={styles.entryNoteBlock}>
                            <Text style={styles.entryNoteLabel}>Private note</Text>
                            <Text
                              accessibilityLabel={`Private note for ${entryName(entry)}: ${entry.note}`}
                              style={styles.entryNote}
                            >
                              {entry.note}
                            </Text>
                          </View>
                        ) : null}
                        {editor?.entryId === entry.id ? (
                          <View style={styles.editor}>
                            <Text style={styles.label}>Quantity</Text>
                            <TextInput
                              accessibilityLabel="Quantity"
                              keyboardType="decimal-pad"
                              maxLength={18}
                              onChangeText={(quantity) => setEditor({ ...editor, quantity })}
                              style={styles.input}
                              value={editor.quantity}
                            />
                            <Text style={styles.label}>Meal</Text>
                            <View accessibilityRole="radiogroup" style={styles.chips}>
                              {diaryGroups.map(({ mealSlot: slot, label }) => (
                                <Pressable
                                  accessibilityRole="radio"
                                  accessibilityState={{ checked: editor.mealSlot === slot }}
                                  key={slot}
                                  onPress={() => setEditor({ ...editor, mealSlot: slot })}
                                  style={[
                                    styles.chip,
                                    editor.mealSlot === slot && styles.chipActive,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.chipText,
                                      editor.mealSlot === slot && styles.chipTextActive,
                                    ]}
                                  >
                                    {label}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>
                            <Text style={styles.label}>Local date</Text>
                            <TextInput
                              accessibilityLabel="Entry local date"
                              maxLength={10}
                              onChangeText={(localDate) => setEditor({ ...editor, localDate })}
                              style={styles.input}
                              value={editor.localDate}
                            />
                            <Text style={styles.label}>Local time</Text>
                            <TextInput
                              accessibilityLabel={`Entry local time in ${editor.originTimeZone}`}
                              keyboardType="numbers-and-punctuation"
                              maxLength={5}
                              onChangeText={(localTime) => setEditor({ ...editor, localTime })}
                              style={styles.input}
                              value={editor.localTime}
                            />
                            <Text style={styles.entrySource}>
                              Changed date and time are interpreted in {editor.originTimeZone}.
                            </Text>
                            <Text style={styles.label}>Private note</Text>
                            <TextInput
                              accessibilityHint="Saving an empty value removes the note from the current display only. Immutable prior revisions remain in your private account export until whole-account erasure."
                              accessibilityLabel={`Private note for ${entryName(entry)}`}
                              multiline
                              numberOfLines={4}
                              onChangeText={(note) => setEditor({ ...editor, note })}
                              style={[styles.input, styles.noteInput]}
                              textAlignVertical="top"
                              value={editor.note}
                            />
                            <Text style={styles.noteCount}>
                              {[...editor.note].length.toLocaleString()} /{" "}
                              {MAX_DIARY_NOTE_LENGTH.toLocaleString()} characters
                            </Text>
                            <Text style={styles.noteRetention}>
                              Saving an empty note removes it from the current diary display only.
                              Immutable prior revisions remain in your private account export until
                              whole-account erasure.
                            </Text>
                            {editor.note.length > 0 ? (
                              <Pressable
                                accessibilityHint="Save to remove the note from the current display only. Immutable prior revisions remain in your private account export until whole-account erasure."
                                accessibilityLabel={`Clear private note for ${entryName(entry)}`}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: busyEntry !== null }}
                                disabled={busyEntry !== null}
                                onPress={() => setEditor({ ...editor, note: "" })}
                                style={styles.clearNoteButton}
                              >
                                <Text style={styles.secondaryText}>Clear note</Text>
                              </Pressable>
                            ) : null}
                            <View style={styles.actionRow}>
                              <Pressable
                                accessibilityLabel={`Save changes to ${entryName(entry)}`}
                                accessibilityRole="button"
                                disabled={
                                  busyEntry !== null ||
                                  diary.status === "locked" ||
                                  durableQueueUnavailable ||
                                  pendingCorrectionEntries.has(entry.id) ||
                                  pendingReorderDates.has(diary.localDate)
                                }
                                onPress={() => void save()}
                                style={styles.primarySmall}
                              >
                                <Text style={styles.primaryText}>
                                  {busyEntry === entry.id ? "Saving…" : "Save"}
                                </Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={`Cancel editing ${entryName(entry)}`}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: busyEntry !== null }}
                                disabled={busyEntry !== null}
                                onPress={() => setEditor(null)}
                                style={styles.secondarySmall}
                              >
                                <Text style={styles.secondaryText}>Cancel</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : (
                          <View style={styles.actionRow}>
                            <Pressable
                              accessibilityLabel={`Move ${entryName(entry)} up within ${label}`}
                              accessibilityRole="button"
                              accessibilityState={{
                                disabled:
                                  !completeDayLoaded ||
                                  entryIndex === 0 ||
                                  busyEntry !== null ||
                                  diary.status === "locked" ||
                                  durableQueueUnavailable ||
                                  pendingDiaryDates.has(diary.localDate),
                              }}
                              disabled={
                                !completeDayLoaded ||
                                entryIndex === 0 ||
                                busyEntry !== null ||
                                diary.status === "locked" ||
                                durableQueueUnavailable ||
                                pendingDiaryDates.has(diary.localDate)
                              }
                              onPress={() => void reorder(entry, "up")}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Move up</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Move ${entryName(entry)} down within ${label}`}
                              accessibilityRole="button"
                              accessibilityState={{
                                disabled:
                                  !completeDayLoaded ||
                                  entryIndex === entries.length - 1 ||
                                  busyEntry !== null ||
                                  diary.status === "locked" ||
                                  durableQueueUnavailable ||
                                  pendingDiaryDates.has(diary.localDate),
                              }}
                              disabled={
                                !completeDayLoaded ||
                                entryIndex === entries.length - 1 ||
                                busyEntry !== null ||
                                diary.status === "locked" ||
                                durableQueueUnavailable ||
                                pendingDiaryDates.has(diary.localDate)
                              }
                              onPress={() => void reorder(entry, "down")}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Move down</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Repeat the pinned ${entryName(entry)} version today`}
                              accessibilityRole="button"
                              accessibilityState={{
                                disabled:
                                  busyEntry !== null ||
                                  durableQueueUnavailable ||
                                  pendingCorrectionEntries.has(entry.id) ||
                                  pendingReorderDates.has(diary.localDate) ||
                                  pendingReorderDates.has(repeatTargetDate),
                              }}
                              disabled={
                                busyEntry !== null ||
                                durableQueueUnavailable ||
                                pendingCorrectionEntries.has(entry.id) ||
                                pendingReorderDates.has(diary.localDate) ||
                                pendingReorderDates.has(repeatTargetDate)
                              }
                              onPress={() => void repeat(entry)}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Repeat today</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Edit ${entryName(entry)} entry and private note`}
                              accessibilityRole="button"
                              disabled={
                                busyEntry !== null ||
                                diary.status === "locked" ||
                                durableQueueUnavailable ||
                                pendingCorrectionEntries.has(entry.id) ||
                                pendingReorderDates.has(diary.localDate)
                              }
                              onPress={() => setEditor(editorFor(entry, diary, profileTimeZone))}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Edit</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Delete ${entryName(entry)}`}
                              accessibilityRole="button"
                              disabled={
                                busyEntry !== null ||
                                diary.status === "locked" ||
                                durableQueueUnavailable ||
                                pendingCorrectionEntries.has(entry.id) ||
                                pendingReorderDates.has(diary.localDate)
                              }
                              onPress={() => confirmRemove(entry)}
                              style={styles.deleteSmall}
                            >
                              <Text style={styles.deleteText}>
                                {busyEntry === entry.id ? "Working…" : "Delete"}
                              </Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ))
                  )}
                </View>
              );
            })
          : null}

        {diary && diaryPage && diaryPage.page.totalEntries > DIARY_PAGE_SIZE ? (
          <Pressable
            accessibilityHint={`${diary.entries.length} of ${diaryPage.page.totalEntries} entries are currently loaded.`}
            accessibilityLabel={
              pageState === "error"
                ? "Retry loading more diary entries"
                : diaryPage.page.nextCursor === null
                  ? "All diary entries loaded"
                  : "Load more diary entries"
            }
            accessibilityRole="button"
            accessibilityState={{
              busy: pageState === "loading",
              disabled:
                diaryPage.page.nextCursor === null || pageState === "loading" || busyEntry !== null,
            }}
            disabled={
              diaryPage.page.nextCursor === null || pageState === "loading" || busyEntry !== null
            }
            onPress={() => void loadMore()}
            style={styles.loadMoreButton}
          >
            {pageState === "loading" ? (
              <ActivityIndicator color={palette.forest} />
            ) : (
              <Text style={styles.secondaryText}>
                {pageState === "error"
                  ? "Retry load more"
                  : diaryPage.page.nextCursor === null
                    ? "All entries loaded"
                    : "Load more"}
              </Text>
            )}
          </Pressable>
        ) : null}

        {diary && diary.totals.length > 0 ? (
          <View style={styles.summary}>
            <Text style={styles.kicker}>AUTHORITATIVE SNAPSHOT TOTALS</Text>
            <Text accessibilityRole="header" style={styles.summaryTitle}>
              Nutrition
            </Text>
            {diary.totals.map((nutrient) => {
              const display = nutrientDisplay(nutrient);
              return (
                <View key={nutrient.nutrientId} style={styles.totalRow}>
                  <Text style={styles.totalName}>{nutrient.name}</Text>
                  <View>
                    <Text style={styles.totalAmount}>{display.amount}</Text>
                    <Text style={styles.totalQualification}>{display.qualification}</Text>
                  </View>
                </View>
              );
            })}
            <Text style={styles.note}>
              These totals cover all {diaryPage?.page.totalEntries ?? diary.entries.length} diary
              entries, including entries not loaded yet. Partial nutrient totals are lower bounds.
              Unknown values are never counted as zero.
            </Text>
          </View>
        ) : null}
        {diary?.status === "locked" ? (
          <Text style={styles.locked}>This local day is locked and cannot be edited.</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  addLink: {
    color: palette.forest,
    fontSize: 13,
    fontWeight: "800",
    textDecorationLine: "underline",
  },
  clearNoteButton: { alignSelf: "flex-start", marginTop: 9, paddingVertical: 4 },
  chip: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: palette.forest, borderColor: palette.forest },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: palette.white },
  content: { padding: 24, paddingBottom: 64 },
  dateInput: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 10,
    borderWidth: 1,
    color: palette.ink,
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 13,
    textAlign: "center",
  },
  dateRow: { flexDirection: "row", gap: 8, marginTop: 24 },
  deleteSmall: {
    borderColor: "#b8685f",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  deleteText: { color: "#8a3128", fontSize: 13, fontWeight: "800" },
  editor: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 16, paddingTop: 6 },
  emptyBody: { color: "#c8d8d0", fontSize: 15, lineHeight: 22, marginTop: 10 },
  emptyCard: { backgroundColor: palette.forest, borderRadius: 18, marginTop: 24, padding: 24 },
  emptyMeal: { color: palette.muted, fontSize: 14, paddingVertical: 14 },
  emptyTitle: { color: palette.white, fontSize: 25, fontWeight: "700", letterSpacing: -0.6 },
  entryBrand: { color: palette.muted, fontSize: 14, marginTop: 2 },
  entryCard: { borderTopColor: palette.line, borderTopWidth: 1, paddingVertical: 18 },
  entryNote: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 4,
  },
  entryNoteBlock: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  entryNoteLabel: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  entryMeta: { color: palette.muted, fontSize: 13, marginTop: 7 },
  entrySource: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 5 },
  entryTitle: { color: palette.ink, fontSize: 18, fontWeight: "700" },
  error: { color: "#8a3128" },
  groupMoveButton: {
    alignItems: "center",
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 46,
    minWidth: 46,
  },
  groupNameInput: { flex: 1 },
  groupSettingsButton: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  groupSettingsCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 14,
    padding: 16,
  },
  groupSettingsHelp: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  groupSettingsRow: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 12 },
  groupSettingsTitle: { color: palette.ink, fontSize: 20, fontWeight: "700" },
  input: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  label: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 6,
    marginTop: 13,
    textTransform: "uppercase",
  },
  locked: {
    backgroundColor: "#f7e6b0",
    borderRadius: 10,
    color: "#6b4c00",
    marginTop: 20,
    padding: 14,
  },
  loadMoreButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 24,
    minWidth: 128,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  mealHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  mealSection: { marginTop: 32 },
  mealTitle: { color: palette.ink, fontSize: 26, fontWeight: "700", letterSpacing: -0.8 },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 18 },
  noteCount: { color: palette.muted, fontSize: 11, marginTop: 5, textAlign: "right" },
  noteRetention: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  noteInput: { minHeight: 112, paddingBottom: 11, paddingTop: 11 },
  pageCount: { color: palette.muted, fontSize: 12, lineHeight: 18, marginBottom: 4 },
  primaryButton: {
    alignSelf: "flex-start",
    backgroundColor: palette.lime,
    borderRadius: 999,
    marginTop: 20,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primarySmall: {
    backgroundColor: palette.forest,
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  disabled: { opacity: 0.5 },
  queueAction: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  queueActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  queueCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 18,
    padding: 14,
  },
  queueDangerAction: { borderColor: "#8a332b" },
  queueDangerText: { color: "#8a332b", fontSize: 13, fontWeight: "800" },
  queueStatus: { color: palette.ink, fontSize: 13, lineHeight: 19 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondaryButton: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondarySmall: {
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  secondaryText: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  squareButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 10,
    justifyContent: "center",
    width: 48,
  },
  squareText: { color: palette.white, fontSize: 20, fontWeight: "700" },
  status: { color: palette.muted, fontSize: 14, lineHeight: 20, marginVertical: 22 },
  supportingAction: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderRadius: 999,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  supportingAmount: {
    color: palette.forest,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginTop: 10,
  },
  supportingCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    minWidth: 230,
    padding: 16,
  },
  supportingCardTitle: { color: palette.ink, fontSize: 19, fontWeight: "800" },
  supportingGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 14 },
  supportingOverview: { marginTop: 28 },
  supportingOverviewIntro: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  supportingOverviewTitle: {
    color: palette.ink,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginTop: 6,
  },
  supportingRetry: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  supportingStatus: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  supportingStatusRow: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 10 },
  summary: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 42,
    padding: 22,
  },
  summaryTitle: {
    color: palette.ink,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -1,
    marginBottom: 14,
    marginTop: 7,
  },
  title: {
    color: palette.ink,
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: -1.8,
    lineHeight: 47,
    marginTop: 10,
  },
  todayButton: { alignSelf: "center", marginTop: 10, padding: 8 },
  todayText: {
    color: palette.forest,
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  totalAmount: { color: palette.ink, fontSize: 14, fontWeight: "800", textAlign: "right" },
  totalName: { color: palette.ink, flex: 1, fontSize: 14, paddingRight: 10 },
  totalQualification: { color: palette.muted, fontSize: 10, marginTop: 2, textAlign: "right" },
  totalRow: {
    alignItems: "flex-start",
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  zone: { color: palette.muted, fontSize: 12, marginTop: 8 },
  workspaceLink: {
    color: palette.forest,
    fontSize: 13,
    fontWeight: "800",
    textDecorationLine: "underline",
  },
  workspaceNav: { flexDirection: "row", gap: 18, justifyContent: "flex-end", marginBottom: 14 },
});
