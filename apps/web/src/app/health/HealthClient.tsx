"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  parseSession,
  quoteRevision,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import { confirmBrowserLogout } from "../../lib/private-api";
import { installPrivateDataForOwner, PrivateOwnerFenceError } from "../../lib/private-owner";
import { parseTargetableNutrients, type TargetableNutrient } from "../../lib/recipes-goals";
import {
  type AccountErasureJob,
  type AccountExportJob,
  type BiometricDefinition,
  type BiometricEvent,
  type BiometricTrend,
  biometricEventLocalTimeUnchanged,
  isSignedExactDecimal,
  type NutrientTrend,
  operationId,
  type PlatformIntegration,
  parseBiometricDefinitionResponse,
  parseBiometricDefinitions,
  parseBiometricEvents,
  parseBiometricMutation,
  parseBiometricTrend,
  parseErasureJob,
  parseExportJob,
  parseIntegrations,
  parseNutrientTrend,
  parseReauthentication,
  parseReminderResponse,
  parseReminders,
  type Reminder,
  trendAggregateLabel,
} from "../../lib/retention";
import { AppNavigation } from "../ui/AppNavigation";
import { Icon } from "../ui/Icon";

type LoadState = "loading" | "ready" | "error";
type HealthSection = "nutrients" | "biometrics" | "reminders" | "integrations";
const healthSections: readonly HealthSection[] = [
  "nutrients",
  "biometrics",
  "reminders",
  "integrations",
];
const healthSectionLabels: Record<HealthSection, string> = {
  nutrients: "nutrient choices",
  biometrics: "biometrics",
  reminders: "reminders",
  integrations: "health integrations",
};

type TrendKind = "nutrition" | "biometric";
interface TrendRequest {
  readonly key: string;
  readonly ownerUserId: string;
  readonly profileScope: string;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly seriesId: string;
}
type TrendResult =
  | { readonly kind: "nutrition"; readonly data: NutrientTrend }
  | { readonly kind: "biometric"; readonly data: BiometricTrend };
interface TrendRead {
  readonly request: TrendRequest;
  readonly status: LoadState;
  readonly result: TrendResult | null;
  readonly message: string;
}
function trendRequest(
  session: SessionSummary,
  range: { readonly from: string; readonly to: string },
  seriesId: string,
  generation: number,
): TrendRequest | null {
  if (!seriesId || !isLocalDate(range.from) || !isLocalDate(range.to) || range.from > range.to)
    return null;
  const profileScope = JSON.stringify([session.user.id, session.profile]);
  return {
    key: JSON.stringify([profileScope, range.from, range.to, seriesId, generation]),
    ownerUserId: session.user.id,
    profileScope,
    timeZone: session.profile.timeZone,
    from: range.from,
    to: range.to,
    seriesId,
  };
}

interface BiometricWindow {
  readonly from: string;
  readonly to: string;
}
interface BiometricHistory {
  readonly window: BiometricWindow | null;
  readonly events: readonly BiometricEvent[];
  readonly cursor: string | null;
  readonly status: LoadState;
  readonly verified: boolean;
  readonly message: string;
  readonly owner: string | null;
}
const HISTORY_DAY = 86_400_000;
const HISTORY_WIDTH = 121 * HISTORY_DAY;
const HISTORY_MIN = Date.parse("0100-01-02T00:00:00.000Z");
const HISTORY_MAX = Date.parse("9999-12-30T23:59:59.999Z");
function historyWindow(from: number, to: number): BiometricWindow | null {
  return Number.isFinite(from) &&
    Number.isFinite(to) &&
    from >= HISTORY_MIN &&
    to <= HISTORY_MAX &&
    to - from === HISTORY_WIDTH
    ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
    : null;
}
function eventInWindow(event: BiometricEvent, range: BiometricWindow): boolean {
  const measured = Date.parse(event.measuredAt);
  return measured >= Date.parse(range.from) && measured <= Date.parse(range.to);
}
function emptyHistory(): BiometricHistory {
  return {
    window: null,
    events: [],
    cursor: null,
    status: "loading",
    verified: false,
    message: "Biometric history has not been loaded.",
    owner: null,
  };
}

interface ReminderDraft {
  readonly id: string | null;
  readonly revision: string | null;
  readonly label: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly status: "active" | "paused";
}

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

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

class PrivateRequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

function reminderDraft(reminder?: Reminder): ReminderDraft {
  return reminder
    ? {
        id: reminder.id,
        revision: reminder.revision,
        label: reminder.label,
        localTime: reminder.localTime,
        daysOfWeek: reminder.daysOfWeek,
        status: reminder.status === "paused" ? "paused" : "active",
      }
    : {
        id: null,
        revision: null,
        label: "",
        localTime: "20:00",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        status: "active",
      };
}

export function HealthClient() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<HealthSection, string>>>({});
  const [sectionLoading, setSectionLoading] = useState<Partial<Record<HealthSection, boolean>>>({});
  const sectionControllers = useRef<Partial<Record<HealthSection, AbortController>>>({});

  const [message, setMessage] = useState("Opening your private health workspace…");
  const [session, setSessionState] = useState<SessionSummary | null>(null);
  const [nutrients, setNutrients] = useState<readonly TargetableNutrient[]>([]);
  const [trendNutrientFilter, setTrendNutrientFilterState] = useState({ value: "" });
  const trendNutrientFilterRef = useRef(trendNutrientFilter);
  const trendNutrientScope = useRef<string | null>(null);
  const trendNutrientRegistry = useRef<{
    readonly values: readonly TargetableNutrient[];
    readonly scope: string;
  } | null>(null);
  const renderedTrendNutrientRegistry = trendNutrientRegistry.current;
  const installTrendNutrientFilter = useCallback((value: string) => {
    if (value === trendNutrientFilterRef.current.value) return;
    const next = { value };
    trendNutrientFilterRef.current = next;
    setTrendNutrientFilterState(next);
  }, []);
  const [definitions, setDefinitions] = useState<readonly BiometricDefinition[]>([]);
  const [history, setHistoryState] = useState<BiometricHistory>(emptyHistory);
  const historyRef = useRef(history);
  const [historyMetric, setHistoryMetric] = useState("");
  const historyMetricRef = useRef(historyMetric);
  const historyMetricGeneration = useRef(0);
  const renderedHistoryMetricGeneration = historyMetricGeneration.current;
  const recentHistory = useRef<BiometricWindow | null>(null);
  const historyController = useRef<AbortController | null>(null);
  const historyGeneration = useRef(0);
  const renderedHistoryGeneration = historyGeneration.current;
  const eventWrite = useRef<object | null>(null);
  const [eventWriting, setEventWriting] = useState(false);
  const eventDraftGeneration = useRef(0);
  const renderedEventDraftGeneration = eventDraftGeneration.current;
  const eventWindow = history.window;
  const eventCursor = history.cursor;
  const [reminders, setRemindersState] = useState<readonly Reminder[]>([]);
  const remindersRef = useRef(reminders);
  const setReminders = useCallback(
    (change: readonly Reminder[] | ((current: readonly Reminder[]) => readonly Reminder[])) => {
      const next = typeof change === "function" ? change(remindersRef.current) : change;
      remindersRef.current = next;
      setRemindersState(next);
    },
    [],
  );
  const [integrations, setIntegrations] = useState<readonly PlatformIntegration[]>([]);
  const [definitionName, setDefinitionName] = useState("Weight");
  const [definitionDimension, setDefinitionDimension] = useState<
    "mass" | "length" | "temperature" | "duration" | "count" | "other"
  >("mass");
  const [definitionUnit, setDefinitionUnit] = useState("kg");
  const [editingDefinition, setEditingDefinition] = useState<BiometricDefinition | null>(null);
  const [selectedDefinition, setSelectedDefinitionState] = useState("");
  const selectedDefinitionRef = useRef(selectedDefinition);
  const [eventValue, setEventValue] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [editingEvent, setEditingEvent] = useState<BiometricEvent | null>(null);
  const [reminder, setReminderState] = useState<ReminderDraft>(() => reminderDraft());
  const reminderRef = useRef(reminder);
  const reminderGeneration = useRef(0);
  const reminderControls = useRef(0);
  const renderedReminderGeneration = reminderGeneration.current;
  const renderedReminderControls = reminderControls.current;
  const reminderWrite = useRef<object | null>(null);
  const [reminderSaving, setReminderSaving] = useState(false);
  const replaceReminder = useCallback((next: ReminderDraft) => {
    reminderRef.current = next;
    reminderGeneration.current += 1;
    setReminderState(next);
  }, []);
  const [trendRange, setTrendRange] = useState({ from: "", to: "" });
  const trendRangeRef = useRef(trendRange);
  const { from, to } = trendRange;
  const trendControls = useRef(0);
  const renderedTrendControls = trendControls.current;
  const [selectedNutrient, setSelectedNutrientState] = useState("");
  const selectedNutrientRef = useRef(selectedNutrient);
  const [trendReads, setTrendReads] = useState<Record<TrendKind, TrendRead | null>>({
    nutrition: null,
    biometric: null,
  });
  const trendReadsRef = useRef(trendReads);
  const installTrendRead = useCallback((kind: TrendKind, read: TrendRead | null) => {
    const next = { ...trendReadsRef.current, [kind]: read };
    trendReadsRef.current = next;
    setTrendReads(next);
  }, []);
  const [exportJob, setExportJob] = useState<AccountExportJob | null>(null);
  const [erasureJob, setErasureJob] = useState<AccountErasureJob | null>(null);
  const [password, setPassword] = useState("");
  const [confirmConsequences, setConfirmConsequences] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const trendControllers = useRef<Record<TrendKind, AbortController | null>>({
    nutrition: null,
    biometric: null,
  });
  const trendGenerations = useRef({ nutrition: 0, biometric: 0 });
  const abortTrendRequests = useCallback(() => {
    trendGenerations.current.nutrition += 1;
    trendGenerations.current.biometric += 1;
    trendControllers.current.nutrition?.abort();
    trendControllers.current.biometric?.abort();
  }, []);
  const privateReadControllers = useRef(new Set<AbortController>());
  const ownerUserId = useRef<string | null>(null);
  const privateUiClosed = useRef(false);
  const mounted = useRef(false);
  const visible = useRef(true);
  const installedSession = useRef<SessionSummary | null>(null);

  const replaceTrendRange = useCallback(
    (next: { from: string; to: string }) => {
      const current = trendRangeRef.current;
      if (current.from === next.from && current.to === next.to) return;
      abortTrendRequests();
      trendControls.current += 1;
      trendRangeRef.current = next;
      setTrendRange(next);
    },
    [abortTrendRequests],
  );
  const setSelectedNutrient = useCallback((change: string | ((value: string) => string)) => {
    const next = typeof change === "function" ? change(selectedNutrientRef.current) : change;
    if (next === selectedNutrientRef.current) return;
    trendControllers.current.nutrition?.abort();
    trendGenerations.current.nutrition += 1;
    trendControls.current += 1;
    selectedNutrientRef.current = next;
    setSelectedNutrientState(next);
  }, []);
  const setSelectedDefinition = useCallback((change: string | ((value: string) => string)) => {
    const next = typeof change === "function" ? change(selectedDefinitionRef.current) : change;
    if (next === selectedDefinitionRef.current) return;
    trendControllers.current.biometric?.abort();
    trendGenerations.current.biometric += 1;
    trendControls.current += 1;
    selectedDefinitionRef.current = next;
    setSelectedDefinitionState(next);
  }, []);
  const trendScope = session ? JSON.stringify([session.user.id, session.profile]) : null;
  function canUseTrendInputs() {
    const currentSession = installedSession.current;
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      trendControls.current === renderedTrendControls &&
      trendRangeRef.current === trendRange &&
      selectedNutrientRef.current === selectedNutrient &&
      selectedDefinitionRef.current === selectedDefinition &&
      (currentSession ? JSON.stringify([currentSession.user.id, currentSession.profile]) : null) ===
        trendScope &&
      (currentSession === null || ownerUserId.current === currentSession.user.id)
    );
  }
  function currentTrendNutrientChoices() {
    return (
      canUseTrendInputs() &&
      session !== null &&
      installedSession.current === session &&
      state === "ready" &&
      loadController.current === null &&
      trendNutrientRegistry.current === renderedTrendNutrientRegistry &&
      renderedTrendNutrientRegistry?.values === nutrients &&
      renderedTrendNutrientRegistry.scope === trendScope
    );
  }
  const trendNutrientChoicesReady = currentTrendNutrientChoices();
  const normalizedTrendNutrientFilter = trendNutrientFilter.value.trim().toLowerCase();
  const matchingTrendNutrients = trendNutrientChoicesReady
    ? nutrients.filter((item) => item.name.toLowerCase().includes(normalizedTrendNutrientFilter))
    : [];
  const chosenTrendNutrient = trendNutrientChoicesReady
    ? nutrients.find((item) => item.nutrientId === selectedNutrient)
    : undefined;
  const offeredTrendNutrients = trendNutrientChoicesReady
    ? nutrients.filter(
        (item) => item.nutrientId === selectedNutrient || matchingTrendNutrients.includes(item),
      )
    : [];
  function changeTrendNutrientFilter(value: string) {
    if (
      !currentTrendNutrientChoices() ||
      trendNutrientFilterRef.current !== trendNutrientFilter ||
      value.length > 200
    )
      return;
    installTrendNutrientFilter(value);
  }
  function chooseTrendNutrient(value: string) {
    if (
      !currentTrendNutrientChoices() ||
      trendNutrientFilterRef.current !== trendNutrientFilter ||
      value === selectedNutrient ||
      !matchingTrendNutrients.some((item) => item.nutrientId === value)
    )
      return;
    setSelectedNutrient(value);
  }
  function canUseTrendPreset() {
    return (
      canUseTrendInputs() &&
      session !== null &&
      state === "ready" &&
      loadController.current === null
    );
  }
  function chooseTrendDays(days: 7 | 30 | 90) {
    if (!canUseTrendPreset() || session === null) return;
    try {
      const today = localDateInTimeZone(new Date(), session.profile.timeZone);
      const start = shiftLocalDate(today, 1 - days);
      if (!isLocalDate(today) || !isLocalDate(start) || start > today) return;
      replaceTrendRange({ from: start, to: today });
    } catch {
      // An unsupported clock/date must not replace a usable custom range.
    }
  }

  const resetHistoryMetric = useCallback(() => {
    historyMetricGeneration.current += 1;
    historyMetricRef.current = "";
    setHistoryMetric("");
  }, []);

  const installHistory = useCallback((next: BiometricHistory) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);
  const invalidateHistory = useCallback(() => {
    historyController.current?.abort();
    historyController.current = null;
    historyGeneration.current += 1;
    const current = historyRef.current;
    installHistory({
      ...current,
      status: "error",
      message: "Reload history to verify this window.",
    });
  }, [installHistory]);

  const setSession = useCallback(
    (next: SessionSummary | null) => {
      const previous = installedSession.current;
      if (
        previous &&
        (!next ||
          JSON.stringify([previous.user.id, previous.profile]) !==
            JSON.stringify([next.user.id, next.profile]))
      ) {
        trendControls.current += 1;
        abortTrendRequests();
        reminderControls.current += 1;
        resetHistoryMetric();
        invalidateHistory();
        if (!next || next.user.id !== previous.user.id) {
          recentHistory.current = null;
          installHistory(emptyHistory());
        }
      }
      if (next !== null) {
        const nextScope = JSON.stringify([next.user.id, next.profile]);
        if (trendNutrientScope.current !== nextScope) {
          trendNutrientRegistry.current = null;
          installTrendNutrientFilter("");
        }
        trendNutrientScope.current = nextScope;
      }
      installedSession.current = next;
      setSessionState(next);
    },
    [
      installHistory,
      invalidateHistory,
      resetHistoryMetric,
      installTrendNutrientFilter,
      abortTrendRequests,
    ],
  );

  const signInAgain = useCallback(() => {
    privateUiClosed.current = true;
    resetHistoryMetric();
    loadController.current?.abort();
    abortTrendRequests();
    for (const controller of privateReadControllers.current) controller.abort();
    privateReadControllers.current.clear();
    ownerUserId.current = null;
    operations.current.clear();
    setSession(null);
    trendNutrientScope.current = null;
    trendNutrientRegistry.current = null;
    installTrendNutrientFilter("");
    setNutrients([]);
    setDefinitions([]);
    invalidateHistory();
    recentHistory.current = null;
    installHistory(emptyHistory());
    eventWrite.current = null;
    setEventWriting(false);
    eventDraftGeneration.current += 1;
    setReminders([]);
    setIntegrations([]);
    setDefinitionName("Weight");
    setDefinitionDimension("mass");
    setDefinitionUnit("kg");
    setEditingDefinition(null);
    setSelectedDefinition("");
    setEventValue("");
    setEventDate("");
    setEventTime("");
    setEditingEvent(null);
    reminderWrite.current = null;
    setReminderSaving(false);
    reminderControls.current += 1;
    replaceReminder(reminderDraft());
    replaceTrendRange({ from: "", to: "" });
    setSelectedNutrient("");
    installTrendRead("nutrition", null);
    installTrendRead("biometric", null);
    setExportJob(null);
    setErasureJob(null);
    setPassword("");
    setConfirmConsequences(false);
    setBusy(null);
    setState("loading");
    setMessage("Closing your private health workspace…");
    router.replace("/login");
    router.refresh();
  }, [
    abortTrendRequests,
    installTrendRead,
    resetHistoryMetric,
    router,
    setSession,
    setReminders,
    replaceReminder,
    replaceTrendRange,
    setSelectedDefinition,
    setSelectedNutrient,
    installTrendNutrientFilter,
    installHistory,
    invalidateHistory,
  ]);

  const revalidateHealthSession = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new PrivateOwnerFenceError();
      return parseSession(await json(response));
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PrivateOwnerFenceError) throw error;
      throw new PrivateOwnerFenceError();
    }
  }, []);

  const operation = useCallback((key: string) => {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const created = operationId();
    operations.current.set(key, created);
    return created;
  }, []);

  const request = useCallback(
    async (
      path: string,
      input: {
        readonly method?: "DELETE" | "PATCH" | "POST";
        readonly body?: unknown;
        readonly key?: string;
        readonly revision?: string;
        readonly recentAuth?: string;
        readonly expectedTimeZone?: string;
        readonly signal?: AbortSignal;
      } = {},
    ) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.key) headers["idempotency-key"] = operation(input.key);
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
      if (input.recentAuth) headers["x-reauthentication-token"] = input.recentAuth;
      if (input.expectedTimeZone) headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      const response = await fetch(`/api/retention/${path}`, {
        method: input.method ?? "GET",
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (response.status === 401) {
        signInAgain();
        throw new Error("Sign in to continue.");
      }
      const body = await json(response);
      if (!response.ok)
        throw new PrivateRequestFailure(
          responseError(body, "The private health request failed."),
          response.status,
          body,
        );
      return body;
    },
    [operation, signInAgain],
  );

  const loadAll = useCallback(
    async (only?: HealthSection) => {
      if (privateUiClosed.current || !mounted.current || eventWrite.current !== null) return;
      const selected = (only ? [only] : healthSections).filter(
        (section) =>
          !sectionControllers.current[section] ||
          sectionControllers.current[section]?.signal.aborted,
      );
      let failed = false;
      let cancelled = false;
      let initialSession: Promise<ReturnType<typeof parseSession>> | null = null;
      await Promise.all(
        selected.map(async (section) => {
          const controller = new AbortController();
          sectionControllers.current[section] = controller;
          privateReadControllers.current.add(controller);
          setSectionLoading((value) => ({ ...value, [section]: true }));
          setSectionErrors((value) => ({ ...value, [section]: undefined }));
          const current = () =>
            !controller.signal.aborted &&
            !privateUiClosed.current &&
            mounted.current &&
            sectionControllers.current[section] === controller;
          if (section === "nutrients") {
            trendNutrientRegistry.current = null;
            trendControls.current += 1;
            loadController.current = controller;
            setState("loading");
          }
          if (section === "biometrics") {
            invalidateHistory();
            installHistory({
              ...historyRef.current,
              status: "loading",
              message: "Loading biometric history…",
            });
          }
          if (section === "reminders") reminderControls.current += 1;
          const historyEpoch = historyGeneration.current;
          try {
            // Share initial authentication; each section still verifies its owner after its private read.
            initialSession ??= (async () => {
              const response = await fetch("/api/auth/me", {
                headers: { accept: "application/json" },
                cache: "no-store",
                signal: controller.signal,
              });
              if (!response.ok) throw new PrivateOwnerFenceError();
              return parseSession(await json(response));
            })();
            const nextSession = await initialSession;
            controller.signal.throwIfAborted();
            if (ownerUserId.current !== null && ownerUserId.current !== nextSession.user.id)
              throw new PrivateOwnerFenceError();
            const now = new Date();
            const capturedRecent =
              recentHistory.current ??
              historyWindow(now.getTime() - 120 * HISTORY_DAY, now.getTime() + HISTORY_DAY);
            if (!capturedRecent)
              throw new Error(
                "The current instant is outside the supported biometric history range.",
              );
            recentHistory.current = capturedRecent;
            const capturedWindow = historyRef.current.window ?? capturedRecent;
            const read = async (path: string) => {
              const response = await fetch(path, { cache: "no-store", signal: controller.signal });
              if (response.status === 401) {
                if (current()) signInAgain();
                throw new PrivateOwnerFenceError();
              }
              const body = await json(response);
              if (!response.ok)
                throw new Error(responseError(body, "Private health data could not be loaded."));
              return body;
            };
            await installPrivateDataForOwner({
              expectedOwnerUserId: nextSession.user.id,
              signal: controller.signal,
              loadPrivateData: async () => {
                switch (section) {
                  case "nutrients": {
                    return {
                      section,
                      nutrients: parseTargetableNutrients(await read("/api/nutrients/targetable")),
                    };
                  }
                  case "biometrics": {
                    const [definitionBody, eventBody] = await Promise.all([
                      read("/api/retention/biometrics/definitions"),
                      read(
                        `/api/retention/biometrics/events?from=${encodeURIComponent(capturedWindow.from)}&to=${encodeURIComponent(capturedWindow.to)}&limit=100`,
                      ),
                    ]);
                    return {
                      section,
                      definitions: parseBiometricDefinitions(definitionBody),
                      eventPage: parseBiometricEvents(eventBody),
                    };
                  }
                  case "reminders":
                    return {
                      section,
                      reminders: parseReminders(await read("/api/retention/reminders")),
                    };
                  case "integrations":
                    return {
                      section,
                      integrations: parseIntegrations(
                        await read("/api/retention/integrations/health"),
                      ),
                    };
                }
              },
              revalidateSession: () => revalidateHealthSession(controller.signal),
              install: (data, currentSession) => {
                if (!current()) return;
                if (ownerUserId.current !== null && ownerUserId.current !== nextSession.user.id)
                  throw new PrivateOwnerFenceError();
                ownerUserId.current = nextSession.user.id;
                const localToday = localDateInTimeZone(now, currentSession.profile.timeZone);
                setSession(currentSession);
                if (data.section === "nutrients") {
                  setNutrients(data.nutrients);
                  trendNutrientRegistry.current = {
                    values: data.nutrients,
                    scope: JSON.stringify([currentSession.user.id, currentSession.profile]),
                  };
                  setSelectedNutrient((value) => value || data.nutrients[0]?.nutrientId || "");
                  setState("ready");
                } else if (data.section === "biometrics") {
                  const historyIsCurrent = historyGeneration.current === historyEpoch;
                  setDefinitions(data.definitions);
                  installHistory({
                    window: capturedWindow,
                    events: historyIsCurrent ? data.eventPage.items : [],
                    cursor: historyIsCurrent ? data.eventPage.nextCursor : null,
                    status: historyIsCurrent ? "ready" : "error",
                    verified: historyIsCurrent,
                    message: historyIsCurrent
                      ? ""
                      : "History changed while this workspace was loading. Choose Reload history to verify this window.",
                    owner: nextSession.user.id,
                  });
                  setSelectedDefinition(
                    (value) =>
                      value || data.definitions.find((item) => item.status === "active")?.id || "",
                  );
                  setEventDate((value) => value || localToday);
                  setEventTime(
                    (value) =>
                      value ||
                      localTimeInTimeZone(now, currentSession.profile.timeZone).slice(0, 5),
                  );
                } else if (data.section === "reminders") setReminders(data.reminders);
                else setIntegrations(data.integrations);
                replaceTrendRange({
                  from: trendRangeRef.current.from || shiftLocalDate(localToday, -13),
                  to: trendRangeRef.current.to || localToday,
                });
              },
            });
          } catch (error) {
            if (!current()) return;
            if (error instanceof PrivateOwnerFenceError) return signInAgain();
            failed = true;
            const detail =
              error instanceof Error ? error.message : "Private health data could not be loaded.";
            setSectionErrors((value) => ({ ...value, [section]: detail }));
            setMessage(detail);
            if (section === "nutrients") setState("error");
            if (section === "biometrics" && historyGeneration.current === historyEpoch)
              installHistory({
                ...historyRef.current,
                status: "error",
                message: "Biometrics could not be loaded. Retry biometrics to verify this window.",
              });
          } finally {
            if (controller.signal.aborted) cancelled = true;
            if (current()) setSectionLoading((value) => ({ ...value, [section]: false }));
            if (sectionControllers.current[section] === controller)
              delete sectionControllers.current[section];
            privateReadControllers.current.delete(controller);
            if (loadController.current === controller) loadController.current = null;
          }
        }),
      );
      if (
        !only &&
        !failed &&
        !cancelled &&
        mounted.current &&
        !privateUiClosed.current &&
        selected.length === healthSections.length
      )
        setMessage("Private health workspace is current.");
    },
    [
      installHistory,
      invalidateHistory,
      revalidateHealthSession,
      setSession,
      setReminders,
      replaceTrendRange,
      setSelectedDefinition,
      setSelectedNutrient,
      signInAgain,
    ],
  );

  function sectionStatus(section: HealthSection) {
    if (privateUiClosed.current) return null;
    const label = healthSectionLabels[section];
    return (
      <>
        {sectionLoading[section] ? <p role="status">Loading {label}…</p> : null}
        {sectionErrors[section] ? (
          <div role="status">
            <p>{sectionErrors[section]}</p>
            <button
              type="button"
              disabled={Boolean(sectionLoading[section]) || eventWriting}
              onClick={() => void loadAll(section)}
            >
              Retry {label}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  const historyScope = session ? JSON.stringify([session.user.id, session.profile]) : null;
  const historyVisible =
    mounted.current &&
    visible.current &&
    !privateUiClosed.current &&
    session !== null &&
    ownerUserId.current === session.user.id &&
    history.owner === session.user.id;
  const events = historyVisible ? history.events : [];
  const shownEvents = historyMetric
    ? events.filter((event) => event.definitionId === historyMetric)
    : events;
  const historyMetricChoices = historyVisible
    ? [
        ...new Set([
          ...definitions.map((definition) => definition.id),
          ...events.map((event) => event.definitionId),
          ...(historyMetric ? [historyMetric] : []),
        ]),
      ].map((id) => {
        const definition = definitions.find((item) => item.id === id);
        return {
          id,
          label: definition ? `${definition.name} (${definition.canonicalUnit})` : null,
        };
      })
    : [];
  const historyMetricLabelCounts = new Map<string, number>();
  for (const choice of historyMetricChoices) {
    if (choice.label !== null)
      historyMetricLabelCounts.set(
        choice.label,
        (historyMetricLabelCounts.get(choice.label) ?? 0) + 1,
      );
  }
  const historyUnavailable =
    !historyVisible ||
    historyController.current !== null ||
    sectionControllers.current.biometrics !== undefined ||
    eventWriting;
  const earlierWindow = eventWindow
    ? historyWindow(
        Date.parse(eventWindow.from) - HISTORY_WIDTH,
        Date.parse(eventWindow.to) - HISTORY_WIDTH,
      )
    : null;
  const newerWindow =
    eventWindow &&
    recentHistory.current &&
    Date.parse(eventWindow.to) < Date.parse(recentHistory.current.to)
      ? historyWindow(
          Date.parse(eventWindow.from) + HISTORY_WIDTH,
          Date.parse(eventWindow.to) + HISTORY_WIDTH,
        )
      : null;

  function canUseHistory() {
    const current = installedSession.current;
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      current !== null &&
      ownerUserId.current === current.user.id &&
      JSON.stringify([current.user.id, current.profile]) === historyScope &&
      historyRef.current === history &&
      historyGeneration.current === renderedHistoryGeneration &&
      historyController.current === null &&
      sectionControllers.current.biometrics === undefined &&
      eventWrite.current === null
    );
  }
  function canUseHistoryMetric() {
    return (
      historyVisible &&
      canUseHistory() &&
      historyMetricGeneration.current === renderedHistoryMetricGeneration &&
      historyMetricRef.current === historyMetric
    );
  }
  function changeHistoryMetric(next: string) {
    if (
      !canUseHistoryMetric() ||
      (next !== "" && !historyMetricChoices.some((choice) => choice.id === next)) ||
      next === historyMetricRef.current
    )
      return;
    historyMetricGeneration.current += 1;
    historyMetricRef.current = next;
    setHistoryMetric(next);
  }
  function canUseEventRow(event: BiometricEvent) {
    return (
      canUseHistoryMetric() &&
      history.verified &&
      history.events.includes(event) &&
      (historyMetric === "" || event.definitionId === historyMetric)
    );
  }
  async function loadHistory(target: BiometricWindow, append = false) {
    if (
      !canUseHistory() ||
      (append && (!history.verified || !eventCursor || target !== eventWindow))
    )
      return;
    const controller = new AbortController();
    historyController.current = controller;
    privateReadControllers.current.add(controller);
    const epoch = ++historyGeneration.current;
    const initiatingOwner = ownerUserId.current;
    const cursor = append ? eventCursor : null;
    installHistory({
      ...history,
      window: target,
      events: append ? history.events : [],
      cursor: append ? cursor : null,
      status: "loading",
      verified: append && history.verified,
      message: "Loading biometric history…",
    });
    const isCurrent = () =>
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      historyController.current === controller &&
      !controller.signal.aborted &&
      historyGeneration.current === epoch &&
      ownerUserId.current === initiatingOwner &&
      installedSession.current !== null &&
      JSON.stringify([installedSession.current.user.id, installedSession.current.profile]) ===
        historyScope;
    try {
      const response = await fetch(
        `/api/retention/biometrics/events?from=${encodeURIComponent(target.from)}&to=${encodeURIComponent(target.to)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal },
      );
      if (!isCurrent()) return;
      if (response.status === 401) throw new PrivateOwnerFenceError();
      if (response.status === 400 && cursor) {
        installHistory({
          ...historyRef.current,
          cursor: null,
          status: "error",
          message:
            "This continuation is no longer available. Choose Reload history for a fresh page in this window.",
        });
        return;
      }
      const body = await json(response);
      if (!isCurrent()) return;
      if (!response.ok)
        throw new Error(responseError(body, "Biometric history could not be loaded."));
      const page = parseBiometricEvents(body);
      const currentSession = await revalidateHealthSession(controller.signal);
      if (!isCurrent()) return;
      if (currentSession.user.id !== initiatingOwner) throw new PrivateOwnerFenceError();
      if (JSON.stringify([currentSession.user.id, currentSession.profile]) !== historyScope) {
        setSession(currentSession);
        installHistory({
          ...historyRef.current,
          status: "error",
          message: "Your profile changed. Reload history to verify this window.",
        });
        return;
      }
      installHistory({
        window: target,
        events: append
          ? [
              ...history.events,
              ...page.items.filter(
                (event) => !history.events.some((existing) => existing.id === event.id),
              ),
            ]
          : page.items,
        cursor: page.nextCursor,
        status: "ready",
        verified: true,
        message: "",
        owner: initiatingOwner,
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof PrivateOwnerFenceError) return signInAgain();
      installHistory({
        ...historyRef.current,
        status: "error",
        message: `${error instanceof Error ? error.message : "Biometric history could not be loaded."} ${cursor ? "Load older biometric events to retry this page." : "Choose Reload history to retry this window."}`,
      });
    } finally {
      privateReadControllers.current.delete(controller);
      if (historyController.current === controller) historyController.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    visible.current = typeof document === "undefined" || document.visibilityState !== "hidden";
    const visibilityChanged = () => {
      visible.current = document.visibilityState !== "hidden";
      trendControls.current += 1;
      reminderControls.current += 1;
      invalidateHistory();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visibilityChanged);
    void loadAll();
    return () => {
      mounted.current = false;
      trendControls.current += 1;
      reminderControls.current += 1;
      historyController.current?.abort();
      historyController.current = null;
      historyGeneration.current += 1;
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibilityChanged);
      loadController.current?.abort();
      abortTrendRequests();
      for (const controller of privateReadControllers.current) controller.abort();
      privateReadControllers.current.clear();
    };
  }, [abortTrendRequests, invalidateHistory, loadAll]);

  const currentTrendRequest = useCallback((kind: TrendKind): TrendRequest | null => {
    const currentSession = installedSession.current;
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !currentSession ||
      ownerUserId.current !== currentSession.user.id
    )
      return null;
    return trendRequest(
      currentSession,
      trendRangeRef.current,
      kind === "nutrition" ? selectedNutrientRef.current : selectedDefinitionRef.current,
      trendGenerations.current[kind],
    );
  }, []);

  const loadTrend = useCallback(
    (kind: TrendKind, request: TrendRequest) => {
      if (currentTrendRequest(kind)?.key !== request.key) return;
      trendControllers.current[kind]?.abort();
      const controller = new AbortController();
      trendControllers.current[kind] = controller;
      privateReadControllers.current.add(controller);
      const current = () =>
        !controller.signal.aborted &&
        trendControllers.current[kind] === controller &&
        currentTrendRequest(kind)?.key === request.key;
      const label = kind === "nutrition" ? "Nutrition" : "Biometric";
      installTrendRead(kind, {
        request,
        status: "loading",
        result: null,
        message: `Loading ${label.toLowerCase()} trend…`,
      });
      void (async () => {
        try {
          await installPrivateDataForOwner({
            expectedOwnerUserId: request.ownerUserId,
            signal: controller.signal,
            loadPrivateData: async (): Promise<TrendResult> => {
              const query = `${kind === "nutrition" ? "nutrientId" : "definitionId"}=${encodeURIComponent(request.seriesId)}&from=${request.from}&to=${request.to}`;
              const response = await fetch(
                `/api/retention/trends/${kind === "nutrition" ? "nutrients" : "biometrics"}?${query}`,
                { cache: "no-store", signal: controller.signal },
              );
              controller.signal.throwIfAborted();
              if (response.status === 401) throw new PrivateOwnerFenceError();
              const body = await json(response);
              controller.signal.throwIfAborted();
              if (!response.ok)
                throw new Error(responseError(body, `${label} trend could not be loaded.`));
              return kind === "nutrition"
                ? { kind, data: parseNutrientTrend(body) }
                : { kind, data: parseBiometricTrend(body) };
            },
            revalidateSession: () => revalidateHealthSession(controller.signal),
            install: (result, verifiedSession) => {
              if (!current()) return;
              if (
                JSON.stringify([verifiedSession.user.id, verifiedSession.profile]) !==
                request.profileScope
              ) {
                setSession(verifiedSession);
                void loadAll("nutrients");
                return;
              }
              const seriesId =
                result.kind === "nutrition" ? result.data.nutrient.id : result.data.definition.id;
              if (
                seriesId !== request.seriesId ||
                result.data.from !== request.from ||
                result.data.to !== request.to ||
                result.data.timeZone !== request.timeZone
              )
                throw new Error(
                  `${label} trend did not match the selected series, dates or time zone.`,
                );
              installTrendRead(kind, { request, status: "ready", result, message: "" });
            },
          });
        } catch (error) {
          if (!current()) return;
          if (error instanceof PrivateOwnerFenceError) return signInAgain();
          installTrendRead(kind, {
            request,
            status: "error",
            result: null,
            message: error instanceof Error ? error.message : `${label} trend could not be loaded.`,
          });
        } finally {
          privateReadControllers.current.delete(controller);
          if (trendControllers.current[kind] === controller) trendControllers.current[kind] = null;
        }
      })();
    },
    [
      currentTrendRequest,
      installTrendRead,
      loadAll,
      revalidateHealthSession,
      setSession,
      signInAgain,
    ],
  );

  const nutritionTrendKey = session
    ? (trendRequest(session, trendRange, selectedNutrient, trendGenerations.current.nutrition)
        ?.key ?? null)
    : null;
  const biometricTrendKey = session
    ? (trendRequest(session, trendRange, selectedDefinition, trendGenerations.current.biometric)
        ?.key ?? null)
    : null;

  useEffect(() => {
    for (const kind of ["nutrition", "biometric"] as const) {
      const request = currentTrendRequest(kind);
      const renderedKey = kind === "nutrition" ? nutritionTrendKey : biometricTrendKey;
      if (request && request.key !== renderedKey) continue;
      const previous = trendReadsRef.current[kind];
      if (!request) {
        trendControllers.current[kind]?.abort();
        if (previous) installTrendRead(kind, null);
      } else if (
        previous?.request.key !== request.key ||
        (previous.status === "loading" &&
          (!trendControllers.current[kind] || trendControllers.current[kind]?.signal.aborted))
      ) {
        loadTrend(kind, request);
      }
    }
  }, [nutritionTrendKey, biometricTrendKey, currentTrendRequest, installTrendRead, loadTrend]);

  function visibleTrendRead(kind: TrendKind) {
    const read = trendReads[kind];
    return read && read.request.key === currentTrendRequest(kind)?.key ? read : null;
  }
  const nutritionRead = visibleTrendRead("nutrition");
  const biometricRead = visibleTrendRead("biometric");
  const nutrientTrend =
    nutritionRead?.result?.kind === "nutrition" ? nutritionRead.result.data : null;
  const biometricTrend =
    biometricRead?.result?.kind === "biometric" ? biometricRead.result.data : null;

  function retryTrend(kind: TrendKind, read: TrendRead | null) {
    if (
      !canUseTrendInputs() ||
      !read ||
      read.status !== "error" ||
      trendReadsRef.current[kind] !== read ||
      currentTrendRequest(kind)?.key !== read.request.key ||
      trendControllers.current[kind]
    )
      return;
    loadTrend(kind, read.request);
  }

  function trendStatus(kind: TrendKind, read: TrendRead | null) {
    const label = kind === "nutrition" ? "nutrition" : "biometric";
    if (privateUiClosed.current || !session) return "Verify your private session to load trends.";
    if (!isLocalDate(from) || !isLocalDate(to) || from > to)
      return "Choose a valid date range to load trends.";
    if (!(kind === "nutrition" ? selectedNutrient : selectedDefinition))
      return `Choose a ${kind === "nutrition" ? "nutrient" : "metric"} to load its trend.`;
    if (!read || read.status === "loading") return `Loading ${label} trend…`;
    if (read.status === "error") return read.message;
    return read.result?.data.points.length
      ? `Showing ${read.request.from} through ${read.request.to}.`
      : `No ${label} trend data for this range.`;
  }

  const selectedDefinitionRecord = useMemo(
    () => definitions.find((definition) => definition.id === selectedDefinition) ?? null,
    [definitions, selectedDefinition],
  );

  async function saveDefinition() {
    if (!definitionName.trim() || !definitionUnit.trim())
      return setMessage("Metric name and unit are required.");
    const body = editingDefinition
      ? { name: definitionName.trim(), notes: null }
      : {
          name: definitionName.trim(),
          dimension: definitionDimension,
          canonicalUnit: definitionUnit.trim(),
          notes: null,
        };
    const key = `definition:${editingDefinition?.id ?? "new"}:${editingDefinition?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("definition");
    try {
      const saved = parseBiometricDefinitionResponse(
        await request(
          editingDefinition
            ? `biometrics/definitions/${editingDefinition.id}`
            : "biometrics/definitions",
          {
            method: editingDefinition ? "PATCH" : "POST",
            body,
            key,
            ...(editingDefinition ? { revision: editingDefinition.revision } : {}),
          },
        ),
      );
      operations.current.delete(key);
      setDefinitions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setEditingDefinition(null);
      setDefinitionName("Weight");
      setDefinitionDimension("mass");
      setDefinitionUnit("kg");
      setMessage("Metric definition saved; historical events keep their canonical unit.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function archiveDefinition(definition: BiometricDefinition) {
    if (!window.confirm(`Archive ${definition.name}? Existing events and trends remain available.`))
      return;
    const key = `definition-archive:${definition.id}:${definition.revision}`;
    setBusy(`definition:${definition.id}`);
    try {
      const archived = parseBiometricDefinitionResponse(
        await request(`biometrics/definitions/${definition.id}`, {
          method: "DELETE",
          key,
          revision: definition.revision,
        }),
      );
      operations.current.delete(key);
      setDefinitions((items) => items.map((item) => (item.id === archived.id ? archived : item)));
      setMessage("Metric archived; historical events remain visible.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  function canEditEventDraft() {
    const current = installedSession.current;
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      current !== null &&
      ownerUserId.current === current.user.id &&
      JSON.stringify([current.user.id, current.profile]) === historyScope &&
      eventDraftGeneration.current === renderedEventDraftGeneration
    );
  }
  function changeEventField(current: string, next: string, setValue: (value: string) => void) {
    if (!canEditEventDraft() || current === next) return;
    eventDraftGeneration.current += 1;
    setValue(next);
  }
  function eventWriteAvailable() {
    return (
      canEditEventDraft() &&
      eventWrite.current === null &&
      historyController.current === null &&
      sectionControllers.current.biometrics === undefined
    );
  }
  function editEvent(event: BiometricEvent) {
    if (!canUseEventRow(event)) return;
    eventDraftGeneration.current += 1;
    setEditingEvent(event);
    setSelectedDefinition(event.definitionId);
    setEventValue(event.value);
    setEventDate(event.localDate);
    setEventTime(localTimeInTimeZone(new Date(event.measuredAt), event.timeZone).slice(0, 5));
  }
  async function requestEventMutation(
    input: {
      readonly path: string;
      readonly method: "POST" | "PATCH" | "DELETE";
      readonly body?: unknown;
      readonly key: string;
      readonly revision?: string;
    },
    ownsWrite: () => boolean,
  ) {
    const response = await fetch(`/api/retention/${input.path}`, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        "idempotency-key": operation(input.key),
        ...(input.revision ? { "if-match": quoteRevision(input.revision) } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      cache: "no-store",
    });
    if (!ownsWrite()) return undefined;
    if (response.status === 401) {
      signInAgain();
      return undefined;
    }
    const body = await json(response);
    if (!ownsWrite()) return undefined;
    if (!response.ok)
      throw new PrivateRequestFailure(
        responseError(body, "The private health request failed."),
        response.status,
        body,
      );
    return parseBiometricMutation(body);
  }

  async function saveEvent() {
    if (!eventWriteAvailable()) return;
    if (
      !session ||
      !selectedDefinitionRecord ||
      !isSignedExactDecimal(eventValue) ||
      !isLocalDate(eventDate) ||
      !/^\d{2}:\d{2}$/u.test(eventTime)
    ) {
      return setMessage("Metric, exact value, local date, and local time are required.");
    }
    const localTimeChanged =
      editingEvent !== null &&
      !biometricEventLocalTimeUnchanged(editingEvent, eventDate, eventTime);
    const body = editingEvent
      ? {
          value: eventValue,
          ...(localTimeChanged
            ? { measuredAt: localDateTimeToInstant(eventDate, eventTime, session.profile.timeZone) }
            : {}),
        }
      : {
          definitionId: selectedDefinitionRecord.id,
          measuredAt: localDateTimeToInstant(eventDate, eventTime, session.profile.timeZone),
          value: eventValue,
        };
    const path = editingEvent ? `biometrics/events/${editingEvent.id}` : "biometrics/events";
    const key = `event:${editingEvent?.id ?? "new"}:${editingEvent?.revision ?? "0"}:${JSON.stringify(body)}`;
    const token = {},
      initiatingOwner = session.user.id,
      draftGeneration = eventDraftGeneration.current;
    eventWrite.current = token;
    setEventWriting(true);
    const ownsWrite = () =>
      mounted.current &&
      !privateUiClosed.current &&
      eventWrite.current === token &&
      ownerUserId.current === initiatingOwner &&
      installedSession.current?.user.id === initiatingOwner;
    setBusy("event");
    try {
      const saved = await requestEventMutation(
        {
          path,
          method: editingEvent ? "PATCH" : "POST",
          body,
          key,
          ...(editingEvent ? { revision: editingEvent.revision } : {}),
        },
        ownsWrite,
      );
      if (!ownsWrite() || saved === undefined) return;
      operations.current.delete(key);
      const current = historyRef.current;
      if (saved && current.owner === initiatingOwner && current.window)
        installHistory({
          ...current,
          events: [
            ...(eventInWindow(saved, current.window) ? [saved] : []),
            ...current.events.filter((item) => item.id !== saved.id),
          ],
        });
      if (eventDraftGeneration.current === draftGeneration) {
        eventDraftGeneration.current += 1;
        setEditingEvent(null);
        setEventValue("");
      }
      setMessage("Biometric event saved with its exact entered decimal.");
    } catch (error) {
      if (!ownsWrite()) return;
      setMessage(
        `${error instanceof Error ? error.message : "Biometric event could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      if (eventWrite.current === token) {
        eventWrite.current = null;
        if (mounted.current && !privateUiClosed.current) {
          setEventWriting(false);
          setBusy(null);
        }
      }
    }
  }

  async function deleteEvent(event: BiometricEvent) {
    if (
      !canUseEventRow(event) ||
      !eventWriteAvailable() ||
      event.source.kind !== "manual" ||
      !window.confirm("Delete this manual biometric event?")
    )
      return;
    if (!canUseEventRow(event) || !eventWriteAvailable()) return;
    const key = `event-delete:${event.id}:${event.revision}`;
    const token = {},
      initiatingOwner = ownerUserId.current;
    eventWrite.current = token;
    setEventWriting(true);
    const ownsWrite = () =>
      mounted.current &&
      !privateUiClosed.current &&
      eventWrite.current === token &&
      initiatingOwner !== null &&
      ownerUserId.current === initiatingOwner &&
      installedSession.current?.user.id === initiatingOwner;
    setBusy(`event:${event.id}`);
    try {
      const saved = await requestEventMutation(
        { path: `biometrics/events/${event.id}`, method: "DELETE", key, revision: event.revision },
        ownsWrite,
      );
      if (!ownsWrite() || saved === undefined) return;
      operations.current.delete(key);
      const current = historyRef.current;
      if (current.owner === initiatingOwner)
        installHistory({
          ...current,
          events: current.events.filter((item) => item.id !== event.id),
        });
      setMessage("Manual biometric event deleted.");
    } catch (error) {
      if (!ownsWrite()) return;
      setMessage(error instanceof Error ? error.message : "Biometric event could not be deleted.");
    } finally {
      if (eventWrite.current === token) {
        eventWrite.current = null;
        if (mounted.current && !privateUiClosed.current) {
          setEventWriting(false);
          setBusy(null);
        }
      }
    }
  }

  const reminderScope = session ? JSON.stringify([session.user.id, session.profile]) : null;
  function canEditReminder() {
    const current = installedSession.current;
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      current !== null &&
      ownerUserId.current === current.user.id &&
      JSON.stringify([current.user.id, current.profile]) === reminderScope &&
      reminderGeneration.current === renderedReminderGeneration &&
      reminderControls.current === renderedReminderControls &&
      reminderRef.current === reminder &&
      reminderWrite.current === null
    );
  }
  function changeReminderDraft(next: ReminderDraft) {
    if (!canEditReminder() || JSON.stringify(next) === JSON.stringify(reminderRef.current)) return;
    replaceReminder(next);
  }
  function reminderDaysMatch(days: readonly number[]) {
    return (
      reminder.daysOfWeek.length === days.length &&
      days.every((day) => reminder.daysOfWeek.includes(day))
    );
  }
  function selectReminderDays(days: readonly number[]) {
    if (!canEditReminder() || reminderDaysMatch(days)) return;
    replaceReminder({ ...reminder, daysOfWeek: days });
  }
  function editReminder(item: Reminder) {
    if (!canEditReminder() || !remindersRef.current.includes(item)) return;
    replaceReminder(reminderDraft(item));
  }

  async function saveReminder() {
    if (!canEditReminder()) return;
    if (!session || !reminder.label.trim() || reminder.daysOfWeek.length < 1)
      return setMessage("Reminder label, time, and at least one day are required.");
    const body = reminder.id
      ? {
          label: reminder.label.trim(),
          localTime: reminder.localTime,
          daysOfWeek: reminder.daysOfWeek,
          timeZone: session.profile.timeZone,
          status: reminder.status,
        }
      : {
          label: reminder.label.trim(),
          localTime: reminder.localTime,
          daysOfWeek: reminder.daysOfWeek,
          timeZone: session.profile.timeZone,
          channel: "local" as const,
          consentGranted: true as const,
        };
    const path = reminder.id ? `reminders/${reminder.id}` : "reminders";
    const key = `reminder:${reminder.id ?? "new"}:${reminder.revision ?? "0"}:${JSON.stringify(body)}`;
    const token = {},
      initiatingOwner = session.user.id,
      draft = reminderRef.current;
    reminderWrite.current = token;
    setReminderSaving(true);
    const ownsWrite = () =>
      mounted.current &&
      !privateUiClosed.current &&
      reminderWrite.current === token &&
      ownerUserId.current === initiatingOwner &&
      installedSession.current?.user.id === initiatingOwner;
    setBusy("reminder");
    try {
      const response = await fetch(`/api/retention/${path}`, {
        method: reminder.id ? "PATCH" : "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation(key),
          ...(reminder.revision ? { "if-match": quoteRevision(reminder.revision) } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!ownsWrite()) return;
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (!ownsWrite()) return;
      if (!response.ok)
        throw new PrivateRequestFailure(
          responseError(responseBody, "The private health request failed."),
          response.status,
          responseBody,
        );
      const saved = parseReminderResponse(responseBody);
      operations.current.delete(key);
      setReminders((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      if (reminderRef.current === draft) replaceReminder(reminderDraft());
      setMessage("Reminder saved. A signed mobile app must sync it before local delivery begins.");
    } catch (error) {
      if (!ownsWrite()) return;
      setMessage(
        `${error instanceof Error ? error.message : "Reminder could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      if (reminderWrite.current === token) {
        reminderWrite.current = null;
        if (mounted.current && !privateUiClosed.current) {
          setReminderSaving(false);
          setBusy(null);
        }
      }
    }
  }

  async function changeReminder(reminderRecord: Reminder, action: "pause" | "resume" | "delete") {
    if (
      action === "delete" &&
      !window.confirm("Delete this reminder and revoke notification consent for it?")
    )
      return;
    const key = `reminder-${action}:${reminderRecord.id}:${reminderRecord.revision}`;
    setBusy(`reminder:${reminderRecord.id}`);
    try {
      const saved = parseReminderResponse(
        await request(`reminders/${reminderRecord.id}`, {
          method: action === "delete" ? "DELETE" : "PATCH",
          ...(action === "delete"
            ? {}
            : {
                body: {
                  label: reminderRecord.label,
                  localTime: reminderRecord.localTime,
                  daysOfWeek: reminderRecord.daysOfWeek,
                  timeZone: reminderRecord.timeZone,
                  status: action === "pause" ? "paused" : "active",
                },
              }),
          key,
          revision: reminderRecord.revision,
        }),
      );
      operations.current.delete(key);
      setReminders((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setMessage(
        action === "delete" ? "Reminder deleted and consent revoked." : `Reminder ${action}d.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reminder could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  async function reauthenticate(purpose: "account_export" | "account_erasure"): Promise<string> {
    if (!password) throw new Error("Enter your current password to continue.");
    const key = `reauth:${Date.now()}`;
    const proof = parseReauthentication(
      await request("auth/reauthenticate", { method: "POST", body: { password, purpose }, key }),
    );
    operations.current.delete(key);
    setPassword("");
    return proof.reauthenticationToken;
  }

  async function requestExport() {
    setBusy("export");
    try {
      const proof = await reauthenticate("account_export");
      const body = { formats: ["json", "csv"] };
      const key = `export:${JSON.stringify(body)}`;
      const job = parseExportJob(
        await request("exports", { method: "POST", body, key, recentAuth: proof }),
      );
      operations.current.delete(key);
      setExportJob(job);
      setMessage("Complete JSON and CSV export queued. Reconciliation status will be shown here.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export could not be requested.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshExport() {
    if (!exportJob) return;
    setBusy("export-status");
    try {
      setExportJob(parseExportJob(await request(`exports/${exportJob.id}`)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export status could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  async function requestErasure() {
    if (
      !confirmConsequences ||
      !window.confirm(
        "Permanently erase the account after the disclosed processing window? This cannot be undone.",
      )
    )
      return;
    setBusy("erasure");
    let staged = false;
    try {
      const proof = await reauthenticate("account_erasure");
      const body = { confirmation: "DELETE_MY_ACCOUNT" };
      const key = `erasure:${JSON.stringify(body)}`;
      await request("account/erasure/stage", {
        method: "POST",
        body,
        key,
        recentAuth: proof,
      });
      staged = true;
      const response = await fetch("/api/retention/account/erasure/submit", {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const value = await json(response);
      if (!response.ok) {
        throw new Error(responseError(value, "The protected erasure response was not received."));
      }
      const job = parseErasureJob(value);
      setErasureJob(job);
      setMessage("Account erasure request accepted. Opening the restart-safe status page…");
      window.location.assign("/erasure-status");
    } catch (error) {
      if (staged) {
        // The protected HttpOnly pending envelope survives an upstream or browser response loss.
        window.location.assign("/erasure-status");
      } else {
        setMessage(error instanceof Error ? error.message : "Erasure could not be requested.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function refreshErasure() {
    if (!erasureJob) return;
    setBusy("erasure-status");
    try {
      setErasureJob(parseErasureJob(await request("account/erasure/status")));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Erasure status could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed) {
      setMessage("Sign out could not be confirmed. Your private workspace remains open.");
      setBusy(null);
    }
  }

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          <Icon name="leaf" /> Nourishing
        </Link>
        <AppNavigation active="privacy" />
        <details className="ledgerAccount">
          <summary>Account</summary>
          <div className="ledgerAccountPanel">
            {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
            <button
              className="signOutButton"
              disabled={busy === "logout"}
              onClick={() => void signOut()}
              type="button"
            >
              Sign out
            </button>
            <p className="wellnessNote">Wellness information only—not medical advice.</p>
          </div>
        </details>
      </aside>

      <main className="dashboard retentionDashboard">
        <header className="dashboardHeader">
          <div>
            <p className="kicker">Retention milestone</p>
            <h1>Health, trends & privacy</h1>
          </div>
          <span className="statusPill">{session?.profile.timeZone ?? "Profile time"}</span>
        </header>
        <p className={`diaryStatus diaryStatus--${state}`} role="status" aria-live="polite">
          {message}
        </p>

        {Object.values(sectionErrors).some(Boolean) ? (
          <button
            className="secondaryAction"
            disabled={eventWriting}
            onClick={() => void loadAll()}
            type="button"
          >
            Retry private data
          </button>
        ) : null}

        <section className="retentionSection" aria-labelledby="trends-heading">
          {sectionStatus("nutrients")}
          <div className="sectionHeading">
            <div>
              <p className="kicker">Timezone-correct local days</p>
              <h2 id="trends-heading">Trends</h2>
            </div>
            <p>
              Partial nutrition is labeled as a lower bound; the browser never fills missing
              nutrients with zero.
            </p>
          </div>
          <fieldset className="retentionFilters">
            <legend>Date range and series</legend>
            <label>
              From
              <input
                type="date"
                value={from}
                onChange={(event) => {
                  if (canUseTrendInputs())
                    replaceTrendRange({ ...trendRangeRef.current, from: event.target.value });
                }}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={to}
                onChange={(event) => {
                  if (canUseTrendInputs())
                    replaceTrendRange({ ...trendRangeRef.current, to: event.target.value });
                }}
              />
            </label>
            <label style={{ flex: "1 1 220px", minWidth: 0 }}>
              Find a trend nutrient by name
              <input
                type="search"
                value={trendNutrientChoicesReady ? trendNutrientFilter.value : ""}
                maxLength={200}
                disabled={!trendNutrientChoicesReady}
                aria-describedby="trend-nutrient-search-status"
                onChange={(event) => changeTrendNutrientFilter(event.target.value)}
              />
            </label>
            <button
              className="secondaryAction"
              disabled={!trendNutrientChoicesReady}
              onClick={() => changeTrendNutrientFilter("")}
              type="button"
            >
              Clear trend nutrient filter
            </button>
            <label style={{ flex: "1 1 220px", minWidth: 0 }}>
              Nutrient
              <select
                value={trendNutrientChoicesReady ? selectedNutrient : ""}
                disabled={!trendNutrientChoicesReady}
                aria-describedby="trend-nutrient-search-status"
                onChange={(event) => chooseTrendNutrient(event.target.value)}
              >
                {!trendNutrientChoicesReady ? (
                  <option value="">Trend nutrients unavailable</option>
                ) : !chosenTrendNutrient ? (
                  <option value={selectedNutrient}>
                    {selectedNutrient
                      ? "Current selection unavailable in the loaded list"
                      : "No trend nutrient selected"}
                  </option>
                ) : null}
                {offeredTrendNutrients.map((item) => (
                  <option key={item.nutrientId} value={item.nutrientId}>
                    {item.name} ({item.unit})
                    {item.nutrientId === selectedNutrient && !matchingTrendNutrients.includes(item)
                      ? " · current selection, outside filter"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Biometric
              <select
                value={selectedDefinition}
                onChange={(event) => {
                  if (!canUseTrendInputs() || selectedDefinition === event.target.value) return;
                  eventDraftGeneration.current += 1;
                  setSelectedDefinition(event.target.value);
                }}
              >
                <option value="">None</option>
                {definitions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.canonicalUnit})
                    {item.status === "archived" ? " · archived" : ""}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <p className="finePrint" id="trend-nutrient-search-status" aria-live="polite">
            {trendNutrientChoicesReady
              ? nutrients.length === 0
                ? "No trend nutrients are available in the loaded list."
                : `${matchingTrendNutrients.length} matching of ${nutrients.length} loaded trend nutrients.`
              : state === "loading" && !privateUiClosed.current
                ? "Loading the trend nutrient list…"
                : "The trend nutrient list is unavailable. Reload this page to try again."}
            {trendNutrientChoicesReady &&
            nutrients.length > 0 &&
            matchingTrendNutrients.length === 0
              ? " No loaded nutrients match this name."
              : ""}
          </p>
          <fieldset className="retentionFilters" aria-label="Recent trend ranges">
            {([7, 30, 90] as const).map((days) => (
              <button
                key={days}
                className="secondaryAction"
                disabled={!canUseTrendPreset()}
                onClick={() => chooseTrendDays(days)}
                type="button"
              >
                Last {days} days
              </button>
            ))}
          </fieldset>
          <p className="finePrint">Ranges end today in your profile time zone.</p>
          <div className="trendTables">
            <div>
              <h3>{nutrientTrend?.nutrient.name ?? "Nutrition"}</h3>
              <p id="nutrition-trend-status" role="status" aria-live="polite">
                {trendStatus("nutrition", nutritionRead)}
              </p>
              {nutritionRead?.status === "error" ? (
                <button
                  className="secondaryAction"
                  type="button"
                  onClick={() => retryTrend("nutrition", nutritionRead)}
                >
                  Retry nutrition trend
                </button>
              ) : null}
              <p className="finePrint">
                Buckets use {nutrientTrend?.timeZone ?? session?.profile.timeZone ?? "profile time"}
                ; UTC bounds preserve 23/25-hour days.
              </p>
              <ul className="compactList">
                {nutrientTrend?.points.map((point) => (
                  <li key={point.localDate}>
                    <span>{point.localDate}</span>
                    <strong>{trendAggregateLabel(point.aggregate)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>{biometricTrend?.definition.name ?? "Biometrics"}</h3>
              <p id="biometric-trend-status" role="status" aria-live="polite">
                {trendStatus("biometric", biometricRead)}
              </p>
              {biometricRead?.status === "error" ? (
                <button
                  className="secondaryAction"
                  type="button"
                  onClick={() => retryTrend("biometric", biometricRead)}
                >
                  Retry biometric trend
                </button>
              ) : null}
              <p className="finePrint">
                Exact entered values; no averages are calculated in JavaScript.
              </p>
              <ul className="compactList">
                {biometricTrend?.points.map((point) => (
                  <li key={point.localDate}>
                    <span>
                      {point.localDate} · {point.count} sample{point.count === 1 ? "" : "s"}
                    </span>
                    <strong>
                      {point.last} {biometricTrend.definition.canonicalUnit}
                    </strong>
                    <small>
                      min {point.minimum} · max {point.maximum}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="retentionSection" aria-labelledby="biometrics-heading">
          {sectionStatus("biometrics")}
          <div className="sectionHeading">
            <div>
              <p className="kicker">Manual weight & metrics</p>
              <h2 id="biometrics-heading">Biometrics</h2>
            </div>
            <p>Imported records retain source identity. Only manual records can be edited here.</p>
          </div>
          <div className="retentionColumns">
            <div>
              <form
                className="retentionForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDefinition();
                }}
              >
                <h3>{editingDefinition ? "Revise metric definition" : "Add metric definition"}</h3>
                <div className="inlineFields">
                  <label>
                    Name
                    <input
                      maxLength={120}
                      value={definitionName}
                      onChange={(event) => setDefinitionName(event.target.value)}
                    />
                  </label>
                  <label>
                    Dimension
                    <select
                      disabled={editingDefinition !== null}
                      value={definitionDimension}
                      onChange={(event) =>
                        setDefinitionDimension(event.target.value as typeof definitionDimension)
                      }
                    >
                      <option value="mass">Mass</option>
                      <option value="length">Length</option>
                      <option value="temperature">Temperature</option>
                      <option value="duration">Duration</option>
                      <option value="count">Count</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>
                    Canonical unit
                    <input
                      disabled={editingDefinition !== null}
                      maxLength={32}
                      value={definitionUnit}
                      onChange={(event) => setDefinitionUnit(event.target.value)}
                    />
                  </label>
                </div>
                <div className="entryActions">
                  <button disabled={busy === "definition"} type="submit">
                    {editingDefinition ? "Save definition revision" : "Add metric"}
                  </button>
                  {editingDefinition ? (
                    <button
                      onClick={() => {
                        setEditingDefinition(null);
                        setDefinitionName("Weight");
                        setDefinitionDimension("mass");
                        setDefinitionUnit("kg");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </form>
              <ul className="recordList">
                {definitions.map((definition) => (
                  <li key={definition.id}>
                    <div>
                      <strong>
                        {definition.name} ({definition.canonicalUnit})
                      </strong>
                      <small>
                        {definition.dimension} · {definition.status}
                      </small>
                    </div>
                    <div className="entryActions">
                      <button
                        onClick={() => {
                          setEditingDefinition(definition);
                          setDefinitionName(definition.name);
                          setDefinitionDimension(definition.dimension);
                          setDefinitionUnit(definition.canonicalUnit);
                        }}
                        type="button"
                      >
                        Revise name
                      </button>
                      {definition.status === "active" ? (
                        <button
                          className="dangerAction"
                          disabled={busy === `definition:${definition.id}`}
                          onClick={() => void archiveDefinition(definition)}
                          type="button"
                        >
                          Archive
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              <form
                className="retentionForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEvent();
                }}
              >
                <h3>{editingEvent ? "Edit manual event" : "Log event"}</h3>
                <label>
                  Metric
                  <select
                    disabled={editingEvent !== null}
                    value={selectedDefinition}
                    onChange={(event) =>
                      changeEventField(
                        selectedDefinition,
                        event.target.value,
                        setSelectedDefinition,
                      )
                    }
                  >
                    {definitions
                      .filter((item) => item.status === "active")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.canonicalUnit})
                        </option>
                      ))}
                  </select>
                </label>
                <div className="inlineFields">
                  <label>
                    Exact value
                    <input
                      inputMode="decimal"
                      maxLength={160}
                      value={eventValue}
                      onChange={(event) =>
                        changeEventField(eventValue, event.target.value, setEventValue)
                      }
                    />
                  </label>
                  <label>
                    Local date
                    <input
                      type="date"
                      value={eventDate}
                      onChange={(event) =>
                        changeEventField(eventDate, event.target.value, setEventDate)
                      }
                    />
                  </label>
                  <label>
                    Local time
                    <input
                      type="time"
                      value={eventTime}
                      onChange={(event) =>
                        changeEventField(eventTime, event.target.value, setEventTime)
                      }
                    />
                  </label>
                </div>
                <small>
                  Interpreted in {session?.profile.timeZone ?? "your profile time zone"}. If date
                  and time are untouched, the original seconds and milliseconds are preserved.
                </small>
                <div className="entryActions">
                  <button
                    disabled={
                      eventWriting ||
                      historyController.current !== null ||
                      sectionControllers.current.biometrics !== undefined ||
                      !session
                    }
                    type="submit"
                  >
                    {editingEvent ? "Save event" : "Log event"}
                  </button>
                  {editingEvent ? (
                    <button
                      onClick={() => {
                        if (!canEditEventDraft()) return;
                        eventDraftGeneration.current += 1;
                        setEditingEvent(null);
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
            <div>
              <div className="entryActions" style={{ flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={historyUnavailable || earlierWindow === null}
                  onClick={() => {
                    if (earlierWindow) void loadHistory(earlierWindow);
                  }}
                >
                  Earlier window
                </button>
                <button
                  type="button"
                  disabled={historyUnavailable || newerWindow === null}
                  onClick={() => {
                    if (newerWindow) void loadHistory(newerWindow);
                  }}
                >
                  Newer window
                </button>
                <button
                  type="button"
                  disabled={
                    historyUnavailable ||
                    !recentHistory.current ||
                    eventWindow?.from === recentHistory.current.from
                  }
                  onClick={() => {
                    if (recentHistory.current) void loadHistory(recentHistory.current);
                  }}
                >
                  Recent history
                </button>
                <button
                  type="button"
                  disabled={historyUnavailable || !eventWindow}
                  onClick={() => {
                    if (eventWindow) void loadHistory(eventWindow);
                  }}
                >
                  Reload history
                </button>
              </div>
              <div className="retentionForm">
                <label style={{ minWidth: 0 }}>
                  History metric
                  <select
                    style={{ maxWidth: "100%" }}
                    disabled={!canUseHistoryMetric()}
                    value={historyVisible ? historyMetric : ""}
                    onChange={(event) => changeHistoryMetric(event.target.value)}
                  >
                    <option value="">All metrics</option>
                    {historyMetricChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label === null
                          ? `Metric unavailable (unit unavailable) · ${choice.id}`
                          : `${choice.label}${(historyMetricLabelCounts.get(choice.label) ?? 0) > 1 ? ` · ${choice.id}` : ""}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="entryActions">
                  <button
                    type="button"
                    disabled={!canUseHistoryMetric()}
                    onClick={() => changeHistoryMetric("")}
                  >
                    All metrics
                  </button>
                </div>
              </div>
              {historyVisible && history.verified ? (
                <p id="biometric-history-filter-status" role="status" aria-live="polite">
                  Showing {shownEvents.length} of {events.length} loaded readings. This filter
                  applies only to loaded readings.
                  {historyMetric && shownEvents.length === 0
                    ? " No loaded readings match this metric."
                    : ""}
                </p>
              ) : null}
              <p
                id="biometric-history-status"
                role="status"
                aria-live="polite"
                style={{ overflowWrap: "anywhere" }}
              >
                {historyVisible && eventWindow ? (
                  <>
                    UTC history: {eventWindow.from} through {eventWindow.to}. Includes both
                    endpoints. Adjacent windows share their boundary.
                    {history.verified
                      ? ` ${events.length} loaded readings. ${eventCursor ? "More readings may be available in this window." : history.status === "ready" ? "No more readings in this window." : "No continuation is available."}`
                      : " This window has not been verified."}
                    {history.message ? ` ${history.message}` : ""}
                  </>
                ) : (
                  "Biometric history is unavailable until your private data is verified."
                )}
              </p>
              <ul className="recordList">
                {shownEvents.map((event) => {
                  const definition = definitions.find((item) => item.id === event.definitionId);
                  return (
                    <li key={event.id}>
                      <div>
                        <strong>
                          {event.value} {definition?.canonicalUnit ?? "unit unavailable"} ·{" "}
                          {definition?.name ?? "Metric unavailable"}
                        </strong>
                        <small>
                          {event.localDate} ·{" "}
                          {new Intl.DateTimeFormat("en-GB", {
                            timeZone: event.timeZone,
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hourCycle: "h23",
                          }).format(new Date(event.measuredAt))}{" "}
                          · {event.timeZone} · {event.source.kind}
                        </small>
                      </div>
                      {event.source.kind === "manual" ? (
                        <div className="entryActions">
                          <button
                            disabled={historyUnavailable || !history.verified}
                            onClick={() => editEvent(event)}
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            className="dangerAction"
                            disabled={historyUnavailable || !history.verified}
                            onClick={() => void deleteEvent(event)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {historyVisible && eventCursor ? (
                <button
                  disabled={historyUnavailable}
                  onClick={() => {
                    if (eventWindow) void loadHistory(eventWindow, true);
                  }}
                  type="button"
                >
                  Load older biometric events
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="retentionSection" aria-labelledby="reminders-heading">
          {sectionStatus("reminders")}
          <div className="sectionHeading">
            <div>
              <p className="kicker">Explicit notification consent</p>
              <h2 id="reminders-heading">Reminders</h2>
            </div>
            <p>
              The lock screen always says “Nutrition Tracker” and “Time to check in.” The web stores
              consent and schedule only; delivery starts after a signed mobile app syncs it to that
              device.
            </p>
          </div>
          <div className="retentionColumns">
            <form
              className="retentionForm"
              onSubmit={(event) => {
                event.preventDefault();
                void saveReminder();
              }}
            >
              <label>
                Private in-app label
                <input
                  maxLength={120}
                  value={reminder.label}
                  disabled={!canEditReminder()}
                  onChange={(event) =>
                    changeReminderDraft({ ...reminder, label: event.target.value })
                  }
                />
              </label>
              <label>
                Local time
                <input
                  type="time"
                  value={reminder.localTime}
                  disabled={!canEditReminder()}
                  onChange={(event) =>
                    changeReminderDraft({ ...reminder, localTime: event.target.value })
                  }
                />
              </label>
              <fieldset>
                <legend>Days</legend>
                <div className="entryActions" style={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["Weekdays", [1, 2, 3, 4, 5]],
                      ["Weekends", [6, 7]],
                      ["Every day", [1, 2, 3, 4, 5, 6, 7]],
                    ] as const
                  ).map(([label, days]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={reminderDaysMatch(days)}
                      disabled={!canEditReminder()}
                      onClick={() => selectReminderDays(days)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="dayChoices">
                  {dayNames.map((name, index) => {
                    const day = index + 1;
                    return (
                      <label key={name}>
                        <input
                          checked={reminder.daysOfWeek.includes(day)}
                          disabled={!canEditReminder()}
                          onChange={() =>
                            changeReminderDraft({
                              ...reminder,
                              daysOfWeek: reminder.daysOfWeek.includes(day)
                                ? reminder.daysOfWeek.filter((item) => item !== day)
                                : [...reminder.daysOfWeek, day].sort(),
                            })
                          }
                          type="checkbox"
                        />
                        {name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <label className="consentLine">
                <input required type="checkbox" />I consent to this schedule being synced as generic
                local notifications by a signed mobile app.
              </label>
              <div className="entryActions">
                <button disabled={reminderSaving || !canEditReminder()} type="submit">
                  {reminder.id ? "Save reminder" : "Create reminder"}
                </button>
                {reminder.id ? (
                  <button
                    disabled={!canEditReminder()}
                    onClick={() => {
                      if (canEditReminder()) replaceReminder(reminderDraft());
                    }}
                    type="button"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
            <ul className="recordList">
              {reminders.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.localTime} · {item.timeZone} · {item.status}
                    </small>
                    <small>
                      Saved days:{" "}
                      {dayNames
                        .filter((_, index) => item.daysOfWeek.includes(index + 1))
                        .join(", ")}
                    </small>
                    <small>Lock screen: {item.deliveryPolicy.lockScreenText}</small>
                  </div>
                  <div className="entryActions">
                    <button
                      disabled={!canEditReminder()}
                      onClick={() => editReminder(item)}
                      type="button"
                    >
                      Edit
                    </button>
                    {item.status !== "revoked" ? (
                      <>
                        <button
                          disabled={busy === `reminder:${item.id}`}
                          onClick={() =>
                            void changeReminder(item, item.status === "paused" ? "resume" : "pause")
                          }
                          type="button"
                        >
                          {item.status === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="dangerAction"
                          onClick={() => void changeReminder(item, "delete")}
                          type="button"
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="retentionSection privacyCenter" aria-labelledby="privacy-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Control and portability</p>
              <h2 id="privacy-heading">Privacy Center</h2>
            </div>
            <p>
              Exports and erasure require your password again. Reauthentication proofs are
              single-use and kept only for the immediate request.
            </p>
          </div>
          <div className="privacyGrid">
            <article>
              <h3>Health integrations</h3>
              {sectionStatus("integrations")}
              {sectionLoading.integrations ||
              sectionErrors.integrations ? null : integrations.length === 0 ? (
                <p>
                  No connected health platforms. Connect weight import from the mobile app, where
                  the operating system can show its permission sheet.
                </p>
              ) : (
                <ul className="recordList">
                  {integrations.map((integration) => (
                    <li key={integration.platform}>
                      <div>
                        <strong>
                          {integration.platform === "apple_healthkit"
                            ? "Apple Health"
                            : "Health Connect"}
                        </strong>
                        <small>
                          {integration.status} · scope: {integration.dataTypeCodes.join(", ")}
                        </small>
                        <small>
                          Consent {new Date(integration.consentGrantedAt).toLocaleString()} ·{" "}
                          {integration.consentHistory.length} recorded consent event
                          {integration.consentHistory.length === 1 ? "" : "s"}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article>
              <h3>Complete data export</h3>
              <p>
                Includes JSON and CSV plus hashes and reconciliation counts. Downloads are
                authenticated, same-origin, and expire.
              </p>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="buttonPrimary"
                disabled={busy === "export"}
                onClick={() => void requestExport()}
                type="button"
              >
                Request JSON + CSV export
              </button>
              {exportJob ? (
                <div className="jobStatus">
                  <strong>Status: {exportJob.status}</strong>
                  <button
                    className="secondaryAction"
                    disabled={busy === "export-status"}
                    onClick={() => void refreshExport()}
                    type="button"
                  >
                    Refresh status
                  </button>
                  {exportJob.reconciliation ? (
                    <>
                      <small>
                        Reconciled: {exportJob.reconciliation.reconciled ? "yes" : "no"}
                      </small>
                      <small>
                        {exportJob.reconciliation.entities.length} entity groups checked at{" "}
                        {exportJob.reconciliation.snapshotWatermark}
                      </small>
                    </>
                  ) : null}
                  {exportJob.artifacts.map((artifact) => (
                    <a
                      href={artifact.downloadPath.replace(/^\/v1/u, "/api/retention")}
                      key={artifact.format}
                    >
                      Download {artifact.format.toUpperCase()} ({artifact.byteLength} bytes)
                    </a>
                  ))}
                </div>
              ) : null}
            </article>
            <article className="dangerZone">
              <h3>Erase account</h3>
              <p>
                This permanently revokes account access, deletes private health data, and revokes
                export links after the disclosed processing window. Export first if you need a copy.
                This cannot be undone.
              </p>
              <label className="consentLine">
                <input
                  checked={confirmConsequences}
                  onChange={(event) => setConfirmConsequences(event.target.checked)}
                  type="checkbox"
                />
                I understand account access and export links will be revoked and private health data
                deleted.
              </label>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="buttonDanger dangerAction"
                disabled={!confirmConsequences || busy === "erasure"}
                onClick={() => void requestErasure()}
                type="button"
              >
                Request permanent erasure
              </button>
              {erasureJob ? (
                <div className="jobStatus">
                  <strong>Erasure status: {erasureJob.status}</strong>
                  <small>
                    Scheduled no earlier than {new Date(erasureJob.executeAfter).toLocaleString()}
                  </small>
                  <small>
                    Recent authentication:{" "}
                    {erasureJob.recentAuthenticationSatisfied ? "confirmed" : "required"}
                  </small>
                  <small>{erasureJob.consequences.join(" · ")}</small>
                  <button
                    className="secondaryAction"
                    disabled={busy === "erasure-status"}
                    onClick={() => void refreshErasure()}
                    type="button"
                  >
                    Refresh status
                  </button>
                </div>
              ) : null}
            </article>
          </div>
        </section>
      </main>
    </>
  );
}
