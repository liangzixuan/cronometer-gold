import { resolveHydrationLocalMinute } from "@nutrition-tracker/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  assertHydrationUpdateReceipt,
  type HydrationDay,
  type HydrationEntry,
  type HydrationMutation,
  type HydrationTimeEdit,
  hydrationEntryAccessibilityLabel,
  hydrationTimeEdit,
  parseHydrationDay,
  parseHydrationMutation,
  prepareHydrationCreate,
  prepareHydrationUpdate,
} from "./hydration";

type LoadState = "loading" | "ready" | "error";

interface HydrationScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly requestedDate?: string;
  readonly onUnauthorized: () => Promise<void>;
}

interface HydrationEdit {
  readonly entry: HydrationEntry;
  readonly amount: string;
  readonly time?: HydrationTimeEdit;
}

interface MutationInput {
  readonly intentKey: string;
  readonly path: string;
  readonly method: "DELETE" | "PATCH" | "POST";
  readonly body?: unknown;
  readonly revision?: string;
  readonly expectedTimeZone?: string;
  readonly successMessage: string;
  readonly destinationDate?: string;
  readonly validate: (receipt: HydrationMutation) => void;
}

interface PendingMutation {
  readonly input: MutationInput;
  readonly operationId: string;
  readonly serializedBody: string | undefined;
  readonly sourceDate: string;
  readonly scopeKey: string;
}

function dayMessage(day: HydrationDay): string {
  if (day.entries.length === 0) return "No hydration entries for this local day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "entry" : "entries"}; exact total ${day.totalMilliliters.toLocaleString("en-US")} milliliters.`;
}

export function HydrationScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  requestedDate,
  onUnauthorized,
}: HydrationScreenProps) {
  const initialNow = useRef(new Date()).current;
  const initialDate = todayDetailDate(requestedDate, profileTimeZone, initialNow);
  const [date, setDate] = useState(initialDate);
  const [dateDraft, setDateDraft] = useState(initialDate);
  const [loadedDay, setDay] = useState<HydrationDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private hydration log…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [amount, setAmount] = useState("");
  const [localTime, setLocalTime] = useState(
    localTimeInTimeZone(initialNow, profileTimeZone).slice(0, 5),
  );
  const [edit, setEdit] = useState<HydrationEdit | null>(null);
  const amountRef = useRef(amount);
  const timeRef = useRef(localTime);
  const dateDraftRef = useRef(dateDraft);
  const draftVersion = useRef(0);
  const [, refreshDraftVersion] = useState(0);
  const lifecycle = useRef(0);
  const foreground = useRef(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const scopeKey = JSON.stringify([accessToken, apiBase.href, profileTimeZone, requestedDate]);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const loadedScope = useRef<string | null>(null);
  const closedScope = useRef<string | null>(null);
  const installedView = useRef<string | null>(null);
  const installedScope = useRef(scopeKey);
  const dayRef = useRef<HydrationDay | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const pendingRef = useRef<PendingMutation | null>(null);
  const [requiresReload, setRequiresReload] = useState(false);
  const requiresReloadRef = useRef(requiresReload);
  requiresReloadRef.current = requiresReload;
  const [destinationDate, setDestinationDate] = useState<string | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const mutationGeneration = useRef(0);
  const mounted = useRef(true);
  const selectedDate = useRef(date);
  selectedDate.current = date;
  const context = useRef({ accessToken, base: apiBase.href, profileTimeZone });
  context.current = { accessToken, base: apiBase.href, profileTimeZone };
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(null);

  const privateCurrent = useCallback(
    () =>
      mounted.current &&
      foreground.current &&
      scopeKeyRef.current === scopeKey &&
      installedScope.current === scopeKey &&
      closedScope.current !== scopeKey,
    [scopeKey],
  );
  const clearDay = useCallback(() => {
    dayRef.current = null;
    loadedScope.current = null;
    setDay(null);
  }, []);
  const closePrivate = useCallback(async () => {
    if (!privateCurrent()) return;
    closedScope.current = scopeKey;
    lifecycle.current += 1;
    loadGeneration.current += 1;
    loadController.current?.abort();
    mutationGeneration.current += 1;
    mutationController.current?.abort();
    mutationController.current = null;
    pendingRef.current = null;
    setPending(null);
    setBusy(null);
    clearDay();
    setEdit(null);
    amountRef.current = "";
    setAmount("");
    setState("error");
    setMessageIsError(true);
    setMessage("Your hydration session has closed.");
    await onUnauthorizedRef.current();
  }, [clearDay, privateCurrent, scopeKey]);
  const day =
    privateCurrent() && loadedScope.current === scopeKey && dayRef.current === loadedDay
      ? loadedDay
      : null;

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      if (!privateCurrent() || selectedDate.current !== requestedDate) return false;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      const initiatingLifecycle = lifecycle.current;
      const isCurrent = () =>
        privateCurrent() &&
        lifecycle.current === initiatingLifecycle &&
        selectedDate.current === requestedDate &&
        !controller.signal.aborted &&
        loadGeneration.current === generation &&
        context.current.accessToken === accessToken &&
        context.current.base === apiBase.href &&
        context.current.profileTimeZone === profileTimeZone;
      setState("loading");
      clearDay();
      setMessageIsError(false);
      setMessage(`Loading hydration entries for ${requestedDate}…`);
      try {
        const response = await fetch(
          apiUrl(apiBase, `/v1/hydration?date=${encodeURIComponent(requestedDate)}`).toString(),
          {
            headers: authenticatedHeaders(accessToken),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!isCurrent()) return false;
        if (response.status === 401) {
          await closePrivate();
          return false;
        }
        const body = await jsonBody(response);
        if (!isCurrent()) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Hydration entries could not be loaded."));
        }
        const next = parseHydrationDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The hydration service returned another local day.");
        }
        if (loadedTimeZone.current !== next.timeZone) {
          setEdit(null);
          const capturedNow = new Date();
          timeRef.current = localTimeInTimeZone(capturedNow, next.timeZone).slice(0, 5);
          setLocalTime(timeRef.current);
          untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          loadedTimeZone.current = next.timeZone;
        }
        dayRef.current = next;
        loadedScope.current = scopeKey;
        setDay(next);
        setState("ready");
        setMessageIsError(false);
        setMessage(successMessage ?? dayMessage(next));
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        setDay(null);
        setState("error");
        setMessageIsError(true);
        setMessage(
          error instanceof Error ? error.message : "Hydration entries could not be loaded.",
        );
        return false;
      }
    },
    [accessToken, apiBase, clearDay, closePrivate, privateCurrent, profileTimeZone, scopeKey],
  );

  useEffect(() => {
    mounted.current = true;
    lifecycle.current += 1;
    setBusy(null);
    if (installedScope.current !== scopeKey) {
      installedScope.current = scopeKey;
      amountRef.current = "";
      setAmount("");
      const now = new Date();
      timeRef.current = localTimeInTimeZone(now, profileTimeZone).slice(0, 5);
      setLocalTime(timeRef.current);
      untouchedDefaultOccurredAt.current = null;
      loadedTimeZone.current = null;
      draftVersion.current += 1;
      refreshDraftVersion(draftVersion.current);
    }
    const view = JSON.stringify([scopeKey, date]);
    if (installedView.current !== view) {
      installedView.current = view;
      setPending(null);
      pendingRef.current = null;
      setEdit(null);
      setRequiresReload(false);
      requiresReloadRef.current = false;
      setDestinationDate(null);
    }
    void loadDay(date);
    return () => {
      mounted.current = false;
      lifecycle.current += 1;
      loadController.current?.abort();
      mutationGeneration.current += 1;
      mutationController.current?.abort();
      mutationController.current = null;
    };
  }, [date, loadDay, profileTimeZone, scopeKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next !== "background" && next !== "inactive";
      if (!mounted.current || foreground.current === active) return;
      foreground.current = active;
      lifecycle.current += 1;
      loadGeneration.current += 1;
      loadController.current?.abort();
      mutationGeneration.current += 1;
      mutationController.current?.abort();
      mutationController.current = null;
      setBusy(null);
      clearDay();
      // Background is uncertain acceptance; retain the exact pending request for explicit retry.
      if (closedScope.current !== scopeKey) setState("loading");
      if (active) void loadDay(selectedDate.current);
    });
    return () => subscription.remove();
  }, [clearDay, loadDay, scopeKey]);

  const renderedLifecycle = lifecycle.current;
  const renderedLoad = loadGeneration.current;
  const renderedDraftVersion = draftVersion.current;
  function currentControls() {
    return (
      privateCurrent() &&
      selectedDate.current === date &&
      lifecycle.current === renderedLifecycle &&
      loadGeneration.current === renderedLoad &&
      draftVersion.current === renderedDraftVersion
    );
  }
  function canEditAdd() {
    return (
      currentControls() &&
      draftVersion.current === renderedDraftVersion &&
      !pendingRef.current &&
      !mutationController.current &&
      !requiresReloadRef.current &&
      state === "ready" &&
      day !== null &&
      dayRef.current === day &&
      day.localDate === date &&
      dateDraftRef.current === date
    );
  }
  function changeAmount(value: string, announce = false) {
    if (!canEditAdd()) return;
    if (amountRef.current !== value) {
      amountRef.current = value;
      draftVersion.current += 1;
      setAmount(value);
      refreshDraftVersion(draftVersion.current);
    }
    if (announce)
      AccessibilityInfo.announceForAccessibility(
        `${value} milliliters selected. Choose Add entry to save.`,
      );
  }
  function changeTime(value: string) {
    if (!canEditAdd()) return;
    if (timeRef.current !== value || untouchedDefaultOccurredAt.current !== null) {
      timeRef.current = value;
      untouchedDefaultOccurredAt.current = null;
      draftVersion.current += 1;
      setLocalTime(value);
      refreshDraftVersion(draftVersion.current);
    }
  }
  function changeDateDraft(value: string) {
    if (
      !currentControls() ||
      draftVersion.current !== renderedDraftVersion ||
      pendingRef.current ||
      mutationController.current ||
      state === "loading"
    )
      return;
    if (dateDraftRef.current !== value) {
      dateDraftRef.current = value;
      draftVersion.current += 1;
      refreshDraftVersion(draftVersion.current);
      setDateDraft(value);
    }
  }

  function chooseDate(value: string) {
    if (
      !currentControls() ||
      pendingRef.current ||
      mutationController.current ||
      busy ||
      state === "loading"
    )
      return;
    if (!isLocalDate(value)) {
      setMessageIsError(true);
      setMessage("Enter a valid local date in YYYY-MM-DD form.");
      if (dateDraftRef.current !== date) {
        draftVersion.current += 1;
        refreshDraftVersion(draftVersion.current);
      }
      dateDraftRef.current = date;
      setDateDraft(date);
      return;
    }
    if (value === date) {
      dateDraftRef.current = value;
      setDateDraft(value);
      return;
    }
    selectedDate.current = value;
    dateDraftRef.current = value;
    lifecycle.current += 1;
    loadGeneration.current += 1;
    loadController.current?.abort();
    setEdit(null);
    clearDay();
    setDestinationDate(null);
    setRequiresReload(false);
    setDateDraft(value);
    setDate(value);
  }

  function clearPending() {
    pendingRef.current = null;
    setPending(null);
  }

  async function submitMutation(operation: PendingMutation): Promise<void> {
    if (
      !privateCurrent() ||
      operation.scopeKey !== scopeKey ||
      selectedDate.current !== operation.sourceDate ||
      mutationController.current ||
      pendingRef.current !== operation
    )
      return;
    const input = operation.input;
    const controller = new AbortController();
    mutationController.current = controller;
    const generation = ++mutationGeneration.current;
    const activeContext = context.current;
    const initiatingLifecycle = lifecycle.current;
    const isCurrent = () =>
      privateCurrent() &&
      lifecycle.current === initiatingLifecycle &&
      selectedDate.current === operation.sourceDate &&
      !controller.signal.aborted &&
      generation === mutationGeneration.current &&
      context.current.accessToken === activeContext.accessToken &&
      context.current.base === activeContext.base &&
      context.current.profileTimeZone === activeContext.profileTimeZone;
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the hydration entry…");
    try {
      const headers: Record<string, string> = {
        ...authenticatedHeaders(accessToken),
        "idempotency-key": operation.operationId,
      };
      if (operation.serializedBody !== undefined) headers["content-type"] = "application/json";
      if (input.revision) headers["if-match"] = `"${input.revision}"`;
      if (input.expectedTimeZone) headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      const response = await fetch(apiUrl(apiBase, input.path).toString(), {
        method: input.method,
        headers,
        ...(operation.serializedBody === undefined ? {} : { body: operation.serializedBody }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401) {
        await closePrivate();
        return;
      }
      const body = await jsonBody(response);
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 409 || response.status === 412) {
          clearPending();
          requiresReloadRef.current = true;
          setRequiresReload(true);
          setMessageIsError(true);
          setMessage(
            `${responseError(body, "The entry or profile time zone changed.")} Reload the current day, then review and confirm your correction again.`,
          );
          return;
        }
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          clearPending();
          setMessageIsError(true);
          setMessage(responseError(body, "The hydration change was rejected. Review your entry."));
          return;
        }
        throw new Error(responseError(body, "The hydration entry could not be changed."));
      }
      const receipt = parseHydrationMutation(body);
      input.validate(receipt);
      clearPending();
      setEdit(null);
      if (input.method === "POST") {
        amountRef.current = "";
        draftVersion.current += 1;
        setAmount("");
        refreshDraftVersion(draftVersion.current);
      }
      setDestinationDate(input.destinationDate ?? null);
      const refreshed = await loadDay(operation.sourceDate, input.successMessage);
      if (!isCurrent()) return;
      if (!refreshed) {
        setState("error");
        setMessageIsError(true);
        setMessage(
          `The entry change was accepted${input.destinationDate ? ` and moved to ${input.destinationDate}` : ""}, but the exact local-day view could not be refreshed. Retry the day view; do not submit the change again.`,
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The hydration entry could not be changed."} Acceptance is unconfirmed. Retry the saved change to safely reuse its exact request.`,
      );
    } finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (isCurrent()) setBusy(null);
    }
  }

  function beginMutation(input: MutationInput) {
    if (
      !currentControls() ||
      selectedDate.current !== date ||
      context.current.accessToken !== accessToken ||
      context.current.base !== apiBase.href ||
      context.current.profileTimeZone !== profileTimeZone
    )
      return;
    if (
      pendingRef.current ||
      busy ||
      requiresReload ||
      state !== "ready" ||
      !day ||
      day.localDate !== date
    )
      return;
    const operation: PendingMutation = {
      input,
      operationId: newOperationId(),
      serializedBody: input.body === undefined ? undefined : JSON.stringify(input.body),
      sourceDate: date,
      scopeKey,
    };
    pendingRef.current = operation;
    setPending(operation);
    setDestinationDate(null);
    void submitMutation(operation);
  }

  function createEntry() {
    if (!canEditAdd() || draftVersion.current !== renderedDraftVersion) return;
    if (!day || day.localDate !== date || state !== "ready") return;
    try {
      const prepared = prepareHydrationCreate(
        amountRef.current,
        date,
        timeRef.current,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      beginMutation({
        intentKey: `create:${prepared.body.occurredAt}:${prepared.expectedTimeZone}:${prepared.body.amountMilliliters}`,
        path: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
        method: "POST",
        body: prepared.body,
        expectedTimeZone: prepared.expectedTimeZone,
        successMessage: `${prepared.body.amountMilliliters.toLocaleString("en-US")} milliliters added and the exact total refreshed.`,
        validate: (receipt) => {
          if (
            !receipt.entry ||
            receipt.entry.amountMilliliters !== prepared.body.amountMilliliters ||
            Date.parse(receipt.entry.occurredAt) !== Date.parse(prepared.body.occurredAt) ||
            receipt.entry.timeZone !== prepared.expectedTimeZone ||
            receipt.entry.localDate !== date ||
            receipt.affectedDays.length !== 1 ||
            receipt.affectedDays[0]?.localDate !== date
          ) {
            throw new TypeError("The hydration receipt does not match the submitted entry.");
          }
        },
      });
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration entry.");
    }
  }

  function updateEntry() {
    if (!edit || !day) return;
    try {
      if (edit.time && edit.time.timeZone !== day.timeZone) {
        throw new Error("The profile time zone changed. Reload and confirm the correction again.");
      }
      const prepared = prepareHydrationUpdate(edit.entry, edit.amount, edit.time);
      const moved = prepared.destinationLocalDate !== edit.entry.localDate;
      beginMutation({
        intentKey: `update:${edit.entry.id}:${edit.entry.revision}:${JSON.stringify(prepared.body)}:${prepared.expectedTimeZone ?? ""}`,
        path: `/v1/hydration/entries/${encodeURIComponent(edit.entry.id)}${prepared.expectedTimeZone ? "?profileTimeZonePrecondition=v1" : ""}`,
        method: "PATCH",
        body: prepared.body,
        revision: edit.entry.revision,
        ...(prepared.expectedTimeZone ? { expectedTimeZone: prepared.expectedTimeZone } : {}),
        ...(moved ? { destinationDate: prepared.destinationLocalDate } : {}),
        successMessage: moved
          ? `Hydration entry moved to ${prepared.destinationLocalDate}. The total for ${date} was refreshed.`
          : "Hydration entry updated and the exact total refreshed.",
        validate: (receipt) => assertHydrationUpdateReceipt(receipt, edit.entry, prepared),
      });
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid hydration correction.");
    }
  }

  function deleteEntry(entry: HydrationEntry) {
    beginMutation({
      intentKey: `delete:${entry.id}:${entry.revision}`,
      path: `/v1/hydration/entries/${encodeURIComponent(entry.id)}`,
      method: "DELETE",
      revision: entry.revision,
      successMessage: "Hydration entry deleted and the exact total refreshed.",
      validate: (receipt) => {
        if (
          receipt.entry !== null ||
          receipt.affectedDays.length !== 1 ||
          receipt.affectedDays[0]?.localDate !== entry.localDate
        ) {
          throw new TypeError("The hydration receipt does not match the deleted entry's day.");
        }
      },
    });
  }

  function reloadForCorrection() {
    if (!currentControls() || mutationController.current || busy || pendingRef.current) return;
    setEdit(null);
    setRequiresReload(false);
    void loadDay(date);
  }

  function confirmDelete(entry: HydrationEntry) {
    const generation = loadGeneration.current;
    Alert.alert(
      "Delete hydration entry?",
      `${entry.amountMilliliters.toLocaleString("en-US")} milliliters will be removed from ${entry.localDate}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (mounted.current && generation === loadGeneration.current) deleteEntry(entry);
          },
        },
      ],
    );
  }

  const editLocalDate = edit?.time?.localDate;
  const editLocalTime = edit?.time?.localTime;
  const editTimeZone = edit?.time?.timeZone;
  const timeResolution = useMemo(
    () =>
      editLocalDate !== undefined && editLocalTime !== undefined && editTimeZone !== undefined
        ? resolveHydrationLocalMinute(editLocalDate, editLocalTime, editTimeZone)
        : null,
    [editLocalDate, editLocalTime, editTimeZone],
  );
  const controlsDisabled =
    busy !== null || pending !== null || state === "loading" || !privateCurrent();
  const editDisabled = controlsDisabled || requiresReload || state !== "ready";
  const createDisabled =
    editDisabled || day === null || day.localDate !== date || dateDraft !== date;

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.kicker}>PRIVATE LOCAL-DAY HYDRATION LOG</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Hydration
        </Text>
        <Text style={styles.zone}>{day?.timeZone ?? profileTimeZone}</Text>

        <View style={styles.dateRow}>
          <Pressable
            accessibilityLabel="Previous day"
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
            disabled={controlsDisabled}
            onPress={() => chooseDate(shiftLocalDate(date, -1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>←</Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Hydration date YYYY-MM-DD"
            autoCapitalize="none"
            editable={!controlsDisabled}
            maxLength={10}
            onChangeText={changeDateDraft}
            onEndEditing={(event) => chooseDate(event.nativeEvent.text)}
            onSubmitEditing={(event) => chooseDate(event.nativeEvent.text)}
            returnKeyType="done"
            style={styles.dateInput}
            value={dateDraft}
          />
          <Pressable
            accessibilityLabel="Next day"
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
              accessibilityLabel="Loading hydration entries"
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
              if (currentControls() && !pendingRef.current && !mutationController.current)
                void loadDay(date);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>Retry day view</Text>
          </Pressable>
        ) : null}

        {pending && !busy ? (
          <Pressable
            accessibilityRole="button"
            disabled={!privateCurrent() || state === "loading"}
            accessibilityState={{ disabled: !privateCurrent() || state === "loading" }}
            onPress={() => {
              if (currentControls() && state !== "loading") void submitMutation(pending);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>Retry saved change</Text>
          </Pressable>
        ) : null}
        {requiresReload ? (
          <Pressable
            accessibilityRole="button"
            disabled={controlsDisabled}
            accessibilityState={{ disabled: controlsDisabled }}
            onPress={reloadForCorrection}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>Reload before correcting</Text>
          </Pressable>
        ) : null}
        {destinationDate ? (
          <Pressable
            accessibilityRole="button"
            disabled={controlsDisabled}
            accessibilityState={{ disabled: controlsDisabled }}
            onPress={() => chooseDate(destinationDate)}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>View destination day {destinationDate}</Text>
          </Pressable>
        ) : null}

        <View
          accessibilityLabel="Exact local-day hydration total"
          accessible
          style={styles.totalCard}
        >
          <Text style={styles.totalKicker}>EXACT LOCAL-DAY SUM</Text>
          <Text style={styles.total}>
            {day ? `${day.totalMilliliters.toLocaleString("en-US")} mL` : "—"}
          </Text>
          <Text style={styles.totalNote}>Sum of the bounded entries shown for {date}.</Text>
        </View>

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Add milliliters
          </Text>
          <Text style={styles.label}>MILLILITERS</Text>
          <TextInput
            accessibilityHint="Whole milliliters from 1 to 20,000"
            accessibilityLabel="Hydration amount in milliliters"
            editable={!createDisabled}
            keyboardType="number-pad"
            maxLength={5}
            onChangeText={(value) => changeAmount(value)}
            placeholder="250"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={privateCurrent() ? amount : ""}
          />
          <View style={styles.actionRow}>
            {["250", "500"].map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`Set Add amount to ${value} milliliters`}
                accessibilityState={{
                  selected: privateCurrent() && amount === value,
                  disabled: createDisabled,
                }}
                disabled={createDisabled}
                onPress={() => changeAmount(value, true)}
                style={styles.secondarySmall}
              >
                <Text style={styles.secondaryText}>{value} mL</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>LOCAL TIME</Text>
          <TextInput
            accessibilityHint="24-hour time in HH:MM form"
            accessibilityLabel="Hydration local time"
            autoCapitalize="none"
            editable={!createDisabled}
            maxLength={5}
            onChangeText={changeTime}
            placeholder="08:30"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={privateCurrent() ? localTime : ""}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: createDisabled }}
            disabled={createDisabled}
            onPress={() => void createEntry()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryText}>
              {busy?.startsWith("create:") ? "Adding…" : "Add entry"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.entriesHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Entries
          </Text>
          <Text style={styles.count}>
            {day ? `${day.entries.length} of 64 maximum` : "64 maximum"}
          </Text>
        </View>
        {day?.entries.length ? (
          day.entries.map((entry) => (
            <View key={entry.id} style={styles.entryCard}>
              {edit?.entry.id === entry.id ? (
                <>
                  <Text style={styles.entryMeta}>
                    Originally {edit.entry.localDate} at {edit.entry.localTime} ·{" "}
                    {edit.entry.timeZone}
                  </Text>
                  <Text style={styles.label}>MILLILITERS</Text>
                  <TextInput
                    accessibilityLabel={`Edit milliliters at ${entry.localTime.slice(0, 5)}`}
                    editable={!editDisabled}
                    keyboardType="number-pad"
                    maxLength={5}
                    onChangeText={(value) =>
                      setEdit((current) => (current ? { ...current, amount: value } : current))
                    }
                    style={styles.input}
                    value={edit.amount}
                  />
                  {edit.time ? (
                    <>
                      <Text style={styles.entryMeta}>
                        Change time in {edit.time.timeZone}. Choosing a time records the start of
                        that minute.
                      </Text>
                      <Text style={styles.label}>LOCAL DATE</Text>
                      <TextInput
                        accessibilityLabel="Correction date YYYY-MM-DD"
                        autoCapitalize="none"
                        editable={!editDisabled}
                        maxLength={10}
                        style={styles.input}
                        value={edit.time.localDate}
                        onChangeText={(value) =>
                          setEdit((current) =>
                            current?.time
                              ? {
                                  ...current,
                                  time: {
                                    ...current.time,
                                    localDate: value,
                                    selectedOccurredAt: null,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      <Text style={styles.label}>LOCAL TIME</Text>
                      <TextInput
                        accessibilityLabel="Correction local time HH:MM"
                        accessibilityHint="24-hour time in the displayed profile time zone"
                        autoCapitalize="none"
                        editable={!editDisabled}
                        maxLength={5}
                        style={styles.input}
                        value={edit.time.localTime}
                        onChangeText={(value) =>
                          setEdit((current) =>
                            current?.time
                              ? {
                                  ...current,
                                  time: {
                                    ...current.time,
                                    localTime: value,
                                    selectedOccurredAt: null,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      {timeResolution?.kind === "gap" ? (
                        <Text accessibilityRole="alert" style={styles.error}>
                          This local time does not exist. Choose another time.
                        </Text>
                      ) : null}
                      {timeResolution?.kind === "invalid" ? (
                        <Text accessibilityRole="alert" style={styles.error}>
                          Enter a valid date and 24-hour time.
                        </Text>
                      ) : null}
                      {timeResolution?.kind === "ambiguous" ? (
                        <View
                          accessibilityRole="radiogroup"
                          accessibilityLabel="Choose the repeated-time occurrence"
                        >
                          <Text style={styles.entryMeta}>
                            This time occurs more than once. Choose an occurrence.
                          </Text>
                          {timeResolution.candidates.map((candidate, index) => (
                            <Pressable
                              key={candidate.occurredAt}
                              accessibilityRole="radio"
                              accessibilityState={{
                                checked: edit.time?.selectedOccurredAt === candidate.occurredAt,
                                disabled: editDisabled,
                              }}
                              disabled={editDisabled}
                              style={styles.secondarySmall}
                              onPress={() =>
                                setEdit((current) =>
                                  current?.time
                                    ? {
                                        ...current,
                                        time: {
                                          ...current.time,
                                          selectedOccurredAt: candidate.occurredAt,
                                        },
                                      }
                                    : current,
                                )
                              }
                            >
                              <Text style={styles.secondaryText}>
                                {index === 0 ? "Earlier" : "Later"} occurrence ·{" "}
                                {candidate.utcOffsetLabel}
                                {edit.time?.selectedOccurredAt === candidate.occurredAt
                                  ? " · Selected"
                                  : ""}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        disabled={editDisabled}
                        accessibilityState={{ disabled: editDisabled }}
                        style={styles.secondarySmall}
                        onPress={() =>
                          setEdit((current) =>
                            current ? { entry: current.entry, amount: current.amount } : current,
                          )
                        }
                      >
                        <Text style={styles.secondaryText}>Keep original time</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={editDisabled}
                      accessibilityState={{ disabled: editDisabled }}
                      style={styles.secondarySmall}
                      onPress={() =>
                        setEdit((current) =>
                          current && day
                            ? { ...current, time: hydrationTimeEdit(current.entry, day.timeZone) }
                            : current,
                        )
                      }
                    >
                      <Text style={styles.secondaryText}>Change time</Text>
                    </Pressable>
                  )}
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: editDisabled }}
                      disabled={editDisabled}
                      onPress={() => void updateEntry()}
                      style={styles.primarySmall}
                    >
                      <Text style={styles.primaryText}>
                        {edit.time ? "Save correction" : "Save amount"}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: editDisabled }}
                      disabled={editDisabled}
                      onPress={() => setEdit(null)}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text
                    accessibilityLabel={hydrationEntryAccessibilityLabel(entry)}
                    style={styles.entryAmount}
                  >
                    {entry.amountMilliliters.toLocaleString("en-US")} mL
                  </Text>
                  <Text style={styles.entryMeta}>
                    {entry.localTime.slice(0, 5)} · {entry.timeZone}
                  </Text>
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: editDisabled }}
                      disabled={editDisabled}
                      onPress={() => {
                        if (!currentControls() || pendingRef.current || mutationController.current)
                          return;
                        setEdit({ entry, amount: String(entry.amountMilliliters) });
                      }}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Edit amount</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: editDisabled }}
                      disabled={editDisabled}
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
          <Text style={styles.empty}>No hydration entries for this local day.</Text>
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
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 22,
    padding: 20,
  },
  content: { padding: 24, paddingBottom: 64 },
  count: { color: palette.muted, fontSize: 12 },
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
  empty: { color: palette.muted, fontSize: 14, marginTop: 18 },
  entriesHeading: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 32,
  },
  entryAmount: { color: palette.ink, fontSize: 22, fontWeight: "800" },
  entryCard: {
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    paddingVertical: 18,
  },
  entryMeta: { color: palette.muted, fontSize: 13, marginTop: 5 },
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
    marginTop: 14,
  },
  primaryButton: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
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
  retryButton: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 9,
    borderWidth: 1,
    marginBottom: 16,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondarySmall: {
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  secondaryText: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  sectionTitle: { color: palette.ink, fontSize: 24, fontWeight: "700", letterSpacing: -0.6 },
  squareButton: {
    alignItems: "center",
    borderColor: palette.line,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    width: 48,
  },
  squareText: { color: palette.forest, fontSize: 20, fontWeight: "800" },
  status: { color: palette.muted, flex: 1, fontSize: 13, lineHeight: 19 },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 9, minHeight: 48 },
  title: { color: palette.ink, fontSize: 44, fontWeight: "700", letterSpacing: -1.8 },
  todayButton: { alignSelf: "flex-start", marginTop: 12, paddingVertical: 6 },
  todayText: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  total: { color: palette.white, fontSize: 48, fontWeight: "800", letterSpacing: -1.8 },
  totalCard: { backgroundColor: palette.forest, borderRadius: 18, padding: 22 },
  totalKicker: { color: palette.lime, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  totalNote: { color: "#c8d8d0", fontSize: 12, marginTop: 6 },
  zone: { color: palette.muted, fontSize: 13, marginTop: 5 },
});
