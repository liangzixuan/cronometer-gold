import type { ActivityEntry } from "@nutrition-tracker/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
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
import {
  isLocalDate,
  localDateInTimeZone,
  localTimeInTimeZone,
  shiftLocalDate,
} from "../diary/diary";
import { todayDetailDate } from "../diary/today-summary";
import { palette } from "../theme";
import {
  ACTIVITY_DAY_MAX_ENTRIES,
  ACTIVITY_ENERGY_POLICY_COPY,
  ACTIVITY_ESTIMATE_POLICY_COPY,
  ACTIVITY_ONLINE_POLICY_COPY,
  type ActivityEditDraft,
  type ActivityMutation,
  activityEntryAccessibilityLabel,
  isActivityTimeZoneChangedProblem,
  parseActivityDay,
  parseActivityMutation,
  prepareActivityCreate,
  prepareActivityUpdate,
} from "./activity";

type LoadState = "loading" | "ready" | "error";
type AddFields = {
  name: string;
  durationMinutes: string;
  selfReportedEnergyKilocalories: string;
  localTime: string;
};
type ReuseChoice = {
  readonly entry: ActivityEntry;
  readonly day: ReturnType<typeof parseActivityDay>;
  readonly draftGeneration: number;
  readonly actionGeneration: number;
};

interface ActivityScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly expectedOwnerUserId: string;
  readonly profileTimeZone: string;
  readonly requestedDate?: string;
  readonly onUnauthorized: () => Promise<void>;
}

function dayMessage(day: ReturnType<typeof parseActivityDay>): string {
  if (day.entries.length === 0) return "No activities recorded for this local start day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "activity" : "activities"}; ${day.totalDurationMinutes.toLocaleString("en-US")} total recorded minutes.`;
}

function editDraft(entry: ActivityEntry): ActivityEditDraft {
  return {
    entry,
    name: entry.name,
    durationMinutes: String(entry.durationMinutes),
    selfReportedEnergyKilocalories: entry.selfReportedEnergyKilocalories ?? "",
    localDate: entry.localDate,
    localTime: entry.localTime.slice(0, 5),
  };
}

function exactAffectedDays(
  mutation: ActivityMutation,
  expectedDates: ReadonlySet<string>,
): boolean {
  return (
    mutation.affectedDays.length === expectedDates.size &&
    mutation.affectedDays.every((item) => expectedDates.has(item.localDate))
  );
}

export function ActivityScreen({
  apiBase,
  accessToken,
  expectedOwnerUserId,
  profileTimeZone,
  requestedDate,
  onUnauthorized,
}: ActivityScreenProps) {
  const initialNow = useRef(new Date()).current;
  const scrollView = useRef<ScrollView | null>(null);
  const addSectionY = useRef(0);
  const initialDate = todayDetailDate(requestedDate, profileTimeZone, initialNow);
  const [date, setDate] = useState(initialDate);
  const [dateDraft, setDateDraft] = useState(initialDate);
  const [loadedDay, setDay] = useState<ReturnType<typeof parseActivityDay> | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private activity history…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [selfReportedEnergyKilocalories, setSelfReportedEnergyKilocalories] = useState("");
  const [localTime, setLocalTime] = useState(localTimeInTimeZone(initialNow, profileTimeZone));
  const [edit, setEdit] = useState<ActivityEditDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reuseChoice, setReuseChoice] = useState<ReuseChoice | null>(null);
  const choiceRef = useRef<ReuseChoice | null>(null);
  const draftRef = useRef<AddFields>({
    name,
    durationMinutes,
    selfReportedEnergyKilocalories,
    localTime,
  });
  const draftGeneration = useRef(0);
  const createIntent = useRef(0);
  const actionGeneration = useRef(0);
  const lifecycle = useRef(0);
  const mounted = useRef(false);
  const foreground = useRef(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const dateRef = useRef(date);
  const dateDraftRef = useRef(dateDraft);
  const editRef = useRef(edit);
  editRef.current = edit;
  const busyRef = useRef<string | null>(null);
  const mutationGeneration = useRef(0);
  const mutationController = useRef<AbortController | null>(null);
  const scopeRef = useRef({
    accessToken,
    apiBase: apiBase.toString(),
    expectedOwnerUserId,
    profileTimeZone,
    requestedDate,
  });
  if (
    scopeRef.current.accessToken !== accessToken ||
    scopeRef.current.apiBase !== apiBase.toString() ||
    scopeRef.current.expectedOwnerUserId !== expectedOwnerUserId ||
    scopeRef.current.profileTimeZone !== profileTimeZone ||
    scopeRef.current.requestedDate !== requestedDate
  ) {
    scopeRef.current = {
      accessToken,
      apiBase: apiBase.toString(),
      expectedOwnerUserId,
      profileTimeZone,
      requestedDate,
    };
  }
  const scope = scopeRef.current;
  const installedScope = useRef<typeof scope | null>(null);
  const closedScope = useRef<typeof scope | null>(null);
  const dayScope = useRef<typeof scope | null>(null);
  const dayRef = useRef<ReturnType<typeof parseActivityDay> | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(initialNow.toISOString());

  const scopeIsCurrent = useCallback(
    () =>
      mounted.current &&
      foreground.current &&
      scopeRef.current === scope &&
      installedScope.current === scope &&
      closedScope.current !== scope,
    [scope],
  );
  const clearChoice = useCallback(() => {
    choiceRef.current = null;
    setReuseChoice(null);
  }, []);
  const clearDay = useCallback(() => {
    dayRef.current = null;
    dayScope.current = null;
    setDay(null);
  }, []);
  const installFields = useCallback((fields: Partial<AddFields>) => {
    draftRef.current = { ...draftRef.current, ...fields };
    draftGeneration.current += 1;
    if (fields.name !== undefined) setName(fields.name);
    if (fields.durationMinutes !== undefined) setDurationMinutes(fields.durationMinutes);
    if (fields.selfReportedEnergyKilocalories !== undefined)
      setSelfReportedEnergyKilocalories(fields.selfReportedEnergyKilocalories);
    if (fields.localTime !== undefined) setLocalTime(fields.localTime);
  }, []);
  const closePrivate = useCallback(async () => {
    if (!scopeIsCurrent()) return;
    closedScope.current = scope;
    lifecycle.current += 1;
    actionGeneration.current += 1;
    mutationGeneration.current += 1;
    loadController.current?.abort();
    mutationController.current?.abort();
    busyRef.current = null;
    setBusy(null);
    clearChoice();
    clearDay();
    installFields({ name: "", durationMinutes: "", selfReportedEnergyKilocalories: "" });
    setState("error");
    setMessageIsError(true);
    setMessage("Your activity session has closed.");
    await onUnauthorizedRef.current();
  }, [clearChoice, clearDay, installFields, scope, scopeIsCurrent]);
  useEffect(() => {
    mounted.current = true;
    busyRef.current = null;
    setBusy(null);
    clearChoice();
    lifecycle.current += 1;
    actionGeneration.current += 1;
    const previous = installedScope.current;
    installedScope.current = scope;
    if (previous !== null && previous !== scope) {
      clearChoice();
      clearDay();
      operations.current.clear();
      installFields({ name: "", durationMinutes: "", selfReportedEnergyKilocalories: "" });
      editRef.current = null;
      setEdit(null);
      busyRef.current = null;
      setBusy(null);
      loadedTimeZone.current = null;
      const nextDate = todayDetailDate(scope.requestedDate, scope.profileTimeZone, new Date());
      dateRef.current = nextDate;
      dateDraftRef.current = nextDate;
      setDate(nextDate);
      setDateDraft(nextDate);
    }
    return () => {
      mounted.current = false;
      lifecycle.current += 1;
      actionGeneration.current += 1;
      mutationGeneration.current += 1;
      loadGeneration.current += 1;
      loadController.current?.abort();
      mutationController.current?.abort();
    };
  }, [clearChoice, clearDay, installFields, scope]);
  const day =
    scopeIsCurrent() && dayScope.current === scope && dayRef.current === loadedDay
      ? loadedDay
      : null;

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      if (!scopeIsCurrent() || dateRef.current !== requestedDate) return false;
      actionGeneration.current += 1;
      clearChoice();
      clearDay();
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      const initiatingLifecycle = lifecycle.current;
      const current = () =>
        scopeIsCurrent() &&
        dateRef.current === requestedDate &&
        lifecycle.current === initiatingLifecycle &&
        !controller.signal.aborted &&
        loadGeneration.current === generation;
      setState("loading");
      setMessageIsError(false);
      setMessage(`Loading activities for ${requestedDate}…`);
      try {
        const response = await fetch(
          apiUrl(apiBase, `/v1/activities?date=${encodeURIComponent(requestedDate)}`).toString(),
          {
            headers: {
              ...authenticatedHeaders(accessToken),
              "x-expected-owner-user-id": expectedOwnerUserId,
            },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!current()) return false;
        if (response.status === 401) {
          await closePrivate();
          return false;
        }
        const body = await jsonBody(response);
        if (!current()) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Activity history could not be loaded."));
        }
        const next = parseActivityDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The activity service returned another local day.");
        }
        if (loadedTimeZone.current !== next.timeZone) {
          const capturedNow = new Date();
          installFields({ localTime: localTimeInTimeZone(capturedNow, next.timeZone) });
          untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          loadedTimeZone.current = next.timeZone;
        }
        if (!current()) return false;
        dayRef.current = next;
        dayScope.current = scope;
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
          error instanceof Error ? error.message : "Activity history could not be loaded.",
        );
        return false;
      }
    },
    [
      accessToken,
      apiBase,
      clearChoice,
      clearDay,
      closePrivate,
      expectedOwnerUserId,
      installFields,
      scope,
      scopeIsCurrent,
    ],
  );

  useEffect(() => {
    void loadDay(date);
    return () => loadController.current?.abort();
  }, [date, loadDay]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next !== "background" && next !== "inactive";
      if (!mounted.current || foreground.current === active) return;
      foreground.current = active;
      lifecycle.current += 1;
      actionGeneration.current += 1;
      mutationGeneration.current += 1;
      loadGeneration.current += 1;
      loadController.current?.abort();
      mutationController.current?.abort();
      busyRef.current = null;
      setBusy(null);
      clearChoice();
      clearDay();
      setState("loading");
      if (active) void loadDay(dateRef.current);
    });
    return () => subscription.remove();
  }, [clearChoice, clearDay, loadDay]);

  const renderedGeneration = actionGeneration.current;
  function currentAction(requireReady = true) {
    return (
      scopeIsCurrent() &&
      actionGeneration.current === renderedGeneration &&
      dateRef.current === date &&
      busyRef.current === null &&
      state !== "loading" &&
      (!requireReady ||
        (state === "ready" &&
          day !== null &&
          dayRef.current === day &&
          day.localDate === date &&
          dateDraftRef.current === date))
    );
  }
  function changeAdd(field: keyof AddFields, value: string) {
    if (!currentAction()) return;
    clearChoice();
    if (field === "localTime") untouchedDefaultOccurredAt.current = null;
    installFields({ [field]: value });
  }
  function changeEdit(field: keyof Omit<ActivityEditDraft, "entry">, value: string) {
    if (!currentAction() || !edit || editRef.current?.entry !== edit.entry) return;
    editRef.current = { ...editRef.current, [field]: value };
    setEdit(editRef.current);
  }
  function showAdd(message: string) {
    scrollView.current?.scrollTo({ y: addSectionY.current, animated: true });
    AccessibilityInfo.announceForAccessibility(message);
  }
  function beginEdit(entry: ActivityEntry) {
    if (!currentAction() || !day?.entries.includes(entry)) return;
    actionGeneration.current += 1;
    clearChoice();
    editRef.current = editDraft(entry);
    setEdit(editRef.current);
  }
  function cancelEdit() {
    if (!currentAction()) return;
    actionGeneration.current += 1;
    editRef.current = null;
    setEdit(null);
  }
  function installReuse(entry: ActivityEntry) {
    createIntent.current += 1;
    actionGeneration.current += 1;
    clearChoice();
    installFields({
      name: entry.name,
      durationMinutes: String(entry.durationMinutes),
      selfReportedEnergyKilocalories: entry.selfReportedEnergyKilocalories ?? "",
    });
    showAdd("Activity details copied to Add an activity. Review and choose Add activity to save.");
    setMessageIsError(false);
    setMessage(
      "Activity details are ready in Add an activity. Review the selected day and start time, then choose Add activity to save a new entry.",
    );
  }
  function reuse(entry: ActivityEntry) {
    if (!currentAction() || editRef.current !== null || !day?.entries.includes(entry)) return;
    const fields = draftRef.current;
    if (
      fields.name !== "" ||
      fields.durationMinutes !== "" ||
      fields.selfReportedEnergyKilocalories !== ""
    ) {
      const choice = {
        entry,
        day,
        draftGeneration: draftGeneration.current,
        actionGeneration: actionGeneration.current,
      };
      choiceRef.current = choice;
      setReuseChoice(choice);
      showAdd("Your Add draft has details. Choose Keep draft or Replace details.");
    } else installReuse(entry);
  }
  function resolveReuse(choice: ReuseChoice, replace: boolean) {
    if (
      !currentAction() ||
      editRef.current !== null ||
      choiceRef.current !== choice ||
      choice.day !== dayRef.current ||
      choice.draftGeneration !== draftGeneration.current ||
      choice.actionGeneration !== actionGeneration.current
    )
      return;
    if (replace) installReuse(choice.entry);
    else clearChoice();
  }

  function chooseDate(value: string) {
    if (!currentAction(false)) return;
    if (!isLocalDate(value)) {
      setMessageIsError(true);
      setMessage("Enter a valid local date in YYYY-MM-DD form.");
      dateDraftRef.current = date;
      setDateDraft(date);
      return;
    }
    if (value === date && dateDraftRef.current === value) return;
    clearChoice();
    actionGeneration.current += 1;
    draftGeneration.current += 1;
    editRef.current = null;
    setEdit(null);
    dateRef.current = value;
    dateDraftRef.current = value;
    setDateDraft(value);
    if (value !== date) {
      clearDay();
      setState("loading");
      loadGeneration.current += 1;
      loadController.current?.abort();
      setDate(value);
    }
  }

  function operationId(key: string): string {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const created = newOperationId();
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
    readonly onAccepted?: () => void;
    readonly validates: (mutation: ActivityMutation) => boolean;
  }): Promise<ActivityMutation | null> {
    if (!currentAction() || !day) return null;
    actionGeneration.current += 1;
    clearChoice();
    const initiatingLifecycle = lifecycle.current;
    const initiatingDate = dateRef.current;
    const token = ++mutationGeneration.current;
    const controller = new AbortController();
    mutationController.current = controller;
    const current = () =>
      scopeIsCurrent() &&
      lifecycle.current === initiatingLifecycle &&
      dateRef.current === initiatingDate &&
      mutationGeneration.current === token &&
      !controller.signal.aborted;
    busyRef.current = input.intentKey;
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the activity…");
    try {
      const headers: Record<string, string> = {
        ...authenticatedHeaders(accessToken),
        "idempotency-key": operationId(input.intentKey),
        "x-expected-owner-user-id": expectedOwnerUserId,
      };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.revision) headers["if-match"] = `"${input.revision}"`;
      if (input.expectedTimeZone) {
        headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      }
      const response = await fetch(apiUrl(apiBase, input.path).toString(), {
        method: input.method,
        headers,
        signal: controller.signal,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
      });
      if (!current()) return null;
      if (response.status === 401) {
        await closePrivate();
        return null;
      }
      const body = await jsonBody(response);
      if (!current()) return null;
      if (!response.ok) {
        if (isActivityTimeZoneChangedProblem(response.status, body)) {
          operations.current.delete(input.intentKey);
          const retainedLocalTime = localTime;
          const refreshed = await loadDay(date);
          if (!current()) return null;
          installFields({ localTime: retainedLocalTime });
          untouchedDefaultOccurredAt.current = null;
          setMessageIsError(true);
          setMessage(
            refreshed
              ? "Your profile time zone changed, so the activity was not saved. Review the local date and time in the refreshed time zone, then submit again."
              : "Your profile time zone changed, so the activity was not saved. Reload the day, then review the local date and time before submitting again.",
          );
          return null;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          operations.current.delete(input.intentKey);
          setState("error");
          setMessageIsError(true);
          setMessage(
            `${responseError(body, "The activity could not be changed.")} Reload the day view, review the fields, and try again.`,
          );
          return null;
        }
        throw new Error(responseError(body, "The activity could not be changed."));
      }
      const mutation = parseActivityMutation(body);
      if (!input.validates(mutation)) {
        throw new TypeError("The activity service returned a mismatched confirmation.");
      }
      operations.current.delete(input.intentKey);
      input.onAccepted?.();
      const refreshed = await loadDay(date, input.successMessage);
      if (!current()) return null;
      if (!refreshed) {
        setState("error");
        setMessageIsError(true);
        setMessage(
          "The activity change was accepted, but the exact local-day view could not be refreshed. Retry the day view; do not submit the change again.",
        );
      }
      return mutation;
    } catch (error) {
      if (!current()) return null;
      setState("error");
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The activity could not be changed."} Retry without changing the fields to safely reuse the same operation; do not assume it was saved.`,
      );
      return null;
    } finally {
      if (current()) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  async function createEntry() {
    if (!currentAction()) return;
    const initiatingIntent = createIntent.current;
    const initiatingDraft = draftGeneration.current;
    const initiatingLifecycle = lifecycle.current;
    if (!day || day.localDate !== date || state !== "ready") {
      setMessageIsError(true);
      setMessage("Load the selected activity day before adding an entry.");
      return;
    }
    try {
      const prepared = prepareActivityCreate(
        draftRef.current.name,
        draftRef.current.durationMinutes,
        draftRef.current.selfReportedEnergyKilocalories,
        date,
        draftRef.current.localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      const intentKey = `create:${createIntent.current}:${expectedOwnerUserId}:${prepared.expectedTimeZone}:${JSON.stringify(prepared.body)}`;
      await mutate({
        intentKey,
        path: "/v1/activities/entries?profileTimeZonePrecondition=v1",
        method: "POST",
        body: prepared.body,
        expectedTimeZone: prepared.expectedTimeZone,
        successMessage: `${prepared.body.name} was added to your private activity history.`,
        onAccepted: () => {
          if (
            scopeIsCurrent() &&
            dateRef.current === date &&
            lifecycle.current === initiatingLifecycle &&
            createIntent.current === initiatingIntent &&
            draftGeneration.current === initiatingDraft
          ) {
            createIntent.current += 1;
            actionGeneration.current += 1;
            installFields({ name: "", durationMinutes: "", selfReportedEnergyKilocalories: "" });
            const capturedNow = new Date();
            const activeZone = day.timeZone;
            installFields({ localTime: localTimeInTimeZone(capturedNow, activeZone) });
            untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          }
        },
        validates: (result) => {
          const saved = result.entry;
          return (
            saved !== null &&
            saved.name === prepared.body.name &&
            saved.durationMinutes === prepared.body.durationMinutes &&
            saved.selfReportedEnergyKilocalories === prepared.body.selfReportedEnergyKilocalories &&
            saved.occurredAt === prepared.body.occurredAt &&
            saved.localDate === date &&
            saved.timeZone === prepared.expectedTimeZone &&
            exactAffectedDays(result, new Set([date]))
          );
        },
      });
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid activity.");
    }
  }

  async function updateEntry() {
    if (!currentAction() || !edit || !day) return;
    try {
      const prepared = prepareActivityUpdate(edit, day.timeZone);
      const intentKey = `update:${expectedOwnerUserId}:${edit.entry.id}:${edit.entry.revision}:${prepared.expectedTimeZone ?? ""}:${JSON.stringify(prepared.body)}`;
      const hasTimeGuard = prepared.expectedTimeZone !== null;
      const mutation = await mutate({
        intentKey,
        path: `/v1/activities/entries/${encodeURIComponent(edit.entry.id)}${hasTimeGuard ? "?profileTimeZonePrecondition=v1" : ""}`,
        method: "PATCH",
        body: prepared.body,
        revision: edit.entry.revision,
        ...(prepared.expectedTimeZone === null
          ? {}
          : { expectedTimeZone: prepared.expectedTimeZone }),
        successMessage:
          "Activity details were updated without changing nutrition targets or balance.",
        validates: (result) => {
          const saved = result.entry;
          if (
            saved === null ||
            saved.id !== edit.entry.id ||
            BigInt(saved.revision) <= BigInt(edit.entry.revision)
          ) {
            return false;
          }
          for (const [key, expected] of Object.entries(prepared.body)) {
            if (saved[key as keyof ActivityEntry] !== expected) return false;
          }
          return exactAffectedDays(result, new Set([edit.entry.localDate, saved.localDate]));
        },
      });
      if (mutation) setEdit(null);
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter valid activity details.");
    }
  }

  async function deleteEntry(entry: ActivityEntry) {
    const intentKey = `delete:${expectedOwnerUserId}:${entry.id}:${entry.revision}`;
    const mutation = await mutate({
      intentKey,
      path: `/v1/activities/entries/${encodeURIComponent(entry.id)}`,
      method: "DELETE",
      revision: entry.revision,
      successMessage: "The activity was deleted from the current history view.",
      validates: (result) =>
        result.entry === null && exactAffectedDays(result, new Set([entry.localDate])),
    });
    if (mutation) setEdit((current) => (current?.entry.id === entry.id ? null : current));
  }

  function confirmDelete(entry: ActivityEntry) {
    if (!currentAction() || !day?.entries.includes(entry)) return;
    Alert.alert(
      "Delete activity?",
      `${entry.name} will be removed from ${entry.localDate}. Its calories never adjusted your nutrition target or balance.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void deleteEntry(entry) },
      ],
    );
  }

  const controlsDisabled = busy !== null || state === "loading" || !scopeIsCurrent();
  const createDisabled =
    controlsDisabled ||
    state !== "ready" ||
    day === null ||
    day.localDate !== date ||
    dateDraft !== date;
  const reuseDisabled = createDisabled || edit !== null;

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        ref={scrollView}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.kicker}>PRIVATE LOCAL-DAY ACTIVITY HISTORY</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Activity
        </Text>
        <Text style={styles.zone}>{day?.timeZone ?? profileTimeZone}</Text>

        <View style={styles.dateRow}>
          <Pressable
            accessibilityLabel="Previous activity day"
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
            disabled={controlsDisabled}
            onPress={() => chooseDate(shiftLocalDate(date, -1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>←</Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Activity date YYYY-MM-DD"
            autoCapitalize="none"
            editable={!controlsDisabled}
            maxLength={10}
            onChangeText={(value) => {
              if (!currentAction(false)) return;
              clearChoice();
              draftGeneration.current += 1;
              dateDraftRef.current = value;
              setDateDraft(value);
            }}
            onEndEditing={(event) => chooseDate(event.nativeEvent.text)}
            onSubmitEditing={(event) => chooseDate(event.nativeEvent.text)}
            returnKeyType="done"
            style={styles.dateInput}
            value={dateDraft}
          />
          <Pressable
            accessibilityLabel="Next activity day"
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
            disabled={controlsDisabled}
            onPress={() => chooseDate(shiftLocalDate(date, 1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>→</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: controlsDisabled }}
          disabled={controlsDisabled}
          onPress={() =>
            chooseDate(localDateInTimeZone(new Date(), day?.timeZone ?? profileTimeZone))
          }
          style={styles.todayButton}
        >
          <Text style={styles.todayText}>Jump to today</Text>
        </Pressable>

        <View
          accessibilityLiveRegion="polite"
          accessibilityRole={messageIsError ? "alert" : "summary"}
          style={styles.statusRow}
        >
          {state === "loading" ? (
            <ActivityIndicator
              accessibilityLabel="Loading activity history"
              color={palette.forest}
            />
          ) : null}
          <Text style={[styles.status, messageIsError ? styles.error : null]}>{message}</Text>
        </View>
        {state === "error" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
            disabled={controlsDisabled}
            onPress={() => {
              if (currentAction(false)) void loadDay(date);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>Retry day view</Text>
          </Pressable>
        ) : null}

        <View
          accessibilityLabel="Sum of recorded activity duration; overlapping activities are included"
          accessible
          style={styles.totalCard}
        >
          <Text style={styles.totalKicker}>SUM OF RECORDED DURATION</Text>
          <Text style={styles.total}>
            {day ? `${day.totalDurationMinutes.toLocaleString("en-US")} min` : "—"}
          </Text>
          <Text style={styles.totalNote}>
            Activities are grouped by their local start day. Overlapping durations are not removed.
          </Text>
        </View>

        <View accessible style={styles.policyCard}>
          <Text style={styles.policyTitle}>Calories do not change your food budget</Text>
          <Text style={styles.policyText}>{ACTIVITY_ENERGY_POLICY_COPY}</Text>
          <Text style={styles.policyText}>{ACTIVITY_ESTIMATE_POLICY_COPY}</Text>
          <Text style={styles.policyText}>{ACTIVITY_ONLINE_POLICY_COPY}</Text>
        </View>

        <View
          accessibilityLabel="Add an activity form"
          onLayout={(event) => {
            addSectionY.current = event.nativeEvent.layout.y;
          }}
          style={styles.card}
        >
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Add an activity
          </Text>
          {reuseChoice && choiceRef.current === reuseChoice && day === reuseChoice.day ? (
            <View style={styles.card}>
              <Text style={styles.policyText}>
                Replace the Add details with {reuseChoice.entry.name}? Your selected day and start
                time will stay the same.
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={reuseDisabled}
                  accessibilityState={{ disabled: reuseDisabled }}
                  onPress={() => resolveReuse(reuseChoice, false)}
                  style={styles.secondarySmall}
                >
                  <Text style={styles.secondaryText}>Keep draft</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={reuseDisabled}
                  accessibilityState={{ disabled: reuseDisabled }}
                  onPress={() => resolveReuse(reuseChoice, true)}
                  style={styles.secondarySmall}
                >
                  <Text style={styles.secondaryText}>Replace details</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          <Text style={styles.label}>ACTIVITY NAME</Text>
          <TextInput
            accessibilityLabel="Activity name"
            editable={!createDisabled}
            maxLength={240}
            onChangeText={(value) => changeAdd("name", value)}
            placeholder="Walk"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={scopeIsCurrent() ? name : ""}
          />
          <Text style={styles.label}>DURATION · WHOLE MINUTES</Text>
          <TextInput
            accessibilityHint="Whole minutes from 1 through 1,440"
            accessibilityLabel="Activity duration in whole minutes"
            editable={!createDisabled}
            keyboardType="number-pad"
            maxLength={4}
            onChangeText={(value) => changeAdd("durationMinutes", value)}
            placeholder="30"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={scopeIsCurrent() ? durationMinutes : ""}
          />
          <Text style={styles.label}>SELF-REPORTED CALORIES · OPTIONAL</Text>
          <TextInput
            accessibilityHint="Optional value from 0.001 through 20,000 kilocalories"
            accessibilityLabel="Optional self-reported activity calories"
            editable={!createDisabled}
            keyboardType="decimal-pad"
            maxLength={9}
            onChangeText={(value) => changeAdd("selfReportedEnergyKilocalories", value)}
            placeholder="Leave blank"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={scopeIsCurrent() ? selfReportedEnergyKilocalories : ""}
          />
          <Text style={styles.label}>LOCAL START TIME</Text>
          <TextInput
            accessibilityHint="24-hour time in HH:MM form"
            accessibilityLabel="Activity local start time"
            autoCapitalize="none"
            editable={!createDisabled}
            maxLength={5}
            onChangeText={(value) => changeAdd("localTime", value)}
            placeholder="08:30"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={scopeIsCurrent() ? localTime : ""}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: createDisabled }}
            disabled={createDisabled}
            onPress={() => void createEntry()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryText}>
              {busy?.startsWith("create:") ? "Adding…" : "Add activity"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.entriesHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Activity history
          </Text>
          <Text style={styles.count}>
            {day
              ? `${day.entries.length} of ${ACTIVITY_DAY_MAX_ENTRIES} maximum`
              : `${ACTIVITY_DAY_MAX_ENTRIES} maximum`}
          </Text>
        </View>
        {day?.entries.length ? (
          day.entries.map((entry) => (
            <View key={entry.id} style={styles.entryCard}>
              {edit?.entry.id === entry.id ? (
                <>
                  <Text style={styles.label}>ACTIVITY NAME</Text>
                  <TextInput
                    accessibilityLabel="Edit activity name"
                    editable={!controlsDisabled}
                    maxLength={240}
                    onChangeText={(value) => changeEdit("name", value)}
                    style={styles.input}
                    value={edit.name}
                  />
                  <Text style={styles.label}>DURATION · WHOLE MINUTES</Text>
                  <TextInput
                    accessibilityLabel="Edit activity duration in whole minutes"
                    editable={!controlsDisabled}
                    keyboardType="number-pad"
                    maxLength={4}
                    onChangeText={(value) => changeEdit("durationMinutes", value)}
                    style={styles.input}
                    value={edit.durationMinutes}
                  />
                  <Text style={styles.label}>SELF-REPORTED CALORIES · OPTIONAL</Text>
                  <TextInput
                    accessibilityLabel="Edit optional self-reported activity calories"
                    editable={!controlsDisabled}
                    keyboardType="decimal-pad"
                    maxLength={9}
                    onChangeText={(value) => changeEdit("selfReportedEnergyKilocalories", value)}
                    placeholder="Leave blank"
                    placeholderTextColor={palette.muted}
                    style={styles.input}
                    value={edit.selfReportedEnergyKilocalories}
                  />
                  <Text style={styles.label}>LOCAL START DATE</Text>
                  <TextInput
                    accessibilityLabel="Edit activity start date YYYY-MM-DD"
                    autoCapitalize="none"
                    editable={!controlsDisabled}
                    maxLength={10}
                    onChangeText={(value) => changeEdit("localDate", value)}
                    style={styles.input}
                    value={edit.localDate}
                  />
                  <Text style={styles.label}>LOCAL START TIME</Text>
                  <TextInput
                    accessibilityLabel="Edit activity local start time"
                    autoCapitalize="none"
                    editable={!controlsDisabled}
                    maxLength={5}
                    onChangeText={(value) => changeEdit("localTime", value)}
                    style={styles.input}
                    value={edit.localTime}
                  />
                  <Text style={styles.editorNote}>
                    Changing the start date or time uses the current profile time zone:{" "}
                    {day.timeZone}.
                  </Text>
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => void updateEntry()}
                      style={styles.primarySmall}
                    >
                      <Text style={styles.primaryText}>Save activity</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={cancelEdit}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text
                    accessibilityLabel={activityEntryAccessibilityLabel(entry)}
                    style={styles.entryName}
                  >
                    {entry.name}
                  </Text>
                  <Text style={styles.entryDuration}>
                    {entry.durationMinutes.toLocaleString("en-US")} min
                  </Text>
                  <Text style={styles.entryEnergy}>
                    {entry.selfReportedEnergyKilocalories === null
                      ? "Self-reported calories not entered"
                      : `${entry.selfReportedEnergyKilocalories} kcal self-reported`}
                  </Text>
                  <Text style={styles.entryMeta}>
                    Started {entry.localDate} at {entry.localTime.slice(0, 5)} · {entry.timeZone}
                  </Text>
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityLabel={`Use details from ${entry.name}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: reuseDisabled }}
                      disabled={reuseDisabled}
                      onPress={() => reuse(entry)}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Use details</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => beginEdit(entry)}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Edit activity</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => confirmDelete(entry)}
                      style={styles.deleteSmall}
                    >
                      <Text style={styles.deleteText}>Delete</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          ))
        ) : state === "ready" ? (
          <Text style={styles.empty}>No activities recorded for this local start day.</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  card: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 22,
    padding: 18,
  },
  content: { alignSelf: "center", maxWidth: 760, padding: 22, paddingBottom: 80, width: "100%" },
  count: { color: palette.muted, fontSize: 12 },
  dateInput: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    color: palette.ink,
    flex: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlign: "center",
  },
  dateRow: { alignItems: "center", flexDirection: "row", gap: 9, marginTop: 20 },
  deleteSmall: {
    borderColor: "#c87a70",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deleteText: { color: "#8a3128", fontSize: 13, fontWeight: "800" },
  editorNote: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
  empty: { color: palette.muted, fontSize: 14, marginTop: 12 },
  entriesHeading: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 28,
  },
  entryCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 12,
    padding: 16,
  },
  entryDuration: { color: palette.ink, fontSize: 22, fontWeight: "800", marginTop: 8 },
  entryEnergy: { color: palette.forest, fontSize: 13, fontWeight: "700", marginTop: 7 },
  entryMeta: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  entryName: { color: palette.ink, fontSize: 18, fontWeight: "800" },
  error: { color: "#8a3128" },
  input: {
    backgroundColor: palette.paper,
    borderColor: palette.line,
    borderRadius: 11,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 16,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  label: { color: palette.muted, fontSize: 11, fontWeight: "800", marginTop: 16 },
  policyCard: {
    backgroundColor: "#edf4e9",
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
  },
  policyText: { color: palette.ink, fontSize: 13, lineHeight: 20, marginTop: 7 },
  policyTitle: { color: palette.forest, fontSize: 15, fontWeight: "800" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 11,
    marginTop: 20,
    paddingVertical: 13,
  },
  primarySmall: {
    backgroundColor: palette.forest,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  retryButton: {
    alignItems: "center",
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
  },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondarySmall: {
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryText: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  sectionTitle: { color: palette.ink, fontSize: 20, fontWeight: "800" },
  squareButton: {
    alignItems: "center",
    borderColor: palette.line,
    borderRadius: 11,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  squareText: { color: palette.forest, fontSize: 20, fontWeight: "800" },
  status: { color: palette.muted, flex: 1, fontSize: 13, lineHeight: 19 },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 9, minHeight: 48 },
  title: { color: palette.ink, fontSize: 34, fontWeight: "800", letterSpacing: -0.8, marginTop: 5 },
  todayButton: { alignSelf: "flex-start", marginTop: 10, paddingVertical: 5 },
  todayText: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  total: { color: palette.ink, fontSize: 32, fontWeight: "800", marginTop: 5 },
  totalCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 12,
    padding: 18,
  },
  totalKicker: { color: palette.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.3 },
  totalNote: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  zone: { color: palette.muted, fontSize: 13, marginTop: 5 },
});
