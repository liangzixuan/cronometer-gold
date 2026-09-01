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

import { apiUrl, authenticatedHeaders, jsonBody, responseError } from "../api/private-api";
import { newOperationId } from "../auth/operation-id";
import { palette } from "../theme";
import {
  createDiaryUnauthorizedSingleFlight,
  DIARY_PAGE_SIZE,
  type DiaryEditorOrigin,
  type DiaryEntry,
  type DiaryMutationResult,
  type DiaryPage,
  type DiaryUnauthorizedSingleFlight,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryNoteFromDraft,
  diaryPagePath,
  diaryRouteTransitionGeneration,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  isPositiveDecimal,
  localDateInTimeZone,
  localDateTimeToInstant,
  MAX_DIARY_NOTE_LENGTH,
  type MealSlot,
  mealLabel,
  mealSlots,
  mergeDiaryPages,
  nutrientDisplay,
  parseDiaryMutation,
  parseDiaryPage,
  quickAddOccurredAt,
  shiftLocalDate,
} from "./diary";

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
  readonly profileTimeZone: string;
  readonly requestedDate?: string;
  readonly refreshKey?: string;
  readonly onSearch: (date: string, meal: MealSlot, timeZone: string) => void;
  readonly onRecipes: () => void;
  readonly onGoals: () => void;
  readonly onHealth: () => void;
  readonly onUnauthorized: () => Promise<void>;
}

function editorFor(entry: DiaryEntry, day: DiaryPage["data"]): Editor {
  const localTime = entry.localTime.slice(0, 5);
  return {
    ...diaryEditorOrigin(day, entry),
    originalEntryLocalDate: entry.localDate,
    quantity: entry.portion.kind === "serving" ? entry.portion.amount : entry.portion.grams,
    mealSlot: entry.mealSlot,
    localDate: entry.localDate,
    localTime,
    originalLocalTime: localTime,
    note: entry.note ?? "",
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

export function DiaryScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  requestedDate,
  refreshKey,
  onSearch,
  onRecipes,
  onGoals,
  onHealth,
  onUnauthorized,
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
  const [routeReloadGeneration, setRouteReloadGeneration] = useState(0);
  const operationIds = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
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
  const diary = diaryPage?.data.localDate === date ? diaryPage.data : null;

  const closeForUnauthorized = useCallback(() => {
    unauthorizedFlight.current ??= createDiaryUnauthorizedSingleFlight();
    if (!privateUiClosed.current) {
      privateUiClosed.current = true;
      viewEpoch.current += 1;
      mutationSequence.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
      pageRequestBusy.current = false;
      operationIds.current.clear();
      dateRef.current = "";
      setDiaryPage(null);
      setEditor(null);
      setBusyEntry(null);
      setPageState("idle");
      setState("loading");
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

  const transitionCommittedDate = useCallback((next: string, forceReload = false) => {
    if (privateUiClosed.current || !isLocalDate(next)) return;
    setDateDraft(next);
    const dateChanged = next !== dateRef.current;
    if (!dateChanged && !forceReload) return;
    viewEpoch.current += 1;
    activeMutation.current = null;
    requestGeneration.current += 1;
    loadController.current?.abort();
    pageRequestBusy.current = false;
    setBusyEntry(null);
    setEditor(null);
    setDiaryPage(null);
    setPageState("idle");
    setState("loading");
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

  useEffect(() => {
    void routeReloadGeneration;
    if (isLocalDate(date)) void load(date);
    return () => {
      requestGeneration.current += 1;
      loadController.current?.abort();
      pageRequestBusy.current = false;
    };
  }, [date, load, routeReloadGeneration]);

  useEffect(
    () => () => {
      privateUiClosed.current = true;
      viewEpoch.current += 1;
      activeMutation.current = null;
      requestGeneration.current += 1;
      loadController.current?.abort();
    },
    [],
  );

  function operationId(key: string): string {
    const existing = operationIds.current.get(key);
    if (existing) return existing;
    const created = newOperationId();
    operationIds.current.set(key, created);
    return created;
  }

  function beginMutation(sourceDate: string, busyKey: string): MutationOwner {
    const token = mutationSequence.current + 1;
    mutationSequence.current = token;
    activeMutation.current = token;
    setBusyEntry(busyKey);
    return { sourceDate, token, viewEpoch: viewEpoch.current };
  }

  function mutationIsCurrent(owner: MutationOwner): boolean {
    return (
      activeMutation.current === owner.token &&
      viewEpoch.current === owner.viewEpoch &&
      dateRef.current === owner.sourceDate
    );
  }

  function finishMutation(owner: MutationOwner): void {
    if (activeMutation.current !== owner.token) return;
    activeMutation.current = null;
    setBusyEntry(null);
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
    const reloaded = await load(owner.sourceDate);
    if (!mutationIsCurrent(owner)) return;
    setMessage(reloaded ? successMessage : reloadFailureMessage);
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
    if (!diaryEditorOriginMatches(editor, diary, entry)) {
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
    const body = {
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
    const key = diaryEditorOperationKey(editor, body);
    const owner = beginMutation(editor.originLocalDate, editor.entryId);
    setMessage("Saving the diary entry…");
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/diary/entries/${entry.id}`).toString(), {
        method: "PATCH",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operationId(key),
          "if-match": `"${editor.originEntryRevision}"`,
        }),
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        await closeForUnauthorized();
        return;
      }
      const responseBody = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        setEditor(null);
        const reloaded = await load(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The diary changed elsewhere. Fresh values were loaded; review the edit again."
              : "The diary changed elsewhere, but fresh data could not be confirmed. Press Retry.",
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
        "The entry was saved, but fresh diary data could not be confirmed. Press Retry.",
      );
    } catch (caught) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${caught instanceof Error ? caught.message : "The entry could not be saved."} Press Save again to retry safely.`,
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  async function remove(entry: DiaryEntry) {
    if (privateUiClosed.current || !diary) return;
    const key = `delete:${entry.id}:${entry.revision}`;
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage("Deleting the diary entry…");
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/diary/entries/${entry.id}`).toString(), {
        method: "DELETE",
        headers: authenticatedHeaders(accessToken, {
          "idempotency-key": operationId(key),
          "if-match": `"${entry.revision}"`,
        }),
      });
      if (response.status === 401) {
        await closeForUnauthorized();
        return;
      }
      const body = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const reloaded = await load(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The diary changed elsewhere. Fresh values were loaded; delete again if needed."
              : "The diary changed elsewhere, but fresh data could not be confirmed. Press Retry.",
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
        "The entry was deleted, but fresh diary data could not be confirmed. Press Retry.",
      );
    } catch (caught) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${caught instanceof Error ? caught.message : "The entry could not be deleted."} Choose Delete again to retry safely.`,
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
    const body = {
      occurredAt: quickAddOccurredAt(targetDate, profileTimeZone, now),
      mealSlot: entry.mealSlot,
    };
    const key = `repeat:${entry.id}:${entry.revision}:${JSON.stringify(body)}`;
    const owner = beginMutation(diary.localDate, entry.id);
    setMessage(`Repeating the pinned ${entryName(entry)} version…`);
    try {
      const response = await fetch(
        apiUrl(apiBase, `/v1/diary/entries/${entry.id}/repeat`).toString(),
        {
          method: "POST",
          headers: authenticatedHeaders(accessToken, {
            "content-type": "application/json",
            "idempotency-key": operationId(key),
            "if-match": `"${entry.revision}"`,
          }),
          body: JSON.stringify(body),
        },
      );
      if (response.status === 401) {
        await closeForUnauthorized();
        return;
      }
      const responseBody = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        if (!mutationIsCurrent(owner)) return;
        const reloaded = await load(owner.sourceDate);
        if (mutationIsCurrent(owner)) {
          setMessage(
            reloaded
              ? "The source entry changed. Fresh details were loaded; review before repeating."
              : "The source entry changed, but fresh data could not be confirmed. Press Retry.",
          );
        }
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The entry could not be repeated."));
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      const repeatedDate = mutation.entry?.localDate ?? targetDate;
      await reportMutationReceipt(
        owner,
        mutation,
        repeatedDate === owner.sourceDate
          ? "Pinned entry version repeated with fresh authoritative totals."
          : `Pinned entry version repeated for ${repeatedDate}.`,
        "The entry was repeated, but fresh diary data could not be confirmed. Press Retry.",
      );
    } catch (caught) {
      if (mutationIsCurrent(owner)) {
        setMessage(
          `${caught instanceof Error ? caught.message : "The entry could not be repeated."} Choose Repeat again to retry the same operation safely.`,
        );
      }
    } finally {
      finishMutation(owner);
    }
  }

  function confirmRemove(entry: DiaryEntry) {
    Alert.alert(
      "Delete diary entry?",
      `${entryName(entry)} will be removed from ${mealLabel(entry.mealSlot)}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void remove(entry) },
      ],
    );
  }

  const activeTimeZone = diary?.timeZone ?? profileTimeZone;

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

        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, (state === "error" || pageState === "error") && styles.error]}
        >
          {message}
        </Text>
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
              onPress={() => onSearch(date, "breakfast", diary.timeZone)}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>Find a food</Text>
            </Pressable>
          </View>
        ) : null}

        {diary && diary.entries.length > 0
          ? mealSlots.map((meal) => {
              const entries = diary.entries.filter((entry) => entry.mealSlot === meal);
              return (
                <View key={meal} style={styles.mealSection}>
                  <View style={styles.mealHeading}>
                    <Text accessibilityRole="header" style={styles.mealTitle}>
                      {mealLabel(meal)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onSearch(date, meal, diary.timeZone)}
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
                    entries.map((entry) => (
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
                        {entry.timeZone !== diary.timeZone ? (
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
                              {mealSlots.map((slot) => (
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
                                    {mealLabel(slot)}
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
                                disabled={busyEntry !== null || diary.status === "locked"}
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
                              accessibilityLabel={`Repeat the pinned ${entryName(entry)} version today`}
                              accessibilityRole="button"
                              disabled={busyEntry !== null}
                              onPress={() => void repeat(entry)}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Repeat today</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Edit ${entryName(entry)} entry and private note`}
                              accessibilityRole="button"
                              disabled={busyEntry !== null || diary.status === "locked"}
                              onPress={() => setEditor(editorFor(entry, diary))}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Edit</Text>
                            </Pressable>
                            <Pressable
                              accessibilityLabel={`Delete ${entryName(entry)}`}
                              accessibilityRole="button"
                              disabled={busyEntry !== null || diary.status === "locked"}
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
