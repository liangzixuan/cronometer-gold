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
import { palette } from "../theme";
import {
  type DiaryDay,
  type DiaryEntry,
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
  quickAddOccurredAt,
  shiftLocalDate,
} from "./diary";

type LoadState = "loading" | "ready" | "error";

interface Editor {
  readonly entryId: string;
  readonly quantity: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
  readonly originalLocalTime: string;
  readonly timeZone: string;
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

function editorFor(entry: DiaryEntry, currentProfileTimeZone: string): Editor {
  const localTime = entry.localTime.slice(0, 5);
  return {
    entryId: entry.id,
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
  const [date, setDate] = useState(() =>
    requestedDate && isLocalDate(requestedDate)
      ? requestedDate
      : localDateInTimeZone(new Date(), profileTimeZone),
  );
  const [diary, setDiary] = useState<DiaryDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private diary…");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const operationIds = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(
    async (requested: string) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      setState("loading");
      setMessage(`Loading ${requested}…`);
      try {
        const url = apiUrl(apiBase, "/v1/diary");
        url.searchParams.set("date", requested);
        const response = await fetch(url.toString(), {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        });
        if (response.status === 401) return onUnauthorized();
        const body = await jsonBody(response);
        if (!response.ok) throw new Error(responseError(body, "The diary could not be loaded."));
        const next = parseDiaryDay(body);
        if (!controller.signal.aborted) {
          setDiary(next);
          setState("ready");
          setMessage(
            next.entries.length === 0
              ? "No foods logged for this local day."
              : `${next.entries.length} ${next.entries.length === 1 ? "entry" : "entries"} loaded.`,
          );
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setDiary(null);
          setState("error");
          setMessage(caught instanceof Error ? caught.message : "The diary could not be loaded.");
        }
      }
    },
    [accessToken, apiBase, onUnauthorized],
  );

  useEffect(() => {
    if (requestedDate && isLocalDate(requestedDate)) setDate(requestedDate);
  }, [requestedDate]);

  useEffect(() => {
    void refreshKey;
    void load(date);
    return () => loadController.current?.abort();
  }, [date, load, refreshKey]);

  function operationId(key: string): string {
    const existing = operationIds.current.get(key);
    if (existing) return existing;
    const created = newOperationId();
    operationIds.current.set(key, created);
    return created;
  }

  function selectDate(next: string) {
    if (!isLocalDate(next)) {
      setMessage("Date must use YYYY-MM-DD and be a real calendar day.");
      return;
    }
    setEditor(null);
    setDate(next);
  }

  async function save() {
    if (!editor || !diary || !isPositiveDecimal(editor.quantity)) {
      setMessage("Quantity must be a positive decimal number.");
      return;
    }
    const entry = diary.entries.find((candidate) => candidate.id === editor.entryId);
    if (!entry) return;
    const timestampChanged =
      editor.localDate !== entry.localDate || editor.localTime !== editor.originalLocalTime;
    let occurredAt: string | undefined;
    if (timestampChanged) {
      try {
        occurredAt = localDateTimeToInstant(editor.localDate, editor.localTime, editor.timeZone);
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
    };
    const key = `edit:${entry.id}:${entry.revision}:${JSON.stringify(body)}`;
    setBusyEntry(entry.id);
    setMessage("Saving the diary entry…");
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/diary/entries/${entry.id}`).toString(), {
        method: "PATCH",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operationId(key),
          "if-match": `"${entry.revision}"`,
        }),
        body: JSON.stringify(body),
      });
      if (response.status === 401) return onUnauthorized();
      const responseBody = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        setEditor(null);
        await load(date);
        setMessage("The diary changed elsewhere. Fresh values were loaded; review the edit again.");
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The entry could not be saved."));
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      setEditor(null);
      const savedDate = mutation.entry?.localDate ?? editor.localDate;
      if (savedDate !== date) setDate(savedDate);
      else {
        await load(date);
        setMessage("Diary entry saved with fresh totals.");
      }
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The entry could not be saved."} Press Save again to retry safely.`,
      );
    } finally {
      setBusyEntry(null);
    }
  }

  async function remove(entry: DiaryEntry) {
    const key = `delete:${entry.id}:${entry.revision}`;
    setBusyEntry(entry.id);
    setMessage("Deleting the diary entry…");
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/diary/entries/${entry.id}`).toString(), {
        method: "DELETE",
        headers: authenticatedHeaders(accessToken, {
          "idempotency-key": operationId(key),
          "if-match": `"${entry.revision}"`,
        }),
      });
      if (response.status === 401) return onUnauthorized();
      const body = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        await load(date);
        setMessage(
          "The diary changed elsewhere. Fresh values were loaded; delete again if needed.",
        );
        return;
      }
      if (!response.ok) throw new Error(responseError(body, "The entry could not be deleted."));
      parseDiaryMutation(body);
      operationIds.current.delete(key);
      await load(date);
      setMessage("Diary entry deleted and totals refreshed.");
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The entry could not be deleted."} Choose Delete again to retry safely.`,
      );
    } finally {
      setBusyEntry(null);
    }
  }

  async function repeat(entry: DiaryEntry) {
    const now = new Date();
    const targetDate = localDateInTimeZone(now, profileTimeZone);
    const body = {
      occurredAt: quickAddOccurredAt(targetDate, profileTimeZone, now),
      mealSlot: entry.mealSlot,
    };
    const key = `repeat:${entry.id}:${entry.revision}:${JSON.stringify(body)}`;
    setBusyEntry(entry.id);
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
      if (response.status === 401) return onUnauthorized();
      const responseBody = await jsonBody(response);
      if (response.status === 412) {
        operationIds.current.delete(key);
        await load(date);
        setMessage("The source entry changed. Fresh details were loaded; review before repeating.");
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The entry could not be repeated."));
      const mutation = parseDiaryMutation(responseBody);
      operationIds.current.delete(key);
      const repeatedDate = mutation.entry?.localDate ?? targetDate;
      if (repeatedDate === date) await load(date);
      else setDate(repeatedDate);
      setMessage("Pinned entry version repeated with fresh authoritative totals.");
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The entry could not be repeated."} Choose Repeat again to retry the same operation safely.`,
      );
    } finally {
      setBusyEntry(null);
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
            onPress={() => selectDate(shiftLocalDate(date, -1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>←</Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Diary date YYYY-MM-DD"
            autoCapitalize="none"
            maxLength={10}
            onEndEditing={(event) => selectDate(event.nativeEvent.text)}
            onChangeText={setDate}
            style={styles.dateInput}
            value={date}
          />
          <Pressable
            accessibilityLabel="Next day"
            accessibilityRole="button"
            onPress={() => selectDate(shiftLocalDate(date, 1))}
            style={styles.squareButton}
          >
            <Text style={styles.squareText}>→</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => selectDate(localDateInTimeZone(new Date(), activeTimeZone))}
          style={styles.todayButton}
        >
          <Text style={styles.todayText}>Jump to today</Text>
        </Pressable>

        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, state === "error" && styles.error]}
        >
          {message}
        </Text>
        {state === "loading" ? <ActivityIndicator color={palette.forest} /> : null}
        {state === "error" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void load(date)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        ) : null}

        {diary && diary.entries.length === 0 && state === "ready" ? (
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
                    <Text style={styles.emptyMeal}>No entries</Text>
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
                              accessibilityLabel={`Entry local time in ${editor.timeZone}`}
                              keyboardType="numbers-and-punctuation"
                              maxLength={5}
                              onChangeText={(localTime) => setEditor({ ...editor, localTime })}
                              style={styles.input}
                              value={editor.localTime}
                            />
                            <Text style={styles.entrySource}>
                              Changed date and time are interpreted in {editor.timeZone}.
                            </Text>
                            <View style={styles.actionRow}>
                              <Pressable
                                accessibilityRole="button"
                                disabled={busyEntry === entry.id || diary.status === "locked"}
                                onPress={() => void save()}
                                style={styles.primarySmall}
                              >
                                <Text style={styles.primaryText}>
                                  {busyEntry === entry.id ? "Saving…" : "Save"}
                                </Text>
                              </Pressable>
                              <Pressable
                                accessibilityRole="button"
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
                              disabled={busyEntry === entry.id}
                              onPress={() => void repeat(entry)}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Repeat today</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              disabled={busyEntry === entry.id || diary.status === "locked"}
                              onPress={() => setEditor(editorFor(entry, diary.timeZone))}
                              style={styles.secondarySmall}
                            >
                              <Text style={styles.secondaryText}>Edit</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              disabled={busyEntry === entry.id || diary.status === "locked"}
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
              Partial totals are lower bounds. Unknown values are never counted as zero.
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
  mealHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  mealSection: { marginTop: 32 },
  mealTitle: { color: palette.ink, fontSize: 26, fontWeight: "700", letterSpacing: -0.8 },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 18 },
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
