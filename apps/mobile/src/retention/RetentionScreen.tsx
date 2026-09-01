import type {
  AccountErasureJob,
  AccountExportJob,
  BiometricDefinition,
  BiometricEvent,
  CustomFood,
  CustomFoodNutrientDraft,
  ExportArtifact,
  HealthPlatform,
  PlatformIntegration,
  Reminder,
} from "@nutrition-tracker/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
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
  currentLocalTime,
  isLocalDate,
  isPositiveDecimal,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  mealLabel,
  mealSlots,
  parseDiaryMutation,
  shiftLocalDate,
} from "../diary/diary";
import { parseTargetableNutrients, type TargetableNutrient } from "../recipes/recipes-goals";
import { palette } from "../theme";
import {
  createHardwareDeviceSigner,
  createRegistrationProof,
  type SignedHealthImportEnvelope,
} from "./device-signing";
import {
  clearRegisteredHealthDevice,
  loadRegisteredHealthDevice,
  saveRegisteredHealthDevice,
} from "./device-state";
import { establishHealthCursorEpoch } from "./health-connection";
import { clearHealthCursor, createSecureHealthSyncStore } from "./health-cursor-store";
import { RetryableHealthImportTransportError, syncNativeWeight } from "./health-sync";
import { createNativeHealthAdapter } from "./native-health";
import { createExpoNotificationAdapter } from "./notifications";
import { ACCOUNT_ERASURE_SERIALIZED_BODY, createPendingErasureStore } from "./pending-erasure";
import {
  clearAllLocalReminderSchedules,
  createSecureReminderScheduleStore,
  reconcileLocalReminderSchedules,
} from "./reminder-schedule";
import {
  parseBiometricTrend,
  parseCustomFoodList,
  parseCustomFoodResponse,
  parseDefinitionResponse,
  parseDefinitions,
  parseDeviceChallenge,
  parseErasureResponse,
  parseEventList,
  parseEventResponse,
  parseExportResponse,
  parseHealthDeviceResponse,
  parseHealthImportResponse,
  parseIntegrationResponse,
  parseIntegrations,
  parseNutrientTrend,
  parseReauthentication,
  parseReminderResponse,
  parseReminders,
} from "./retention";

interface Props {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly onUnauthorized: () => Promise<void>;
  /** Fence queued diary delivery after the erasure request is durable and before it is sent. */
  readonly onErasurePrepared: () => void;
  readonly onErasureAccepted: (input: {
    readonly job: AccountErasureJob;
    readonly token: string;
    readonly expiresAt: string;
  }) => Promise<void>;
}

interface StableOperation {
  readonly id: string;
  readonly serializedBody: string | null;
}

interface CustomDraft {
  readonly id: string | null;
  readonly revision: string | null;
  readonly name: string;
  readonly brandName: string;
  readonly servingLabel: string;
  readonly servingGrams: string;
  readonly notes: string;
  readonly nutrients: string;
}

interface EventDraft {
  readonly event: BiometricEvent | null;
  readonly definitionId: string;
  readonly value: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly originalLocalDate: string;
  readonly originalLocalTime: string;
}

interface ReminderDraft {
  readonly reminder: Reminder | null;
  readonly label: string;
  readonly localTime: string;
  readonly days: readonly number[];
  readonly status: "active" | "paused";
}

interface CustomLogDraft {
  readonly food: CustomFood;
  readonly quantity: string;
  readonly kind: "grams" | "serving";
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
}

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const EXACT_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const API_CURSOR = /^[A-Za-z0-9_.-]{1,512}$/u;
const MAX_EXPORT_BYTES = 10_737_418_240;

function blankCustom(): CustomDraft {
  return {
    id: null,
    revision: null,
    name: "",
    brandName: "",
    servingLabel: "",
    servingGrams: "",
    notes: "",
    nutrients: "",
  };
}

function nutrientInput(food: CustomFood): string {
  return food.currentVersion.nutrients
    .map((item) => {
      if (item.state === "quantified") return `${item.nutrient.id}=${item.amountPer100Grams}`;
      if (item.state === "trace") return `${item.nutrient.id}=trace`;
      return `${item.nutrient.id}=unknown:${item.reason}`;
    })
    .join("\n");
}

function customDraft(food: CustomFood): CustomDraft {
  return {
    id: food.id,
    revision: food.revision,
    name: food.currentVersion.name,
    brandName: food.currentVersion.brandName ?? "",
    servingLabel: food.currentVersion.serving?.label ?? "",
    servingGrams: food.currentVersion.serving?.grams ?? "",
    notes: food.currentVersion.notes ?? "",
    nutrients: nutrientInput(food),
  };
}

export function parseCanonicalNutrientInput(value: string): readonly CustomFoodNutrientDraft[] {
  const rows = value
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 1 || rows.length > 256) {
    throw new RangeError("Enter between 1 and 256 canonical nutrient rows.");
  }
  const result = rows.map((row): CustomFoodNutrientDraft => {
    const separator = row.indexOf("=");
    const nutrientId = row.slice(0, separator);
    const amount = row.slice(separator + 1);
    if (separator < 1 || !/^[1-9][0-9]{0,19}$/u.test(nutrientId)) {
      throw new TypeError("Each nutrient row must start with its numeric nutrient ID.");
    }
    if (NON_NEGATIVE_DECIMAL.test(amount) && amount.length <= 200) {
      return { nutrientId, state: "quantified", amountPer100Grams: amount };
    }
    if (amount === "trace") return { nutrientId, state: "trace", amountPer100Grams: null };
    const unknown = /^unknown:(not_reported|not_analyzed|not_applicable|withheld)$/u.exec(amount);
    if (unknown?.[1]) {
      return {
        nutrientId,
        state: "unknown",
        amountPer100Grams: null,
        reason: unknown[1] as "not_reported" | "not_analyzed" | "not_applicable" | "withheld",
      };
    }
    throw new TypeError("Use an exact amount per 100 g, trace, or unknown:<reason>.");
  });
  if (new Set(result.map((row) => row.nutrientId)).size !== result.length) {
    throw new TypeError("Each nutrient may appear only once.");
  }
  return result;
}

export function nutrientTrendLabel(
  aggregate: ReturnType<typeof parseNutrientTrend>["points"][number]["aggregate"],
): string {
  if (aggregate === null) return "No data";
  return aggregate.isExact
    ? `${aggregate.knownAmount} ${aggregate.unit} · exact`
    : `At least ${aggregate.knownAmount} ${aggregate.unit} · ${aggregate.completeness}`;
}

export function eventTimeWasUnchanged(
  event: BiometricEvent,
  localDate: string,
  localTime: string,
): boolean {
  return (
    event.localDate === localDate &&
    localTimeInTimeZone(new Date(event.measuredAt), event.timeZone).slice(0, 5) === localTime
  );
}

function initialEvent(profileTimeZone: string): EventDraft {
  const now = new Date();
  return {
    event: null,
    definitionId: "",
    value: "",
    localDate: new Intl.DateTimeFormat("en-CA", { timeZone: profileTimeZone }).format(now),
    localTime: localTimeInTimeZone(now, profileTimeZone).slice(0, 5),
    originalLocalDate: "",
    originalLocalTime: "",
  };
}

function initialReminder(): ReminderDraft {
  return {
    reminder: null,
    label: "Daily check-in",
    localTime: "20:00",
    days: [1, 2, 3, 4, 5, 6, 7],
    status: "active",
  };
}

function quoteRevision(revision: string): string {
  if (!/^[1-9][0-9]*$/u.test(revision)) throw new TypeError("The revision was invalid.");
  return `"${revision}"`;
}

function platformForDevice(): HealthPlatform | null {
  if (Platform.OS === "ios") return "apple_healthkit";
  if (Platform.OS === "android") return "android_health_connect";
  return null;
}

export function RetentionScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  onUnauthorized,
  onErasurePrepared,
  onErasureAccepted,
}: Props) {
  const today = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: profileTimeZone }).format(new Date()),
    [profileTimeZone],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Opening private health data…");
  const [nutrients, setNutrients] = useState<readonly TargetableNutrient[]>([]);
  const [foods, setFoods] = useState<readonly CustomFood[]>([]);
  const [foodCursor, setFoodCursor] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<readonly BiometricDefinition[]>([]);
  const [events, setEvents] = useState<readonly BiometricEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventRange, setEventRange] = useState<{
    readonly from: string;
    readonly to: string;
  } | null>(null);
  const [reminders, setReminders] = useState<readonly Reminder[]>([]);
  const [integrations, setIntegrations] = useState<readonly PlatformIntegration[]>([]);
  const [custom, setCustom] = useState<CustomDraft>(blankCustom);
  const [customLog, setCustomLog] = useState<CustomLogDraft | null>(null);
  const [definitionName, setDefinitionName] = useState("Weight");
  const [definitionDimension, setDefinitionDimension] =
    useState<BiometricDefinition["dimension"]>("mass");
  const [definitionUnit, setDefinitionUnit] = useState("kg");
  const [definitionNotes, setDefinitionNotes] = useState("");
  const [editingDefinition, setEditingDefinition] = useState<BiometricDefinition | null>(null);
  const [eventDraft, setEventDraft] = useState(() => initialEvent(profileTimeZone));
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft>(initialReminder);
  const [from, setFrom] = useState(() => shiftLocalDate(today, -13));
  const [to, setTo] = useState(today);
  const [selectedNutrient, setSelectedNutrient] = useState("");
  const [selectedDefinition, setSelectedDefinition] = useState("");
  const [nutrientTrend, setNutrientTrend] = useState<ReturnType<typeof parseNutrientTrend> | null>(
    null,
  );
  const [biometricTrend, setBiometricTrend] = useState<ReturnType<
    typeof parseBiometricTrend
  > | null>(null);
  const [exportJob, setExportJob] = useState<AccountExportJob | null>(null);
  const [password, setPassword] = useState("");
  const [erasureConfirmation, setErasureConfirmation] = useState("");
  const [healthState, setHealthState] = useState("Not checked on this signed build.");
  const operations = useRef(new Map<string, StableOperation>());
  const loadController = useRef<AbortController | null>(null);
  const trendController = useRef<AbortController | null>(null);

  const stableOperation = useCallback((key: string, serializedBody: string | null) => {
    const existing = operations.current.get(key);
    if (existing) {
      if (existing.serializedBody !== serializedBody) {
        throw new Error("The pending retry body changed. Refresh before trying again.");
      }
      return existing;
    }
    const operation = { id: newOperationId(), serializedBody };
    operations.current.set(key, operation);
    return operation;
  }, []);

  const request = useCallback(
    async (
      path: string,
      input: {
        readonly method?: "DELETE" | "PATCH" | "POST";
        readonly body?: unknown;
        readonly operationKey?: string;
        readonly revision?: string;
        readonly recentAuth?: string;
        readonly signal?: AbortSignal;
        readonly capability?: string;
      } = {},
    ): Promise<unknown> => {
      const serializedBody = input.body === undefined ? null : JSON.stringify(input.body);
      const operation = input.operationKey
        ? stableOperation(input.operationKey, serializedBody)
        : null;
      const headers: Record<string, string> = { ...authenticatedHeaders(accessToken) };
      if (serializedBody !== null) headers["content-type"] = "application/json";
      if (operation) headers["idempotency-key"] = operation.id;
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
      if (input.recentAuth) headers["x-reauthentication-token"] = input.recentAuth;
      if (input.capability) headers["x-erasure-status-token"] = input.capability;
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        method: input.method ?? "GET",
        headers,
        ...(serializedBody === null ? {} : { body: serializedBody }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (response.status === 401) {
        await onUnauthorized();
        throw new Error("This private session ended.");
      }
      const value = await jsonBody(response);
      if (response.status === 412 && input.operationKey)
        operations.current.delete(input.operationKey);
      if (!response.ok) throw new Error(responseError(value, "The private health request failed."));
      if (input.operationKey) operations.current.delete(input.operationKey);
      return value;
    },
    [accessToken, apiBase, onUnauthorized, stableOperation],
  );

  const reconcileReminders = useCallback(async (items: readonly Reminder[]) => {
    try {
      const result = await reconcileLocalReminderSchedules(
        items,
        createExpoNotificationAdapter(),
        createSecureReminderScheduleStore(),
      );
      if (result.permission !== "granted" && items.some((item) => item.status === "active")) {
        setMessage(
          "Reminder schedules are saved, but local notification permission is not active.",
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Local reminders could not be reconciled.",
      );
    }
  }, []);

  const loadAll = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    try {
      const rangeFrom = new Date(Date.now() - 120 * 86_400_000).toISOString();
      const rangeTo = new Date(Date.now() + 86_400_000).toISOString();
      const paths = [
        "/v1/nutrients/targetable",
        "/v1/custom-foods?limit=50",
        "/v1/biometrics/definitions",
        `/v1/biometrics/events?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}&limit=100`,
        "/v1/reminders",
        "/v1/integrations/health",
      ] as const;
      const responses = await Promise.all(
        paths.map((path) =>
          fetch(apiUrl(apiBase, path).toString(), {
            headers: authenticatedHeaders(accessToken),
            signal: controller.signal,
          }),
        ),
      );
      if (responses.some((response) => response.status === 401)) return onUnauthorized();
      const values = await Promise.all(responses.map(jsonBody));
      for (let index = 0; index < responses.length; index += 1) {
        if (!responses[index]?.ok) {
          throw new Error(responseError(values[index], "Private health data could not be loaded."));
        }
      }
      if (controller.signal.aborted) return;
      const nextNutrients = parseTargetableNutrients(values[0]);
      const foodPage = parseCustomFoodList(values[1]);
      const nextDefinitions = parseDefinitions(values[2]);
      const eventPage = parseEventList(values[3]);
      const nextReminders = parseReminders(values[4]);
      setNutrients(nextNutrients);
      setFoods(foodPage.items);
      setFoodCursor(foodPage.nextCursor);
      setDefinitions(nextDefinitions);
      setEvents(eventPage.items);
      setEventCursor(eventPage.nextCursor);
      setEventRange({ from: rangeFrom, to: rangeTo });
      setReminders(nextReminders);
      setIntegrations(parseIntegrations(values[5]));
      setSelectedNutrient((value) => value || nextNutrients[0]?.nutrientId || "");
      setSelectedDefinition(
        (value) => value || nextDefinitions.find((item) => item.status === "active")?.id || "",
      );
      setEventDraft((value) => ({
        ...value,
        definitionId:
          value.definitionId || nextDefinitions.find((item) => item.status === "active")?.id || "",
      }));
      await reconcileReminders(nextReminders);
      setMessage("Private health data is current.");
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(
          error instanceof Error ? error.message : "Private health data could not be loaded.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [accessToken, apiBase, onUnauthorized, reconcileReminders]);

  useEffect(() => {
    void loadAll();
    return () => loadController.current?.abort();
  }, [loadAll]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void (async () => {
        try {
          const nextReminders = parseReminders(await request("/v1/reminders"));
          setReminders(nextReminders);
          await reconcileReminders(nextReminders);
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Reminders could not be refreshed.");
        }
      })();
    });
    return () => subscription.remove();
  }, [reconcileReminders, request]);

  async function loadTrends() {
    if (!isLocalDate(from) || !isLocalDate(to) || from > to) {
      setMessage("Trend dates must be a valid ordered local-date range.");
      return;
    }
    trendController.current?.abort();
    const controller = new AbortController();
    trendController.current = controller;
    setBusy("trends");
    try {
      const [nutrientValue, biometricValue] = await Promise.all([
        selectedNutrient
          ? request(
              `/v1/trends/nutrients?nutrientId=${encodeURIComponent(selectedNutrient)}&from=${from}&to=${to}`,
              { signal: controller.signal },
            )
          : null,
        selectedDefinition
          ? request(
              `/v1/trends/biometrics?definitionId=${encodeURIComponent(selectedDefinition)}&from=${from}&to=${to}`,
              { signal: controller.signal },
            )
          : null,
      ]);
      if (controller.signal.aborted) return;
      setNutrientTrend(nutrientValue ? parseNutrientTrend(nutrientValue) : null);
      setBiometricTrend(biometricValue ? parseBiometricTrend(biometricValue) : null);
      setMessage(`Trends use local-day boundaries in ${profileTimeZone}.`);
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Trends failed.");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function saveCustomFood() {
    if (!custom.name.trim()) return setMessage("A custom food name is required.");
    let nutrientRows: readonly CustomFoodNutrientDraft[];
    try {
      nutrientRows = parseCanonicalNutrientInput(custom.nutrients);
    } catch (error) {
      return setMessage(error instanceof Error ? error.message : "Nutrient rows were invalid.");
    }
    const servingRequested = custom.servingLabel.trim() || custom.servingGrams.trim();
    if (
      servingRequested &&
      (!custom.servingLabel.trim() || !isPositiveDecimal(custom.servingGrams))
    ) {
      return setMessage("A serving requires a label and positive grams.");
    }
    const body = {
      name: custom.name.trim(),
      brandName: custom.brandName.trim() || null,
      serving: servingRequested
        ? { label: custom.servingLabel.trim(), grams: custom.servingGrams }
        : null,
      nutrients: nutrientRows,
      notes: custom.notes.trim() || null,
    };
    const path = custom.id ? `/v1/custom-foods/${custom.id}/revisions` : "/v1/custom-foods";
    const key = `custom:${custom.id ?? "new"}:${custom.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("custom");
    try {
      const saved = parseCustomFoodResponse(
        await request(path, {
          method: "POST",
          body,
          operationKey: key,
          ...(custom.revision ? { revision: custom.revision } : {}),
        }),
      );
      setFoods((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setCustom(blankCustom());
      setMessage(`Saved owner-entered private food version ${saved.currentVersion.versionNumber}.`);
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Custom food failed."} Submit again for an exact retry.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function archiveCustomFood(food: CustomFood) {
    const key = `custom-archive:${food.id}:${food.revision}`;
    setBusy(`food:${food.id}`);
    try {
      const saved = parseCustomFoodResponse(
        await request(`/v1/custom-foods/${food.id}`, {
          method: "DELETE",
          operationKey: key,
          revision: food.revision,
        }),
      );
      setFoods((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setMessage("Custom food archived; exact diary history remains pinned.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Custom food could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  async function logCustomFood() {
    if (!customLog || !isPositiveDecimal(customLog.quantity)) {
      return setMessage("Enter a positive custom-food quantity.");
    }
    const serving = customLog.food.currentVersion.serving;
    if (customLog.kind === "serving" && !serving)
      return setMessage("This food has no serving definition.");
    let occurredAt: string;
    try {
      occurredAt = localDateTimeToInstant(
        customLog.localDate,
        customLog.localTime,
        profileTimeZone,
      );
    } catch (error) {
      return setMessage(error instanceof Error ? error.message : "Log time was invalid.");
    }
    const body = {
      customFoodVersionId: customLog.food.currentVersion.id,
      portion:
        customLog.kind === "serving" && serving
          ? { kind: "serving" as const, servingId: serving.id, amount: customLog.quantity }
          : { kind: "grams" as const, grams: customLog.quantity },
      mealSlot: customLog.mealSlot,
      occurredAt,
    };
    const key = `custom-log:${customLog.food.id}:${customLog.food.currentVersion.id}:${JSON.stringify(body)}`;
    setBusy("custom-log");
    try {
      const result = parseDiaryMutation(
        await request(`/v1/custom-foods/${customLog.food.id}/log`, {
          method: "POST",
          body,
          operationKey: key,
        }),
      );
      setCustomLog(null);
      setMessage(
        `Pinned custom-food version logged on ${result.entry?.localDate ?? customLog.localDate}.`,
      );
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Log failed."} Submit again for the same retry.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function loadMoreFoods() {
    if (!foodCursor || !API_CURSOR.test(foodCursor)) return;
    setBusy("food-more");
    try {
      const page = parseCustomFoodList(
        await request(`/v1/custom-foods?limit=50&cursor=${encodeURIComponent(foodCursor)}`),
      );
      setFoods((items) => [
        ...items,
        ...page.items.filter((item) => !items.some((old) => old.id === item.id)),
      ]);
      setFoodCursor(page.nextCursor);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "More custom foods could not be loaded.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDefinition() {
    if (!definitionName.trim() || !definitionUnit.trim())
      return setMessage("Metric name and unit are required.");
    const body = editingDefinition
      ? { name: definitionName.trim(), notes: definitionNotes.trim() || null }
      : {
          name: definitionName.trim(),
          dimension: definitionDimension,
          canonicalUnit: definitionUnit.trim(),
          notes: definitionNotes.trim() || null,
        };
    const path = editingDefinition
      ? `/v1/biometrics/definitions/${editingDefinition.id}`
      : "/v1/biometrics/definitions";
    const key = `definition:${editingDefinition?.id ?? "new"}:${editingDefinition?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("definition");
    try {
      const saved = parseDefinitionResponse(
        await request(path, {
          method: editingDefinition ? "PATCH" : "POST",
          body,
          operationKey: key,
          ...(editingDefinition ? { revision: editingDefinition.revision } : {}),
        }),
      );
      setDefinitions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setEditingDefinition(null);
      setDefinitionName("Weight");
      setDefinitionDimension("mass");
      setDefinitionUnit("kg");
      setDefinitionNotes("");
      setMessage("Biometric definition saved; its dimension and unit are immutable history.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric definition failed.");
    } finally {
      setBusy(null);
    }
  }

  async function archiveDefinition(definition: BiometricDefinition) {
    const key = `definition-archive:${definition.id}:${definition.revision}`;
    setBusy(`definition:${definition.id}`);
    try {
      const saved = parseDefinitionResponse(
        await request(`/v1/biometrics/definitions/${definition.id}`, {
          method: "DELETE",
          operationKey: key,
          revision: definition.revision,
        }),
      );
      setDefinitions((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setMessage("Metric archived; historical events and trends remain available.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEvent() {
    if (!eventDraft.definitionId || !EXACT_DECIMAL.test(eventDraft.value)) {
      return setMessage("Choose a metric and enter an exact decimal value.");
    }
    let measuredAt: string;
    try {
      measuredAt = localDateTimeToInstant(
        eventDraft.localDate,
        eventDraft.localTime,
        profileTimeZone,
      );
    } catch (error) {
      return setMessage(error instanceof Error ? error.message : "Metric time was invalid.");
    }
    const body = eventDraft.event
      ? {
          value: eventDraft.value,
          ...(eventTimeWasUnchanged(eventDraft.event, eventDraft.localDate, eventDraft.localTime)
            ? {}
            : { measuredAt }),
        }
      : { definitionId: eventDraft.definitionId, measuredAt, value: eventDraft.value };
    const path = eventDraft.event
      ? `/v1/biometrics/events/${eventDraft.event.id}`
      : "/v1/biometrics/events";
    const key = `event:${eventDraft.event?.id ?? "new"}:${eventDraft.event?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("event");
    try {
      const saved = parseEventResponse(
        await request(path, {
          method: eventDraft.event ? "PATCH" : "POST",
          body,
          operationKey: key,
          ...(eventDraft.event ? { revision: eventDraft.event.revision } : {}),
        }),
      );
      if (saved) setEvents((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setEventDraft((value) => ({
        ...initialEvent(profileTimeZone),
        definitionId: value.definitionId,
      }));
      setMessage("Biometric event saved without rounding its entered decimal.");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Metric event failed."} Submit again for an exact retry.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function deleteEvent(event: BiometricEvent) {
    const key = `event-delete:${event.id}:${event.revision}`;
    setBusy(`event:${event.id}`);
    try {
      parseEventResponse(
        await request(`/v1/biometrics/events/${event.id}`, {
          method: "DELETE",
          operationKey: key,
          revision: event.revision,
        }),
      );
      setEvents((items) => items.filter((item) => item.id !== event.id));
      setMessage("Biometric event deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric event could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  async function loadMoreEvents() {
    if (!eventCursor || !eventRange || !API_CURSOR.test(eventCursor)) return;
    setBusy("event-more");
    try {
      const page = parseEventList(
        await request(
          `/v1/biometrics/events?from=${encodeURIComponent(eventRange.from)}&to=${encodeURIComponent(eventRange.to)}&limit=100&cursor=${encodeURIComponent(eventCursor)}`,
        ),
      );
      setEvents((items) => [
        ...items,
        ...page.items.filter((item) => !items.some((old) => old.id === item.id)),
      ]);
      setEventCursor(page.nextCursor);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "More biometric events could not be loaded.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function refreshReminderSchedules(next: readonly Reminder[]) {
    setReminders(next);
    await reconcileReminders(next);
  }

  async function saveReminder() {
    if (
      !reminderDraft.label.trim() ||
      !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(reminderDraft.localTime) ||
      reminderDraft.days.length < 1
    ) {
      return setMessage("A reminder needs a label, local time, and at least one weekday.");
    }
    if (!reminderDraft.reminder) {
      const permission = await createExpoNotificationAdapter().requestPermissionInContext();
      if (permission !== "granted") {
        setMessage("Notification access was not granted. No reminder consent was recorded.");
        return;
      }
    }
    const body = reminderDraft.reminder
      ? {
          label: reminderDraft.label.trim(),
          localTime: reminderDraft.localTime,
          daysOfWeek: reminderDraft.days,
          timeZone: profileTimeZone,
          status: reminderDraft.status,
        }
      : {
          label: reminderDraft.label.trim(),
          localTime: reminderDraft.localTime,
          daysOfWeek: reminderDraft.days,
          timeZone: profileTimeZone,
          channel: "local" as const,
          consentGranted: true as const,
        };
    const path = reminderDraft.reminder
      ? `/v1/reminders/${reminderDraft.reminder.id}`
      : "/v1/reminders";
    const key = `reminder:${reminderDraft.reminder?.id ?? "new"}:${reminderDraft.reminder?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("reminder");
    try {
      const saved = parseReminderResponse(
        await request(path, {
          method: reminderDraft.reminder ? "PATCH" : "POST",
          body,
          operationKey: key,
          ...(reminderDraft.reminder ? { revision: reminderDraft.reminder.revision } : {}),
        }),
      );
      const next = [saved, ...reminders.filter((item) => item.id !== saved.id)];
      await refreshReminderSchedules(next);
      setReminderDraft(initialReminder());
      setMessage("Reminder saved. Lock-screen copy contains no meal, goal, or health details.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reminder could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeReminder(reminder: Reminder) {
    const key = `reminder-revoke:${reminder.id}:${reminder.revision}`;
    setBusy(`reminder:${reminder.id}`);
    try {
      const saved = parseReminderResponse(
        await request(`/v1/reminders/${reminder.id}`, {
          method: "DELETE",
          operationKey: key,
          revision: reminder.revision,
        }),
      );
      await refreshReminderSchedules([saved, ...reminders.filter((item) => item.id !== saved.id)]);
      setMessage("Reminder consent revoked and local schedules removed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reminder could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  async function registerDevice(platform: HealthPlatform) {
    const signer = createHardwareDeviceSigner();
    const saved = await loadRegisteredHealthDevice();
    const evidence = await signer.ensureHardwareKey();
    if (saved) {
      if (
        saved.platform !== platform ||
        saved.publicKeyDerBase64 !== evidence.publicKey.derBase64
      ) {
        throw new Error(
          "The device signing key changed. Revoke and recover this device before importing.",
        );
      }
      return { signer, device: saved };
    }
    const challengeBody = { platform };
    const challenge = parseDeviceChallenge(
      await request("/v1/devices/challenges", {
        method: "POST",
        body: challengeBody,
        operationKey: `health-challenge:${platform}`,
      }),
    );
    const proof = await createRegistrationProof(signer, {
      challengeId: challenge.id,
      challenge: challenge.challenge,
      platform,
    });
    const body = {
      challengeId: challenge.id,
      challenge: challenge.challenge,
      platform,
      displayName:
        Platform.OS === "ios" ? "Nutrition Tracker iOS device" : "Nutrition Tracker Android device",
      publicKey: proof.publicKey,
      challengeSignature: proof.challengeSignature,
      attestation: null,
    };
    const registered = parseHealthDeviceResponse(
      await request("/v1/devices", {
        method: "POST",
        body,
        operationKey: `health-register:${challenge.id}:${JSON.stringify(body)}`,
      }),
    );
    try {
      await saveRegisteredHealthDevice({
        version: 2,
        id: registered.id,
        revision: registered.revision,
        platform,
        publicKeyDerBase64: proof.publicKey.derBase64,
      });
    } catch (error) {
      try {
        await request(`/v1/devices/${registered.id}`, {
          method: "DELETE",
          operationKey: `health-register-rollback:${registered.id}:${registered.revision}`,
          revision: registered.revision,
        });
      } finally {
        await signer.resetHardwareKey();
      }
      throw error;
    }
    return {
      signer,
      device: {
        version: 2 as const,
        id: registered.id,
        revision: registered.revision,
        platform,
        publicKeyDerBase64: proof.publicKey.derBase64,
      },
    };
  }

  async function connectAndSyncHealth() {
    const platform = platformForDevice();
    if (!platform) return setHealthState("Native health requires a signed iOS or Android build.");
    const adapter = createNativeHealthAdapter();
    setBusy("health");
    try {
      const availability = await adapter.availability();
      if (availability.status !== "available") {
        setHealthState(
          availability.status === "unavailable"
            ? `Native health is unavailable (${availability.reason}).`
            : "Native health availability could not be verified.",
        );
        return;
      }
      const permission = await adapter.requestWeightReadPermission();
      if (permission.status !== "ready") {
        setHealthState(
          permission.status === "denied"
            ? "Weight permission was denied. Import is paused."
            : "Weight permission is unavailable or could not be verified.",
        );
        return;
      }
      const { signer, device } = await registerDevice(platform);
      const existing = integrations.find((item) => item.platform === platform);
      const cursorStore = createSecureHealthSyncStore(platform);
      const protectedJournal = await cursorStore.load();
      const epoch = await establishHealthCursorEpoch({
        existing: existing ?? null,
        deviceId: device.id,
        localServerDigest: protectedJournal.cursor.serverDigest,
        pendingBatch: protectedJournal.pending?.envelope.body ?? null,
        consent: async () => {
          const body = {
            platform,
            dataTypeCodes: ["body_weight"] as const,
            consentGranted: true as const,
          };
          return parseIntegrationResponse(
            await request("/v1/integrations/health/consents", {
              method: "POST",
              body,
              operationKey: `health-consent:${platform}:${device.id}:${existing?.revision ?? "new"}`,
            }),
          );
        },
        rebind: async (integration, deviceId) => {
          const body = { deviceId };
          return parseIntegrationResponse(
            await request(`/v1/integrations/health/${platform}/rebind`, {
              method: "POST",
              body,
              operationKey: `health-rebind:${platform}:${integration.revision}:${deviceId}`,
              revision: integration.revision,
            }),
          );
        },
        resetLocalCursor: () => clearHealthCursor(platform),
      });
      setIntegrations((items) => [
        epoch.integration,
        ...items.filter((item) => item.platform !== platform),
      ]);
      const result = await syncNativeWeight({
        adapter,
        cursorStore,
        signer,
        deviceId: device.id,
        cursorEpoch: epoch.integration.cursorEpoch,
        recordedTimeZone: profileTimeZone,
        ids: { nextUuid: newOperationId, now: () => new Date() },
        transport: {
          send: async (envelope: SignedHealthImportEnvelope) => {
            let response: Response;
            try {
              response = await fetch(
                apiUrl(apiBase, "/v1/integrations/health/imports").toString(),
                {
                  method: "POST",
                  headers: authenticatedHeaders(accessToken, {
                    "content-type": "application/json",
                    "idempotency-key": envelope.body.batchId,
                    ...envelope.headers,
                  }),
                  body: JSON.stringify(envelope.body),
                },
              );
            } catch {
              throw new RetryableHealthImportTransportError();
            }
            if (response.status === 401) {
              await onUnauthorized();
              throw new Error("The signed import session ended.");
            }
            const body = await jsonBody(response);
            if (!response.ok)
              throw new Error(responseError(body, "The signed weight import failed."));
            return parseHealthImportResponse(body);
          },
        },
      });
      setHealthState(
        `Weight import submitted ${result.records} change${result.records === 1 ? "" : "s"} in ${result.batches} durable batch${result.batches === 1 ? "" : "es"}: ${result.accepted} upserted, ${result.deleted} deleted, and ${result.duplicates} already current. ${result.deletionSemantics === "explicit_only" ? "Provider deletions are applied only from explicit deletion records; unreadable history is never inferred as deleted." : "A verified complete provider snapshot was reconciled."}`,
      );
      const next = parseIntegrations(await request("/v1/integrations/health"));
      setIntegrations(next);
    } catch (error) {
      setHealthState(
        error instanceof Error ? error.message : "Native health synchronization failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function disconnectHealth(disposition: "retain" | "delete") {
    const platform = platformForDevice();
    const integration = integrations.find(
      (item) => item.platform === platform && item.status === "connected",
    );
    if (!platform || !integration)
      return setHealthState("No connected integration is active on this device.");
    setBusy("health");
    try {
      const body = { importedDataDisposition: disposition };
      const disconnected = parseIntegrationResponse(
        await request(`/v1/integrations/health/${platform}/disconnect`, {
          method: "POST",
          body,
          operationKey: `health-disconnect:${platform}:${integration.revision}:${disposition}`,
          revision: integration.revision,
        }),
      );
      const device = await loadRegisteredHealthDevice();
      if (device) {
        await request(`/v1/devices/${device.id}`, {
          method: "DELETE",
          operationKey: `device-revoke:${device.id}:${device.revision}`,
          revision: device.revision,
        });
      }
      if (disposition === "delete") await clearHealthCursor(platform);
      await clearRegisteredHealthDevice();
      await createHardwareDeviceSigner().resetHardwareKey();
      setIntegrations((items) => [
        disconnected,
        ...items.filter((item) => item.platform !== platform),
      ]);
      setHealthState(
        `Disconnected. Imported weight history was ${disposition === "delete" ? "deleted and the local cursor removed" : "retained with its exact protected cursor for safe reconnect"}.`,
      );
    } catch (error) {
      setHealthState(
        `${error instanceof Error ? error.message : "Disconnect failed."} Local key material was preserved so server revocation can be retried.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function recoverSigningKey() {
    const device = await loadRegisteredHealthDevice();
    if (!device) return setHealthState("No registered device key needs recovery.");
    setBusy("health");
    try {
      const integration = integrations.find(
        (item) => item.platform === device.platform && item.status === "connected",
      );
      if (integration) {
        const body = { importedDataDisposition: "retain" as const };
        const disconnected = parseIntegrationResponse(
          await request(`/v1/integrations/health/${device.platform}/disconnect`, {
            method: "POST",
            body,
            operationKey: `key-recovery-disconnect:${device.platform}:${integration.revision}`,
            revision: integration.revision,
          }),
        );
        setIntegrations((items) => [
          disconnected,
          ...items.filter((item) => item.platform !== device.platform),
        ]);
      }
      await request(`/v1/devices/${device.id}`, {
        method: "DELETE",
        operationKey: `device-key-recovery:${device.id}:${device.revision}`,
        revision: device.revision,
      });
      await clearRegisteredHealthDevice();
      await createHardwareDeviceSigner().resetHardwareKey();
      setHealthState(
        "The integration was disconnected with imports retained, then the old device was revoked. Connect again to bind a new hardware key and resume from the exact protected cursor.",
      );
    } catch (error) {
      setHealthState(
        `${error instanceof Error ? error.message : "Key recovery failed."} The local key was not reset because server revocation was not confirmed.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function reauthenticate(purpose: "account_export" | "account_erasure") {
    if (password.length < 12 || password.length > 128)
      throw new Error("Enter your current 12–128 character password.");
    return parseReauthentication(
      await request("/v1/auth/reauthenticate", {
        method: "POST",
        body: { password, purpose },
        operationKey: `reauth:${purpose}:${password}`,
      }),
    );
  }

  async function requestExport() {
    setBusy("export");
    try {
      const proof = await reauthenticate("account_export");
      const body = { formats: ["json", "csv"] as const };
      const job = parseExportResponse(
        await request("/v1/exports", {
          method: "POST",
          body,
          operationKey: `export:${JSON.stringify(body)}`,
          recentAuth: proof.reauthenticationToken,
        }),
      );
      setPassword("");
      setExportJob(job);
      setMessage("Complete JSON and CSV export requested. Refresh until reconciliation completes.");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Export failed."} Submit again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function refreshExport() {
    if (!exportJob) return;
    setBusy("export");
    try {
      setExportJob(parseExportResponse(await request(`/v1/exports/${exportJob.id}`)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export status could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  async function downloadArtifact(artifact: ExportArtifact) {
    const expected = Number(artifact.byteLength);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_EXPORT_BYTES) {
      return setMessage("The export artifact exceeds the reviewed mobile download bound.");
    }
    setBusy(`artifact:${artifact.format}`);
    try {
      const { File, Paths } = await import("expo-file-system");
      const temp = new File(Paths.cache, `${artifact.fileName}.${newOperationId()}.part`);
      const final = new File(Paths.document, artifact.fileName);
      const downloaded = await File.downloadFileAsync(
        apiUrl(apiBase, artifact.downloadPath).toString(),
        temp,
        { headers: { authorization: `Bearer ${accessToken}` }, idempotent: true },
      );
      const info = downloaded.info();
      if (!info.exists || info.size !== expected) {
        if (downloaded.exists) downloaded.delete();
        throw new Error("The downloaded export length did not match its authenticated manifest.");
      }
      await downloaded.move(final, { overwrite: true });
      setMessage(
        `Saved ${artifact.fileName} (${artifact.sha256.slice(0, 12)}… SHA-256) to app documents.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The export artifact could not be downloaded.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function requestErasure() {
    if (erasureConfirmation !== "DELETE_MY_ACCOUNT") {
      return setMessage(
        "Type DELETE_MY_ACCOUNT after reviewing all three irreversible consequences.",
      );
    }
    setBusy("erasure");
    try {
      const operationKey = `erasure:${ACCOUNT_ERASURE_SERIALIZED_BODY}`;
      const pendingStore = createPendingErasureStore();
      let pending = await pendingStore.load();
      if (!pending) {
        const proof = await reauthenticate("account_erasure");
        const operation = stableOperation(operationKey, ACCOUNT_ERASURE_SERIALIZED_BODY);
        pending = {
          version: 1,
          operationId: operation.id,
          serializedBody: ACCOUNT_ERASURE_SERIALIZED_BODY,
          reauthenticationToken: proof.reauthenticationToken,
          createdAt: new Date().toISOString(),
        };
        await pendingStore.save(pending);
      }
      onErasurePrepared();
      let response: Response;
      try {
        response = await fetch(apiUrl(apiBase, "/v1/account/erasure").toString(), {
          method: "POST",
          headers: authenticatedHeaders(accessToken, {
            "content-type": "application/json",
            "idempotency-key": pending.operationId,
            "x-reauthentication-token": pending.reauthenticationToken,
          }),
          body: pending.serializedBody,
        });
      } catch {
        throw new Error(
          "The erasure response was not received. The exact protected request will be replayed without asking for your password again.",
        );
      }
      const responseBody = await jsonBody(response);
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "The erasure response may have been lost after acceptance. Retry to replay the protected exact request."
            : responseError(responseBody, "The erasure request could not be completed."),
        );
      }
      const result = parseErasureResponse(responseBody);
      if (!result.statusCapability) throw new Error("The erasure status capability was missing.");
      await onErasureAccepted({
        job: result.job,
        token: result.statusCapability.token,
        expiresAt: result.statusCapability.expiresAt,
      });
      await pendingStore.clear();
      operations.current.delete(operationKey);
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Erasure request failed."} Submit again to replay the exact request.`,
      );
    } finally {
      setBusy(null);
    }
  }

  function editEvent(event: BiometricEvent) {
    const localTime = localTimeInTimeZone(new Date(event.measuredAt), event.timeZone).slice(0, 5);
    setEventDraft({
      event,
      definitionId: event.definitionId,
      value: event.value,
      localDate: event.localDate,
      localTime,
      originalLocalDate: event.localDate,
      originalLocalTime: localTime,
    });
  }

  function editReminder(reminder: Reminder) {
    setReminderDraft({
      reminder,
      label: reminder.label,
      localTime: reminder.localTime,
      days: reminder.daysOfWeek,
      status: reminder.status === "paused" ? "paused" : "active",
    });
  }

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.kicker}>RETENTION & PRIVATE HEALTH</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Health workspace
        </Text>
        <Text style={styles.intro}>
          All dates below follow {profileTimeZone}. Nutrition totals come from the server; this
          client performs no nutrition math.
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {message}
        </Text>
        {loading ? <ActivityIndicator color={palette.forest} /> : null}
        <Button label="Refresh private data" onPress={() => void loadAll()} secondary />

        <Section
          title="Trends"
          subtitle="Exact totals are labeled exact. Incomplete nutrition is shown as a lower bound, never as zero."
        >
          <LabeledInput
            label="From (YYYY-MM-DD)"
            value={from}
            onChangeText={setFrom}
            maxLength={10}
          />
          <LabeledInput label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} maxLength={10} />
          <Text style={styles.label}>Nutrient</Text>
          <ChipRow
            items={nutrients
              .slice(0, 24)
              .map((item) => ({ key: item.nutrientId, label: item.name }))}
            selected={selectedNutrient}
            onSelect={setSelectedNutrient}
          />
          <Text style={styles.label}>Biometric</Text>
          <ChipRow
            items={definitions.map((item) => ({
              key: item.id,
              label: `${item.name}${item.status === "archived" ? " (archived)" : ""}`,
            }))}
            selected={selectedDefinition}
            onSelect={setSelectedDefinition}
          />
          <Button
            disabled={busy === "trends"}
            label={busy === "trends" ? "Loading…" : "Load local-day trends"}
            onPress={() => void loadTrends()}
          />
          {nutrientTrend?.points.map((point) => (
            <Text key={point.localDate} style={styles.rowText}>
              {point.localDate}: {nutrientTrendLabel(point.aggregate)}
            </Text>
          ))}
          {biometricTrend?.points.map((point) => (
            <Text key={point.localDate} style={styles.rowText}>
              {point.localDate}: {point.last} {biometricTrend.definition.canonicalUnit} ·{" "}
              {point.count} reading{point.count === 1 ? "" : "s"}
            </Text>
          ))}
        </Section>

        <Section
          title="Private custom foods"
          subtitle="Owner-entered foods are private and every diary log pins an immutable version."
        >
          <LabeledInput
            label="Name"
            value={custom.name}
            onChangeText={(name) => setCustom({ ...custom, name })}
            maxLength={500}
          />
          <LabeledInput
            label="Brand (optional)"
            value={custom.brandName}
            onChangeText={(brandName) => setCustom({ ...custom, brandName })}
            maxLength={300}
          />
          <LabeledInput
            label="Serving label (optional)"
            value={custom.servingLabel}
            onChangeText={(servingLabel) => setCustom({ ...custom, servingLabel })}
            maxLength={200}
          />
          <LabeledInput
            label="Serving grams"
            value={custom.servingGrams}
            onChangeText={(servingGrams) => setCustom({ ...custom, servingGrams })}
            maxLength={19}
            keyboardType="decimal-pad"
          />
          <LabeledInput
            label="Canonical nutrients per 100 g"
            value={custom.nutrients}
            onChangeText={(nutrientsValue) => setCustom({ ...custom, nutrients: nutrientsValue })}
            multiline
            maxLength={12_000}
            placeholder="1=120\n2=trace\n3=unknown:not_reported"
          />
          <Text style={styles.help}>
            One row per nutrient ID. Use an exact amount, trace, or unknown:not_reported /
            not_analyzed / not_applicable / withheld.
          </Text>
          <LabeledInput
            label="Notes"
            value={custom.notes}
            onChangeText={(notes) => setCustom({ ...custom, notes })}
            multiline
            maxLength={2_000}
          />
          <View style={styles.actions}>
            <Button
              disabled={busy === "custom"}
              label={custom.id ? "Save new version" : "Create private food"}
              onPress={() => void saveCustomFood()}
            />
            {custom.id ? (
              <Button label="Cancel edit" onPress={() => setCustom(blankCustom())} secondary />
            ) : null}
          </View>
          {foods.map((food) => (
            <View key={food.id} style={styles.card}>
              <Text style={styles.cardTitle}>{food.currentVersion.name}</Text>
              <Text style={styles.meta}>
                Version {food.currentVersion.versionNumber} · {food.status} · owner-entered
              </Text>
              <View style={styles.actions}>
                <Button label="Revise" onPress={() => setCustom(customDraft(food))} secondary />
                <Button
                  label="Log exact version"
                  onPress={() =>
                    setCustomLog({
                      food,
                      quantity: "1",
                      kind: food.currentVersion.serving ? "serving" : "grams",
                      mealSlot: "breakfast",
                      localDate: today,
                      localTime: currentLocalTime(),
                    })
                  }
                  secondary
                />
                {food.status === "active" ? (
                  <Button
                    label="Archive"
                    onPress={() =>
                      Alert.alert(
                        "Archive private food?",
                        "Historical diary entries retain their pinned version.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Archive",
                            style: "destructive",
                            onPress: () => void archiveCustomFood(food),
                          },
                        ],
                      )
                    }
                    danger
                  />
                ) : null}
              </View>
            </View>
          ))}
          {customLog ? (
            <View style={styles.editor}>
              <Text style={styles.cardTitle}>
                Log {customLog.food.currentVersion.name} v
                {customLog.food.currentVersion.versionNumber}
              </Text>
              <ChipRow
                items={[
                  { key: "grams", label: "Grams" },
                  ...(customLog.food.currentVersion.serving
                    ? [{ key: "serving", label: "Serving" }]
                    : []),
                ]}
                selected={customLog.kind}
                onSelect={(kind) =>
                  setCustomLog({ ...customLog, kind: kind as "grams" | "serving" })
                }
              />
              <LabeledInput
                label="Quantity"
                value={customLog.quantity}
                onChangeText={(quantity) => setCustomLog({ ...customLog, quantity })}
                keyboardType="decimal-pad"
                maxLength={19}
              />
              <ChipRow
                items={mealSlots.map((meal) => ({ key: meal, label: mealLabel(meal) }))}
                selected={customLog.mealSlot}
                onSelect={(mealSlot) =>
                  setCustomLog({ ...customLog, mealSlot: mealSlot as MealSlot })
                }
              />
              <LabeledInput
                label="Local date"
                value={customLog.localDate}
                onChangeText={(localDate) => setCustomLog({ ...customLog, localDate })}
                maxLength={10}
              />
              <LabeledInput
                label="Local time"
                value={customLog.localTime}
                onChangeText={(localTime) => setCustomLog({ ...customLog, localTime })}
                maxLength={5}
              />
              <View style={styles.actions}>
                <Button label="Log pinned version" onPress={() => void logCustomFood()} />
                <Button label="Cancel" onPress={() => setCustomLog(null)} secondary />
              </View>
            </View>
          ) : null}
          {foodCursor ? (
            <Button
              disabled={busy === "food-more"}
              label="Load more custom foods"
              onPress={() => void loadMoreFoods()}
              secondary
            />
          ) : null}
        </Section>

        <Section
          title="Biometrics"
          subtitle="Create custom metric definitions, keep exact decimals, and preserve timestamps unless you explicitly change them."
        >
          <LabeledInput
            label="Metric name"
            value={definitionName}
            onChangeText={setDefinitionName}
            maxLength={120}
          />
          {!editingDefinition ? (
            <>
              <Text style={styles.label}>Dimension</Text>
              <ChipRow
                items={["mass", "length", "temperature", "duration", "count", "other"].map(
                  (key) => ({ key, label: key }),
                )}
                selected={definitionDimension}
                onSelect={(dimension) =>
                  setDefinitionDimension(dimension as BiometricDefinition["dimension"])
                }
              />
              <LabeledInput
                label="Canonical unit"
                value={definitionUnit}
                onChangeText={setDefinitionUnit}
                maxLength={32}
              />
            </>
          ) : (
            <Text style={styles.help}>
              Dimension and canonical unit remain {editingDefinition.dimension} /{" "}
              {editingDefinition.canonicalUnit} for historical consistency.
            </Text>
          )}
          <LabeledInput
            label="Definition notes"
            value={definitionNotes}
            onChangeText={setDefinitionNotes}
            multiline
            maxLength={1_000}
          />
          <View style={styles.actions}>
            <Button
              label={editingDefinition ? "Save definition revision" : "Create definition"}
              onPress={() => void saveDefinition()}
            />
            {editingDefinition ? (
              <Button
                label="Cancel"
                onPress={() => {
                  setEditingDefinition(null);
                  setDefinitionName("Weight");
                  setDefinitionUnit("kg");
                  setDefinitionDimension("mass");
                  setDefinitionNotes("");
                }}
                secondary
              />
            ) : null}
          </View>
          {definitions.map((definition) => (
            <View key={definition.id} style={styles.card}>
              <Text style={styles.cardTitle}>{definition.name}</Text>
              <Text style={styles.meta}>
                {definition.dimension} · {definition.canonicalUnit} · {definition.status}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="Use"
                  onPress={() => {
                    setSelectedDefinition(definition.id);
                    setEventDraft({ ...eventDraft, definitionId: definition.id });
                  }}
                  secondary
                />
                <Button
                  label="Revise"
                  onPress={() => {
                    setEditingDefinition(definition);
                    setDefinitionName(definition.name);
                    setDefinitionDimension(definition.dimension);
                    setDefinitionUnit(definition.canonicalUnit);
                    setDefinitionNotes(definition.notes ?? "");
                  }}
                  secondary
                />
                {definition.status === "active" ? (
                  <Button
                    label="Archive"
                    onPress={() => void archiveDefinition(definition)}
                    danger
                  />
                ) : null}
              </View>
            </View>
          ))}
          <Text accessibilityRole="header" style={styles.subheading}>
            {eventDraft.event ? "Edit reading" : "Log reading"}
          </Text>
          <ChipRow
            items={definitions
              .filter((item) => item.status === "active" || item.id === eventDraft.definitionId)
              .map((item) => ({ key: item.id, label: item.name }))}
            selected={eventDraft.definitionId}
            onSelect={(definitionId) => setEventDraft({ ...eventDraft, definitionId })}
          />
          <LabeledInput
            label="Exact value"
            value={eventDraft.value}
            onChangeText={(value) => setEventDraft({ ...eventDraft, value })}
            maxLength={160}
            keyboardType="numbers-and-punctuation"
          />
          <LabeledInput
            label="Local date"
            value={eventDraft.localDate}
            onChangeText={(localDate) => setEventDraft({ ...eventDraft, localDate })}
            maxLength={10}
          />
          <LabeledInput
            label="Local time"
            value={eventDraft.localTime}
            onChangeText={(localTime) => setEventDraft({ ...eventDraft, localTime })}
            maxLength={5}
          />
          <View style={styles.actions}>
            <Button
              label={eventDraft.event ? "Save reading" : "Log reading"}
              onPress={() => void saveEvent()}
            />
            {eventDraft.event ? (
              <Button
                label="Cancel"
                onPress={() =>
                  setEventDraft((value) => ({
                    ...initialEvent(profileTimeZone),
                    definitionId: value.definitionId,
                  }))
                }
                secondary
              />
            ) : null}
          </View>
          {events.map((event) => (
            <View key={event.id} style={styles.card}>
              <Text style={styles.cardTitle}>
                {definitions.find((item) => item.id === event.definitionId)?.name ??
                  "Historical metric"}
                : {event.value}
              </Text>
              <Text style={styles.meta}>
                {event.localDate} ·{" "}
                {localTimeInTimeZone(new Date(event.measuredAt), event.timeZone).slice(0, 5)} ·{" "}
                {event.source.kind}
              </Text>
              <View style={styles.actions}>
                {event.source.kind === "manual" ? (
                  <>
                    <Button label="Edit" onPress={() => editEvent(event)} secondary />
                    <Button label="Delete" onPress={() => void deleteEvent(event)} danger />
                  </>
                ) : null}
              </View>
            </View>
          ))}
          {eventCursor ? (
            <Button
              disabled={busy === "event-more"}
              label="Load more readings"
              onPress={() => void loadMoreEvents()}
              secondary
            />
          ) : null}
        </Section>

        <Section
          title="Private local reminders"
          subtitle="The OS receives only “Nutrition Tracker” and “Time to check in.” Labels stay inside the authenticated app."
        >
          <LabeledInput
            label="Private in-app label"
            value={reminderDraft.label}
            onChangeText={(label) => setReminderDraft({ ...reminderDraft, label })}
            maxLength={120}
          />
          <LabeledInput
            label={`Local time in ${profileTimeZone}`}
            value={reminderDraft.localTime}
            onChangeText={(localTime) => setReminderDraft({ ...reminderDraft, localTime })}
            maxLength={5}
          />
          <ChipRow
            multiple
            items={dayNames.map((label, index) => ({ key: String(index + 1), label }))}
            selected={reminderDraft.days.map(String)}
            onSelect={(key) => {
              const day = Number(key);
              const days = reminderDraft.days.includes(day)
                ? reminderDraft.days.filter((item) => item !== day)
                : [...reminderDraft.days, day].sort();
              setReminderDraft({ ...reminderDraft, days });
            }}
          />
          {reminderDraft.reminder ? (
            <ChipRow
              items={[
                { key: "active", label: "Active" },
                { key: "paused", label: "Paused" },
              ]}
              selected={reminderDraft.status}
              onSelect={(status) =>
                setReminderDraft({ ...reminderDraft, status: status as "active" | "paused" })
              }
            />
          ) : (
            <Text style={styles.help}>
              Creating a reminder asks for notification permission in context. Consent is recorded
              only after permission is granted.
            </Text>
          )}
          <View style={styles.actions}>
            <Button
              label={reminderDraft.reminder ? "Save reminder" : "Grant access and create"}
              onPress={() => void saveReminder()}
            />
            {reminderDraft.reminder ? (
              <Button
                label="Cancel"
                onPress={() => setReminderDraft(initialReminder())}
                secondary
              />
            ) : null}
          </View>
          {reminders.map((reminder) => (
            <View key={reminder.id} style={styles.card}>
              <Text style={styles.cardTitle}>{reminder.label}</Text>
              <Text style={styles.meta}>
                {reminder.localTime} · {reminder.status} · {reminder.timeZone}
              </Text>
              <View style={styles.actions}>
                {reminder.status !== "revoked" ? (
                  <>
                    <Button label="Edit / pause" onPress={() => editReminder(reminder)} secondary />
                    <Button label="Revoke" onPress={() => void revokeReminder(reminder)} danger />
                  </>
                ) : null}
              </View>
            </View>
          ))}
        </Section>

        <Section
          title="Connected health platform"
          subtitle="This milestone reads body weight only. Permission is requested in context; health values and identifiers are never written to logs."
        >
          {integrations.map((item) => (
            <Text key={item.platform} style={styles.rowText}>
              {item.platform}: {item.status} · scope {item.dataTypeCodes.join(", ")} ·{" "}
              {item.lastImportAt ? `last import ${item.lastImportAt}` : "no import yet"}
            </Text>
          ))}
          <Text accessibilityLiveRegion="polite" style={styles.help}>
            {healthState}
          </Text>
          <View style={styles.actions}>
            <Button
              disabled={busy === "health"}
              label="Connect and import weight"
              onPress={() => void connectAndSyncHealth()}
            />
            <Button
              label="Manage OS access"
              onPress={() => void createNativeHealthAdapter().openPermissionSettings()}
              secondary
            />
            <Button
              label="Recover invalidated key"
              onPress={() => void recoverSigningKey()}
              secondary
            />
            <Button
              label="Disconnect; retain imports"
              onPress={() => void disconnectHealth("retain")}
              secondary
            />
            <Button
              label="Disconnect; delete imports"
              onPress={() =>
                Alert.alert(
                  "Delete imported weight history?",
                  "This disconnects the platform and removes imported records. Manual records remain.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Disconnect and delete",
                      style: "destructive",
                      onPress: () => void disconnectHealth("delete"),
                    },
                  ],
                )
              }
              danger
            />
          </View>
        </Section>

        <Section
          title="Privacy Center"
          subtitle="Review scopes, export all account data, or permanently erase the account after recent authentication."
        >
          <LabeledInput
            label="Current password for export or erasure"
            value={password}
            onChangeText={setPassword}
            maxLength={128}
            secureTextEntry
          />
          <View style={styles.actions}>
            <Button
              disabled={busy === "export"}
              label="Request complete JSON + CSV export"
              onPress={() => void requestExport()}
            />
            {exportJob ? (
              <Button
                label="Refresh export status"
                onPress={() => void refreshExport()}
                secondary
              />
            ) : null}
          </View>
          {exportJob ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Export {exportJob.status}</Text>
              <Text style={styles.meta}>
                Requested {exportJob.formats.join(" + ")} ·{" "}
                {exportJob.reconciliation?.reconciled
                  ? "entity counts reconciled"
                  : "reconciliation pending"}
              </Text>
              {exportJob.artifacts.map((artifact) => (
                <Button
                  key={artifact.format}
                  label={`Download ${artifact.format.toUpperCase()} (${artifact.byteLength} bytes)`}
                  onPress={() => void downloadArtifact(artifact)}
                  secondary
                />
              ))}
            </View>
          ) : null}
          <Text style={styles.warning}>
            Account erasure revokes account access, permanently deletes private health data, and
            revokes export links. Status remains available through a separate short-lived
            device-bound capability after the session is cleared.
          </Text>
          <LabeledInput
            label="Type DELETE_MY_ACCOUNT"
            value={erasureConfirmation}
            onChangeText={setErasureConfirmation}
            autoCapitalize="characters"
            maxLength={17}
          />
          <Button
            disabled={busy === "erasure"}
            label="Request permanent account erasure"
            onPress={() =>
              Alert.alert(
                "Permanently erase account?",
                "Account access, private health data, and export links will be removed. This cannot be undone.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Request erasure",
                    style: "destructive",
                    onPress: () => void requestErasure(),
                  },
                ],
              )
            }
            danger
          />
        </Section>

        <Button
          label="Cancel every local reminder on this device"
          onPress={() =>
            void clearAllLocalReminderSchedules(
              createExpoNotificationAdapter(),
              createSecureReminderScheduleStore(),
            ).then(
              () => setMessage("All app-owned local reminders were cancelled."),
              (error) =>
                setMessage(
                  error instanceof Error ? error.message : "Local reminders could not be cleared.",
                ),
            )
          }
          danger
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      <Text style={styles.intro}>{subtitle}</Text>
      {children}
    </View>
  );
}

function LabeledInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly secureTextEntry?: boolean;
  readonly autoCapitalize?: "none" | "sentences" | "words" | "characters";
  readonly keyboardType?: "default" | "decimal-pad" | "numbers-and-punctuation";
}) {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        autoCapitalize={props.autoCapitalize ?? "none"}
        keyboardType={props.keyboardType ?? "default"}
        maxLength={props.maxLength}
        multiline={props.multiline}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        secureTextEntry={props.secureTextEntry}
        style={[styles.input, props.multiline && styles.multiline]}
        value={props.value}
      />
    </View>
  );
}

function ChipRow(props: {
  readonly items: readonly { readonly key: string; readonly label: string }[];
  readonly selected: string | readonly string[];
  readonly onSelect: (key: string) => void;
  readonly multiple?: boolean;
}) {
  const selected = Array.isArray(props.selected) ? props.selected : [props.selected];
  return (
    <View accessibilityRole={props.multiple ? undefined : "radiogroup"} style={styles.chips}>
      {props.items.map((item) => {
        const active = selected.includes(item.key);
        return (
          <Pressable
            accessibilityRole={props.multiple ? "checkbox" : "radio"}
            accessibilityState={props.multiple ? { checked: active } : { selected: active }}
            key={item.key}
            onPress={() => props.onSelect(item.key)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  secondary,
  danger,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          secondary && styles.buttonSecondaryText,
          danger && styles.buttonDangerText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  button: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonDanger: { backgroundColor: "transparent", borderColor: "#9b443d" },
  buttonDangerText: { color: "#8a3128" },
  buttonSecondary: { backgroundColor: "transparent", borderColor: palette.line },
  buttonSecondaryText: { color: palette.forest },
  buttonText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  card: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  cardTitle: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  chip: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: palette.forest, borderColor: palette.forest },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: palette.white },
  content: { padding: 22, paddingBottom: 80 },
  disabled: { opacity: 0.5 },
  editor: {
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  heading: { color: palette.ink, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  help: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
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
  intro: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  label: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 5,
    marginTop: 13,
    textTransform: "uppercase",
  },
  meta: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  multiline: { minHeight: 100, paddingTop: 12, textAlignVertical: "top" },
  rowText: { color: palette.ink, fontSize: 13, lineHeight: 20, marginTop: 7 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  section: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 34, paddingTop: 28 },
  status: { color: palette.forest, fontSize: 13, lineHeight: 19, marginVertical: 18 },
  subheading: { color: palette.ink, fontSize: 20, fontWeight: "700", marginTop: 24 },
  title: { color: palette.ink, fontSize: 35, fontWeight: "700", letterSpacing: -1, marginTop: 6 },
  warning: {
    backgroundColor: "#f7e6b0",
    borderRadius: 10,
    color: "#6b4c00",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 22,
    padding: 14,
  },
});
