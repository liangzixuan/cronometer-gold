import type {
  NutritionReportResponse,
  NutritionReportSeriesPoint,
} from "@nutrition-tracker/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { localDateInTimeZone } from "../diary/diary";
import { palette } from "../theme";
import {
  type NutritionReportRequestFence,
  nutritionReportAdjacentRange,
  nutritionReportBoundarySummary,
  nutritionReportCoverageSummary,
  nutritionReportLocalDates,
  nutritionReportPath,
  nutritionReportPointDisplay,
  nutritionReportRangeEndingAt,
  nutritionReportRequestIdentityMatches,
  nutritionReportTargetMarkerPosition,
  parseNutritionReport,
} from "./reports";

type LoadState = "loading" | "ready" | "error" | "closed";
type PresetDays = 7 | 14 | 30;

interface ReportsScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly expectedOwnerUserId: string;
  readonly profileRevision: string;
  readonly profileTimeZone: string;
  readonly sessionEpoch: number;
  readonly onUnauthorized: () => Promise<void>;
}

interface ReportQuery {
  readonly from: string;
  readonly to: string;
  readonly refresh: number;
}

function percentPosition(value: string): `${number}%` {
  return `${Math.max(0, Math.min(100, Number(value)))}%`;
}

function reportReadyMessage(report: NutritionReportResponse["data"]): string {
  const diaryDays = report.days.filter((day) => day.entryCount > 0).length;
  return `${report.days.length}-day report loaded from one private snapshot. ${diaryDays} ${diaryDays === 1 ? "day has" : "days have"} diary entries.`;
}

function segmentLabel(
  report: NutritionReportResponse["data"],
  goalVersionId: string | null,
): string {
  if (goalVersionId === null) return "No saved goal";
  const goal = report.goalVersions.find((candidate) => candidate.versionId === goalVersionId);
  return goal ? `Saved goal revision ${goal.revision}` : "Saved goal version";
}

function goalBoundaryLabel(
  report: NutritionReportResponse["data"],
  point: NutritionReportSeriesPoint,
  previous: NutritionReportSeriesPoint | undefined,
): string | null {
  if (previous && previous.goalVersionId === point.goalVersionId) return null;
  return `${segmentLabel(report, point.goalVersionId)} begins here.`;
}

export function ReportsScreen({
  apiBase,
  accessToken,
  expectedOwnerUserId,
  profileRevision,
  profileTimeZone,
  sessionEpoch,
  onUnauthorized,
}: ReportsScreenProps) {
  const initialRange = nutritionReportRangeEndingAt(
    localDateInTimeZone(new Date(), profileTimeZone),
    14,
  );
  const [fromDraft, setFromDraft] = useState(initialRange.from);
  const [toDraft, setToDraft] = useState(initialRange.to);
  const [query, setQuery] = useState<ReportQuery>({ ...initialRange, refresh: 0 });
  const [loadedReport, setReport] = useState<NutritionReportResponse["data"] | null>(null);
  const [selectedNutrientCode, setSelectedNutrientCode] = useState("energy");
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private nutrition report…");
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const queryRef = useRef(query);
  const draftRef = useRef({ from: fromDraft, to: toDraft });
  const draftGeneration = useRef(0);
  const reportRef = useRef<NutritionReportResponse["data"] | null>(null);
  const stateRef = useRef<LoadState>("loading");
  const mounted = useRef(false);
  const active = useRef(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const closed = useRef(false);
  const scopeRef = useRef({
    accessToken,
    apiBase: apiBase.toString(),
    expectedOwnerUserId,
    profileRevision,
    profileTimeZone,
    sessionEpoch,
  });
  if (
    scopeRef.current.accessToken !== accessToken ||
    scopeRef.current.apiBase !== apiBase.toString() ||
    scopeRef.current.expectedOwnerUserId !== expectedOwnerUserId ||
    scopeRef.current.profileRevision !== profileRevision ||
    scopeRef.current.profileTimeZone !== profileTimeZone ||
    scopeRef.current.sessionEpoch !== sessionEpoch
  )
    scopeRef.current = {
      accessToken,
      apiBase: apiBase.toString(),
      expectedOwnerUserId,
      profileRevision,
      profileTimeZone,
      sessionEpoch,
    };
  const scope = scopeRef.current;
  const installedScope = useRef<typeof scope | null>(null);
  const closedScope = useRef<typeof scope | null>(null);
  const reportScope = useRef<typeof scope | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const scopeIsCurrent = useCallback(
    () =>
      mounted.current &&
      active.current &&
      !closed.current &&
      scopeRef.current === scope &&
      installedScope.current === scope,
    [scope],
  );
  const setLoadState = useCallback((next: LoadState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const clearSnapshot = useCallback(() => {
    reportRef.current = null;
    reportScope.current = null;
    setReport(null);
  }, []);
  const load = useCallback(
    async (requested: ReportQuery) => {
      if (!scopeIsCurrent() || queryRef.current !== requested) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const initiating: NutritionReportRequestFence = {
        from: requested.from,
        generation,
        ownerUserId: scope.expectedOwnerUserId,
        profileRevision: scope.profileRevision,
        sessionEpoch: scope.sessionEpoch,
        timeZone: scope.profileTimeZone,
        to: requested.to,
      };
      const requestIsCurrent = () =>
        scopeIsCurrent() &&
        queryRef.current === requested &&
        controllerRef.current === controller &&
        !controller.signal.aborted &&
        nutritionReportRequestIdentityMatches(
          {
            from: queryRef.current.from,
            generation: generationRef.current,
            ownerUserId: scopeRef.current.expectedOwnerUserId,
            profileRevision: scopeRef.current.profileRevision,
            sessionEpoch: scopeRef.current.sessionEpoch,
            timeZone: scopeRef.current.profileTimeZone,
            to: queryRef.current.to,
          },
          initiating,
        );
      setLoadState("loading");
      clearSnapshot();
      setMessage(`Loading ${requested.from} through ${requested.to}…`);
      try {
        const response = await fetch(
          apiUrl(
            new URL(scope.apiBase),
            nutritionReportPath(requested.from, requested.to),
          ).toString(),
          {
            cache: "no-store",
            headers: authenticatedHeaders(scope.accessToken),
            signal: controller.signal,
          },
        );
        if (!requestIsCurrent()) return;
        if (response.status === 401) {
          closed.current = true;
          closedScope.current = scope;
          lifecycleRef.current += 1;
          generationRef.current += 1;
          controller.abort();
          clearSnapshot();
          setLoadState("closed");
          setMessage("Closing your private nutrition report…");
          await onUnauthorizedRef.current();
          return;
        }
        const body = await jsonBody(response);
        if (!requestIsCurrent()) return;
        if (!response.ok)
          throw new Error(responseError(body, "The nutrition report could not be loaded."));
        const parsed = parseNutritionReport(body, {
          from: requested.from,
          ownerUserId: scope.expectedOwnerUserId,
          profileRevision: scope.profileRevision,
          timeZone: scope.profileTimeZone,
          to: requested.to,
        });
        if (!requestIsCurrent()) return;
        reportRef.current = parsed;
        reportScope.current = scope;
        setReport(parsed);
        setSelectedNutrientCode((current) =>
          parsed.series.some((series) => series.nutrient.code === current)
            ? current
            : (parsed.series[0]?.nutrient.code ?? "energy"),
        );
        setLoadState("ready");
        setMessage(reportReadyMessage(parsed));
      } catch (caught) {
        if (!requestIsCurrent()) return;
        clearSnapshot();
        setLoadState("error");
        setMessage(
          caught instanceof Error ? caught.message : "The nutrition report could not be loaded.",
        );
      }
    },
    [clearSnapshot, scope, scopeIsCurrent, setLoadState],
  );

  useEffect(() => {
    mounted.current = true;
    installedScope.current = scope;
    lifecycleRef.current += 1;
    closed.current = closedScope.current === scope;
    active.current = AppState.currentState !== "background" && AppState.currentState !== "inactive";
    generationRef.current += 1;
    draftGeneration.current += 1;
    controllerRef.current?.abort();
    clearSnapshot();
    setLoadState(closed.current ? "closed" : "loading");
    return () => {
      mounted.current = false;
      installedScope.current = null;
      lifecycleRef.current += 1;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [clearSnapshot, scope, setLoadState]);
  useEffect(() => {
    void load(query);
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load, query]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (!mounted.current || scopeRef.current !== scope || closed.current) return;
      if (next !== "active") {
        active.current = false;
        lifecycleRef.current += 1;
        generationRef.current += 1;
        draftGeneration.current += 1;
        controllerRef.current?.abort();
        clearSnapshot();
        setLoadState("loading");
        setMessage("Return to the app to reload this private report.");
      } else if (!active.current) {
        active.current = true;
        const refreshed = { ...queryRef.current, refresh: queryRef.current.refresh + 1 };
        queryRef.current = refreshed;
        setQuery(refreshed);
      }
    });
    return () => subscription.remove();
  }, [clearSnapshot, scope, setLoadState]);

  const renderLifecycle = lifecycleRef.current;
  const renderDraftGeneration = draftGeneration.current;
  function canAct() {
    return (
      scopeIsCurrent() && queryRef.current === query && lifecycleRef.current === renderLifecycle
    );
  }
  function currentDraftAction() {
    return canAct() && draftGeneration.current === renderDraftGeneration;
  }
  function setDraftDate(field: "from" | "to", value: string) {
    if (!canAct()) return;
    if (draftRef.current[field] === value) return;
    draftRef.current = { ...draftRef.current, [field]: value };
    draftGeneration.current += 1;
    if (field === "from") setFromDraft(value);
    else setToDraft(value);
  }
  function commitRange(from: string, to: string) {
    generationRef.current += 1;
    controllerRef.current?.abort();
    clearSnapshot();
    draftGeneration.current += 1;
    draftRef.current = { from, to };
    setFromDraft(from);
    setToDraft(to);
    const next = { from, to, refresh: queryRef.current.refresh + 1 };
    queryRef.current = next;
    setLoadState("loading");
    setMessage(`Loading ${from} through ${to}…`);
    setQuery(next);
  }
  function applyRange(from: string, to: string) {
    if (!currentDraftAction()) return;
    try {
      nutritionReportLocalDates(from, to);
      commitRange(from, to);
    } catch (caught) {
      generationRef.current += 1;
      controllerRef.current?.abort();
      clearSnapshot();
      setLoadState("error");
      setMessage(
        caught instanceof Error
          ? caught.message
          : "Choose a valid inclusive report range of 1 to 31 local days.",
      );
    }
  }
  function applyPreset(days: PresetDays) {
    if (!currentDraftAction()) return;
    const today = localDateInTimeZone(new Date(), scope.profileTimeZone);
    const range = nutritionReportRangeEndingAt(today, days);
    applyRange(range.from, range.to);
  }
  const scopeVisible = scopeIsCurrent();
  const report =
    scopeVisible &&
    state === "ready" &&
    reportScope.current === scope &&
    reportRef.current === loadedReport &&
    loadedReport?.from === query.from &&
    loadedReport?.to === query.to
      ? loadedReport
      : null;
  const datesDirty = fromDraft !== query.from || toDraft !== query.to;
  const previousPeriod = report
    ? nutritionReportAdjacentRange(report.from, report.to, "previous")
    : null;
  const nextPeriod = report ? nutritionReportAdjacentRange(report.from, report.to, "next") : null;
  function movePeriod(direction: "previous" | "next") {
    if (
      !currentDraftAction() ||
      stateRef.current !== "ready" ||
      !report ||
      reportRef.current !== report ||
      draftRef.current.from !== query.from ||
      draftRef.current.to !== query.to
    )
      return;
    const next = nutritionReportAdjacentRange(report.from, report.to, direction);
    if (next) commitRange(next.from, next.to);
  }

  const selectedSeries =
    report?.series.find((series) => series.nutrient.code === selectedNutrientCode) ?? null;

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.kicker}>PRIVATE MULTI-DAY SNAPSHOT</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Nutrition report
        </Text>
        <Text style={styles.zone}>{profileTimeZone}</Text>
        <Text style={styles.intro}>
          Compare calories, macros, and micronutrients across up to 31 profile-local days. Missing
          and trace data remain visibly qualified instead of becoming zero.
        </Text>

        <View accessibilityRole="toolbar" style={styles.presetRow}>
          {([7, 14, 30] as const).map((days) => (
            <Pressable
              accessibilityLabel={`Show the last ${days} profile-local days`}
              accessibilityRole="button"
              key={days}
              disabled={!scopeVisible}
              accessibilityState={{ disabled: !scopeVisible }}
              onPress={() => applyPreset(days)}
              style={styles.presetButton}
            >
              <Text style={styles.presetText}>{days} days</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.rangeCard}>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput
              accessibilityLabel="Report start date YYYY-MM-DD"
              autoCapitalize="none"
              maxLength={10}
              editable={scopeVisible}
              onChangeText={(value) => setDraftDate("from", value)}
              returnKeyType="done"
              style={styles.dateInput}
              value={fromDraft}
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>Through</Text>
            <TextInput
              accessibilityLabel="Report end date YYYY-MM-DD"
              autoCapitalize="none"
              maxLength={10}
              editable={scopeVisible}
              onChangeText={(value) => setDraftDate("to", value)}
              returnKeyType="done"
              style={styles.dateInput}
              value={toDraft}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!scopeVisible}
            accessibilityState={{ disabled: !scopeVisible }}
            onPress={() => applyRange(fromDraft, toDraft)}
            style={styles.updateButton}
          >
            <Text style={styles.updateText}>Update report</Text>
          </Pressable>
        </View>

        <View style={styles.presetRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !previousPeriod || datesDirty }}
            disabled={!previousPeriod || datesDirty}
            onPress={() => movePeriod("previous")}
            style={[styles.secondaryButton, (!previousPeriod || datesDirty) && styles.disabled]}
          >
            <Text style={styles.secondaryText}>Previous period</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !nextPeriod || datesDirty }}
            disabled={!nextPeriod || datesDirty}
            onPress={() => movePeriod("next")}
            style={[styles.secondaryButton, (!nextPeriod || datesDirty) && styles.disabled]}
          >
            <Text style={styles.secondaryText}>Next period</Text>
          </Pressable>
        </View>
        {scopeVisible && datesDirty ? (
          <Text style={styles.status}>
            Choose Update report to apply these dates before moving to another period.
          </Text>
        ) : null}

        <View
          accessibilityLiveRegion="polite"
          accessibilityRole={state === "error" ? "alert" : "summary"}
          style={styles.statusRow}
        >
          {state === "loading" ? (
            <ActivityIndicator
              accessibilityLabel="Loading nutrition report"
              color={palette.forest}
            />
          ) : null}
          <Text style={[styles.status, state === "error" ? styles.error : null]}>
            {scopeVisible || state === "closed"
              ? message
              : "Opening your private nutrition report…"}
          </Text>
        </View>
        {scopeVisible && state === "error" ? (
          <Pressable
            accessibilityRole="button"
            disabled={!scopeVisible}
            onPress={() => {
              if (currentDraftAction()) commitRange(query.from, query.to);
            }}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryText}>Retry this range</Text>
          </Pressable>
        ) : null}

        {report && selectedSeries ? (
          <>
            <View accessibilityRole="summary" style={styles.snapshotCard}>
              <Text style={styles.cardTitle}>
                {report.from} through {report.to}
              </Text>
              <Text style={styles.metaText}>
                Profile-local zone {report.timeZone} · profile revision {report.profileRevision} ·
                data revision {report.watermarkRevision}
              </Text>
              <Text style={styles.metaText}>
                Snapshot captured {report.snapshotAt}. Later diary or goal changes are not included.
              </Text>
              <Text style={styles.notice}>{report.notice}</Text>
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Choose a nutrient
              </Text>
              <View style={styles.nutrientGrid}>
                {report.series.map((series) => {
                  const selected = series.nutrient.code === selectedSeries.nutrient.code;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={series.nutrient.id}
                      onPress={() => {
                        if (canAct() && reportRef.current === report)
                          setSelectedNutrientCode(series.nutrient.code);
                      }}
                      style={[
                        styles.nutrientButton,
                        selected ? styles.nutrientButtonSelected : null,
                      ]}
                    >
                      <Text
                        style={[styles.nutrientText, selected ? styles.nutrientTextSelected : null]}
                      >
                        {series.nutrient.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                {selectedSeries.nutrient.name} by day
              </Text>
              <Text style={styles.summaryText}>
                {nutritionReportCoverageSummary(selectedSeries)}
              </Text>
              <Text style={styles.legend}>
                Filled bars show the known amount against a shared {selectedSeries.scaleMaximum}{" "}
                {selectedSeries.nutrient.unit} scale. A thin line marks a saved daily target when
                one exists. The exact daily values and coverage are listed below.
              </Text>
              <View style={styles.chartCard}>
                {selectedSeries.points.map((point) => {
                  const display = nutritionReportPointDisplay(point, selectedSeries.nutrient.unit);
                  return (
                    <View
                      accessible
                      accessibilityLabel={`${point.localDate}. ${display.amount}. ${display.coverage}. ${display.comparison}`}
                      accessibilityRole="summary"
                      key={point.localDate}
                      style={styles.chartRow}
                    >
                      <Text style={styles.chartDate}>{point.localDate.slice(5)}</Text>
                      <View
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                        style={styles.barTrack}
                      >
                        {point.knownPercentOfScale !== null ? (
                          <View
                            style={[
                              styles.barFill,
                              { width: percentPosition(point.knownPercentOfScale) },
                            ]}
                          />
                        ) : null}
                        {point.targetPercentOfScale !== null ? (
                          <View
                            style={[
                              styles.targetMarker,
                              nutritionReportTargetMarkerPosition(point.targetPercentOfScale),
                            ]}
                          />
                        ) : null}
                      </View>
                      <Text style={styles.chartAmount}>{display.amount}</Text>
                    </View>
                  );
                })}
              </View>
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Saved-target periods
              </Text>
              <Text style={styles.summaryText}>
                {nutritionReportBoundarySummary(report.targetSegments)}
              </Text>
              {report.targetSegments.map((segment) => (
                <View
                  key={`${segment.from}:${segment.to}:${segment.goalVersionId ?? "none"}`}
                  style={styles.segmentRow}
                >
                  <Text style={styles.segmentDates}>
                    {segment.from === segment.to
                      ? segment.from
                      : `${segment.from} through ${segment.to}`}
                  </Text>
                  <Text style={styles.segmentGoal}>
                    {segmentLabel(report, segment.goalVersionId)}
                  </Text>
                </View>
              ))}
              <Text style={styles.caution}>
                Comparisons use the immutable saved goal version declared for each period at this
                report snapshot. They are descriptive, not a nutrition score or medical advice.
              </Text>
            </View>

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Exact daily list
              </Text>
              {selectedSeries.points.map((point, index) => {
                const display = nutritionReportPointDisplay(point, selectedSeries.nutrient.unit);
                const boundary = goalBoundaryLabel(report, point, selectedSeries.points[index - 1]);
                return (
                  <View key={point.localDate} style={styles.dayCard}>
                    <View style={styles.dayHeading}>
                      <Text style={styles.dayDate}>{point.localDate}</Text>
                      <Text style={styles.dayAmount}>{display.amount}</Text>
                    </View>
                    {boundary ? <Text style={styles.boundary}>{boundary}</Text> : null}
                    <Text style={styles.coverage}>{display.coverage}</Text>
                    <Text style={styles.comparison}>{display.comparison}</Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.paper },
  disabled: { opacity: 0.5 },
  content: { padding: 20, paddingBottom: 48, gap: 16 },
  kicker: { color: palette.forest, fontSize: 12, fontWeight: "800", letterSpacing: 1.4 },
  title: { color: palette.ink, fontSize: 32, fontWeight: "800" },
  zone: { color: palette.muted, fontSize: 13, marginTop: -10 },
  intro: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  presetButton: {
    borderColor: palette.forest,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  presetText: { color: palette.forest, fontSize: 14, fontWeight: "700" },
  rangeCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  dateField: { gap: 5 },
  fieldLabel: { color: palette.ink, fontSize: 13, fontWeight: "700" },
  dateInput: {
    backgroundColor: palette.paper,
    borderColor: palette.line,
    borderRadius: 10,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  updateButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  updateText: { color: palette.white, fontSize: 15, fontWeight: "800" },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 10, minHeight: 28 },
  status: { color: palette.muted, flex: 1, fontSize: 14, lineHeight: 20 },
  error: { color: "#8b2f26" },
  secondaryButton: {
    alignItems: "center",
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    padding: 11,
  },
  secondaryText: { color: palette.forest, fontWeight: "800" },
  snapshotCard: {
    backgroundColor: palette.forest,
    borderRadius: 16,
    gap: 7,
    padding: 16,
  },
  cardTitle: { color: palette.white, fontSize: 18, fontWeight: "800" },
  metaText: { color: palette.white, fontSize: 13, lineHeight: 19, opacity: 0.88 },
  notice: { color: palette.lime, fontSize: 13, fontWeight: "700", lineHeight: 19 },
  section: { gap: 10 },
  sectionTitle: { color: palette.ink, fontSize: 21, fontWeight: "800" },
  summaryText: { color: palette.ink, fontSize: 14, lineHeight: 20 },
  nutrientGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  nutrientButton: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  nutrientButtonSelected: { backgroundColor: palette.forest, borderColor: palette.forest },
  nutrientText: { color: palette.ink, fontSize: 13, fontWeight: "700" },
  nutrientTextSelected: { color: palette.white },
  legend: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  chartCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    gap: 9,
    padding: 14,
  },
  chartRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  chartDate: { color: palette.muted, fontSize: 11, width: 34 },
  chartAmount: { color: palette.ink, fontSize: 11, textAlign: "right", width: 92 },
  barTrack: {
    backgroundColor: palette.paper,
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    height: 14,
    overflow: "hidden",
    position: "relative",
  },
  barFill: { backgroundColor: palette.lime, bottom: 0, left: 0, position: "absolute", top: 0 },
  targetMarker: {
    backgroundColor: palette.forest,
    bottom: 0,
    position: "absolute",
    top: 0,
    width: 2,
  },
  segmentRow: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  segmentDates: { color: palette.ink, fontSize: 14, fontWeight: "800" },
  segmentGoal: { color: palette.muted, fontSize: 13 },
  caution: { color: palette.muted, fontSize: 12, fontStyle: "italic", lineHeight: 18 },
  dayCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    gap: 5,
    padding: 13,
  },
  dayHeading: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  dayDate: { color: palette.ink, fontSize: 15, fontWeight: "800" },
  dayAmount: { color: palette.forest, fontSize: 15, fontWeight: "800" },
  boundary: { color: palette.forest, fontSize: 12, fontWeight: "800" },
  coverage: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  comparison: { color: palette.ink, fontSize: 13, lineHeight: 18 },
});
