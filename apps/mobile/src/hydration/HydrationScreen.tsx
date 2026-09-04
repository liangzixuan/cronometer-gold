import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import {
  isLocalDate,
  localDateInTimeZone,
  localTimeInTimeZone,
  shiftLocalDate,
} from "../diary/diary";
import { palette } from "../theme";
import {
  type HydrationDay,
  type HydrationEntry,
  hydrationEntryAccessibilityLabel,
  hydrationUpdateBody,
  parseHydrationDay,
  parseHydrationMutation,
  prepareHydrationCreate,
} from "./hydration";

type LoadState = "loading" | "ready" | "error";

interface HydrationScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly onUnauthorized: () => Promise<void>;
}

interface HydrationEdit {
  readonly entry: HydrationEntry;
  readonly amount: string;
}

function dayMessage(day: HydrationDay): string {
  if (day.entries.length === 0) return "No hydration entries for this local day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "entry" : "entries"}; exact total ${day.totalMilliliters.toLocaleString("en-US")} milliliters.`;
}

export function HydrationScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  onUnauthorized,
}: HydrationScreenProps) {
  const today = localDateInTimeZone(new Date(), profileTimeZone);
  const [date, setDate] = useState(today);
  const [dateDraft, setDateDraft] = useState(today);
  const [day, setDay] = useState<HydrationDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private hydration log…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [amount, setAmount] = useState("");
  const [localTime, setLocalTime] = useState(
    localTimeInTimeZone(new Date(), profileTimeZone).slice(0, 5),
  );
  const [edit, setEdit] = useState<HydrationEdit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(null);

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
        const response = await fetch(
          apiUrl(apiBase, `/v1/hydration?date=${encodeURIComponent(requestedDate)}`).toString(),
          {
            headers: authenticatedHeaders(accessToken),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (response.status === 401) {
          await onUnauthorized();
          return false;
        }
        const body = await jsonBody(response);
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
    [accessToken, apiBase, onUnauthorized],
  );

  useEffect(() => {
    void loadDay(date);
    return () => loadController.current?.abort();
  }, [date, loadDay]);

  function chooseDate(value: string) {
    if (!isLocalDate(value)) {
      setMessageIsError(true);
      setMessage("Enter a valid local date in YYYY-MM-DD form.");
      setDateDraft(date);
      return;
    }
    setEdit(null);
    setDateDraft(value);
    setDate(value);
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
  }): Promise<boolean> {
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the hydration entry…");
    try {
      const headers: Record<string, string> = {
        ...authenticatedHeaders(accessToken),
        "idempotency-key": operationId(input.intentKey),
      };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.revision) headers["if-match"] = `"${input.revision}"`;
      if (input.expectedTimeZone) {
        headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      }
      const response = await fetch(apiUrl(apiBase, input.path).toString(), {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
      });
      if (response.status === 401) {
        await onUnauthorized();
        return false;
      }
      const body = await jsonBody(response);
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
          path: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
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
          path: `/v1/hydration/entries/${encodeURIComponent(edit.entry.id)}`,
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
    const intentKey = `delete:${entry.id}:${entry.revision}`;
    if (
      await mutate({
        intentKey,
        path: `/v1/hydration/entries/${encodeURIComponent(entry.id)}`,
        method: "DELETE",
        revision: entry.revision,
        successMessage: "Hydration entry deleted and the exact total refreshed.",
      })
    ) {
      setEdit((current) => (current?.entry.id === entry.id ? null : current));
    }
  }

  function confirmDelete(entry: HydrationEntry) {
    Alert.alert(
      "Delete hydration entry?",
      `${entry.amountMilliliters.toLocaleString("en-US")} milliliters will be removed from ${entry.localDate}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void deleteEntry(entry) },
      ],
    );
  }

  const controlsDisabled = busy !== null || state === "loading";
  const createDisabled =
    controlsDisabled || state !== "ready" || day === null || day.localDate !== date;

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
            onChangeText={setDateDraft}
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
            onPress={() => void loadDay(date)}
            style={styles.retryButton}
          >
            <Text style={styles.secondaryText}>Retry day view</Text>
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
            onChangeText={setAmount}
            placeholder="250"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={amount}
          />
          <Text style={styles.label}>LOCAL TIME</Text>
          <TextInput
            accessibilityHint="24-hour time in HH:MM form"
            accessibilityLabel="Hydration local time"
            autoCapitalize="none"
            editable={!createDisabled}
            maxLength={5}
            onChangeText={(value) => {
              untouchedDefaultOccurredAt.current = null;
              setLocalTime(value);
            }}
            placeholder="08:30"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={localTime}
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
                  <Text style={styles.label}>MILLILITERS AT {entry.localTime.slice(0, 5)}</Text>
                  <TextInput
                    accessibilityLabel={`Edit milliliters at ${entry.localTime.slice(0, 5)}`}
                    editable={!controlsDisabled}
                    keyboardType="number-pad"
                    maxLength={5}
                    onChangeText={(value) =>
                      setEdit((current) => (current ? { ...current, amount: value } : current))
                    }
                    style={styles.input}
                    value={edit.amount}
                  />
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => void updateEntry()}
                      style={styles.primarySmall}
                    >
                      <Text style={styles.primaryText}>Save amount</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
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
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => setEdit({ entry, amount: String(entry.amountMilliliters) })}
                      style={styles.secondarySmall}
                    >
                      <Text style={styles.secondaryText}>Edit amount</Text>
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
