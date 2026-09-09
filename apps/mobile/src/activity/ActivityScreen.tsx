import type { ActivityEntry } from "@nutrition-tracker/contracts";
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
  const initialDate = todayDetailDate(requestedDate, profileTimeZone, initialNow);
  const [date, setDate] = useState(initialDate);
  const [dateDraft, setDateDraft] = useState(initialDate);
  const [day, setDay] = useState<ReturnType<typeof parseActivityDay> | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private activity history…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [selfReportedEnergyKilocalories, setSelfReportedEnergyKilocalories] = useState("");
  const [localTime, setLocalTime] = useState(localTimeInTimeZone(initialNow, profileTimeZone));
  const [edit, setEdit] = useState<ActivityEditDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(initialNow.toISOString());

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
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
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (response.status === 401) {
          await onUnauthorized();
          return false;
        }
        const body = await jsonBody(response);
        if (controller.signal.aborted || loadGeneration.current !== generation) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Activity history could not be loaded."));
        }
        const next = parseActivityDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The activity service returned another local day.");
        }
        if (loadedTimeZone.current !== next.timeZone) {
          const capturedNow = new Date();
          setLocalTime(localTimeInTimeZone(capturedNow, next.timeZone));
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
          error instanceof Error ? error.message : "Activity history could not be loaded.",
        );
        return false;
      }
    },
    [accessToken, apiBase, expectedOwnerUserId, onUnauthorized],
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
    readonly validates: (mutation: ActivityMutation) => boolean;
  }): Promise<ActivityMutation | null> {
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
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
      });
      if (response.status === 401) {
        await onUnauthorized();
        return null;
      }
      const body = await jsonBody(response);
      if (!response.ok) {
        if (isActivityTimeZoneChangedProblem(response.status, body)) {
          operations.current.delete(input.intentKey);
          const retainedLocalTime = localTime;
          const refreshed = await loadDay(date);
          setLocalTime(retainedLocalTime);
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
      const refreshed = await loadDay(date, input.successMessage);
      if (!refreshed) {
        setState("error");
        setMessageIsError(true);
        setMessage(
          "The activity change was accepted, but the exact local-day view could not be refreshed. Retry the day view; do not submit the change again.",
        );
      }
      return mutation;
    } catch (error) {
      setState("error");
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The activity could not be changed."} Retry without changing the fields to safely reuse the same operation; do not assume it was saved.`,
      );
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createEntry() {
    if (!day || day.localDate !== date || state !== "ready") {
      setMessageIsError(true);
      setMessage("Load the selected activity day before adding an entry.");
      return;
    }
    try {
      const prepared = prepareActivityCreate(
        name,
        durationMinutes,
        selfReportedEnergyKilocalories,
        date,
        localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      const intentKey = `create:${expectedOwnerUserId}:${prepared.expectedTimeZone}:${JSON.stringify(prepared.body)}`;
      const mutation = await mutate({
        intentKey,
        path: "/v1/activities/entries?profileTimeZonePrecondition=v1",
        method: "POST",
        body: prepared.body,
        expectedTimeZone: prepared.expectedTimeZone,
        successMessage: `${prepared.body.name} was added to your private activity history.`,
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
      if (mutation) {
        setName("");
        setDurationMinutes("");
        setSelfReportedEnergyKilocalories("");
        const capturedNow = new Date();
        const activeZone = day.timeZone;
        setLocalTime(localTimeInTimeZone(capturedNow, activeZone));
        untouchedDefaultOccurredAt.current = capturedNow.toISOString();
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid activity.");
    }
  }

  async function updateEntry() {
    if (!edit || !day) return;
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
    Alert.alert(
      "Delete activity?",
      `${entry.name} will be removed from ${entry.localDate}. Its calories never adjusted your nutrition target or balance.`,
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
            onChangeText={setDateDraft}
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
            onPress={() => void loadDay(date)}
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

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Add an activity
          </Text>
          <Text style={styles.label}>ACTIVITY NAME</Text>
          <TextInput
            accessibilityLabel="Activity name"
            editable={!createDisabled}
            maxLength={240}
            onChangeText={setName}
            placeholder="Walk"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={name}
          />
          <Text style={styles.label}>DURATION · WHOLE MINUTES</Text>
          <TextInput
            accessibilityHint="Whole minutes from 1 through 1,440"
            accessibilityLabel="Activity duration in whole minutes"
            editable={!createDisabled}
            keyboardType="number-pad"
            maxLength={4}
            onChangeText={setDurationMinutes}
            placeholder="30"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={durationMinutes}
          />
          <Text style={styles.label}>SELF-REPORTED CALORIES · OPTIONAL</Text>
          <TextInput
            accessibilityHint="Optional value from 0.001 through 20,000 kilocalories"
            accessibilityLabel="Optional self-reported activity calories"
            editable={!createDisabled}
            keyboardType="decimal-pad"
            maxLength={9}
            onChangeText={setSelfReportedEnergyKilocalories}
            placeholder="Leave blank"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={selfReportedEnergyKilocalories}
          />
          <Text style={styles.label}>LOCAL START TIME</Text>
          <TextInput
            accessibilityHint="24-hour time in HH:MM form"
            accessibilityLabel="Activity local start time"
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
                    onChangeText={(value) =>
                      setEdit((current) => (current ? { ...current, name: value } : current))
                    }
                    style={styles.input}
                    value={edit.name}
                  />
                  <Text style={styles.label}>DURATION · WHOLE MINUTES</Text>
                  <TextInput
                    accessibilityLabel="Edit activity duration in whole minutes"
                    editable={!controlsDisabled}
                    keyboardType="number-pad"
                    maxLength={4}
                    onChangeText={(value) =>
                      setEdit((current) =>
                        current ? { ...current, durationMinutes: value } : current,
                      )
                    }
                    style={styles.input}
                    value={edit.durationMinutes}
                  />
                  <Text style={styles.label}>SELF-REPORTED CALORIES · OPTIONAL</Text>
                  <TextInput
                    accessibilityLabel="Edit optional self-reported activity calories"
                    editable={!controlsDisabled}
                    keyboardType="decimal-pad"
                    maxLength={9}
                    onChangeText={(value) =>
                      setEdit((current) =>
                        current ? { ...current, selfReportedEnergyKilocalories: value } : current,
                      )
                    }
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
                    onChangeText={(value) =>
                      setEdit((current) => (current ? { ...current, localDate: value } : current))
                    }
                    style={styles.input}
                    value={edit.localDate}
                  />
                  <Text style={styles.label}>LOCAL START TIME</Text>
                  <TextInput
                    accessibilityLabel="Edit activity local start time"
                    autoCapitalize="none"
                    editable={!controlsDisabled}
                    maxLength={5}
                    onChangeText={(value) =>
                      setEdit((current) => (current ? { ...current, localTime: value } : current))
                    }
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
                      accessibilityRole="button"
                      accessibilityState={{ disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      onPress={() => setEdit(editDraft(entry))}
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
