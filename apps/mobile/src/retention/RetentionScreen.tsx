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
  type LayoutChangeEvent,
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
  type DiaryGroup,
  diaryGroupLabel,
  isLocalDate,
  isPositiveDecimal,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  shiftLocalDate,
} from "../diary/diary";
import {
  MAX_QUICK_ADD_OUTBOX_ITEMS,
  QuickAddEnqueueAmbiguousError,
  type QuickAddOutboxController,
  type QuickAddOutboxControllerState,
  type QuickAddReceipt,
} from "../diary/quick-add-outbox";
import { parseTargetableNutrients, type TargetableNutrient } from "../recipes/recipes-goals";
import { palette } from "../theme";
import { appendCanonicalNutrientInput, parseCanonicalNutrientInput } from "./custom-food-nutrients";

export { parseCanonicalNutrientInput } from "./custom-food-nutrients";

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
  readonly ownerUserId: string;
  readonly sessionEpoch: number;
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly diaryGroups: readonly DiaryGroup[];
  readonly onUnauthorized: () => Promise<void>;
  /** Fence queued diary delivery after the erasure request is durable and before it is sent. */
  readonly onErasurePrepared: () => void;
  readonly quickAddOutboxController: QuickAddOutboxController;
  readonly quickAddOutboxState: QuickAddOutboxControllerState;
  readonly subscribeQuickAddReceipts: (listener: (receipt: QuickAddReceipt) => void) => () => void;
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

interface NutrientComposer {
  readonly query: string;
  readonly nutrientId: string;
  readonly state: "quantified" | "trace" | "unknown";
  readonly amount: string;
  readonly reason: "" | "not_reported" | "not_analyzed" | "not_applicable" | "withheld";
}
interface CustomCopyChoice {
  readonly food: CustomFood;
  readonly draft: CustomDraft;
  readonly composer: NutrientComposer;
  readonly profileScope: object;
  readonly epoch: number;
}

function blankComposer(): NutrientComposer {
  return { query: "", nutrientId: "", state: "quantified", amount: "", reason: "" };
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

function initialCustomLog(
  food: CustomFood,
  profileTimeZone: string,
  now = new Date(),
): CustomLogDraft {
  return {
    food,
    quantity: "1",
    kind: food.currentVersion.serving ? "serving" : "grams",
    mealSlot: "breakfast",
    localDate: new Intl.DateTimeFormat("en-CA", { timeZone: profileTimeZone }).format(now),
    localTime: localTimeInTimeZone(now, profileTimeZone).slice(0, 5),
  };
}

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const EXACT_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
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
  ownerUserId,
  sessionEpoch,
  apiBase,
  accessToken,
  profileTimeZone,
  diaryGroups,
  onUnauthorized,
  onErasurePrepared,
  onErasureAccepted,
  quickAddOutboxController,
  quickAddOutboxState,
  subscribeQuickAddReceipts,
}: Props) {
  const today = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: profileTimeZone }).format(new Date()),
    [profileTimeZone],
  );
  const [loading, setLoadingState] = useState(AppState.currentState === "active");
  const loadingRef = useRef(loading);
  const setLoading = useCallback((value: boolean) => {
    loadingRef.current = value;
    setLoadingState(value);
  }, []);
  const [busy, setBusyState] = useState<string | null>(null);
  const busyRef = useRef(busy);
  const setBusy = useCallback((value: string | null) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const trendController = useRef<AbortController | null>(null);
  const [trendPending, setTrendPending] = useState(false);
  const abortTrendRead = useCallback(() => {
    const controller = trendController.current;
    if (!controller) return;
    trendController.current = null;
    controller.abort();
    setTrendPending(false);
    if (busyRef.current === "trends") setBusy(null);
  }, [setBusy]);
  const [message, setMessage] = useState("Opening private health data…");
  const [nutrients, setNutrients] = useState<readonly TargetableNutrient[]>([]);
  const [foodDetails, setFoodDetailsState] = useState<ReadonlySet<CustomFood>>(() => new Set());
  const foodDetailsRef = useRef(foodDetails);
  const foodDetailsReady = useRef(false);
  const setFoodDetails = useCallback((next: ReadonlySet<CustomFood>) => {
    foodDetailsRef.current = next;
    setFoodDetailsState(next);
  }, []);
  const resetFoodDetails = useCallback(() => setFoodDetails(new Set()), [setFoodDetails]);
  const [foods, setFoodsState] = useState<readonly CustomFood[]>([]);
  const foodsRef = useRef(foods);
  const setFoods = useCallback(
    (value: readonly CustomFood[] | ((items: readonly CustomFood[]) => readonly CustomFood[])) => {
      const next = typeof value === "function" ? value(foodsRef.current) : value;
      foodsRef.current = next;
      setFoodDetails(new Set([...foodDetailsRef.current].filter((food) => next.includes(food))));
      setFoodsState(next);
    },
    [setFoodDetails],
  );
  const [foodCursor, setFoodCursor] = useState<string | null>(null);
  const [savedFoodFilter, setSavedFoodFilter] = useState({ value: "" });
  const savedFoodFilterRef = useRef(savedFoodFilter);
  const resetSavedFoodFilter = useCallback(() => {
    const next = { value: "" };
    savedFoodFilterRef.current = next;
    setSavedFoodFilter(next);
  }, []);
  const [definitions, setDefinitionsState] = useState<readonly BiometricDefinition[]>([]);
  const definitionsRef = useRef(definitions);
  const setDefinitions = useCallback((items: readonly BiometricDefinition[]) => {
    definitionsRef.current = items;
    setDefinitionsState(items);
  }, []);
  const [events, setEvents] = useState<readonly BiometricEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventRange, setEventRange] = useState<{
    readonly from: string;
    readonly to: string;
  } | null>(null);
  const [reminders, setReminders] = useState<readonly Reminder[]>([]);
  const [integrations, setIntegrations] = useState<readonly PlatformIntegration[]>([]);
  const [custom, setCustomState] = useState<CustomDraft>(blankCustom);
  const customRef = useRef(custom);
  const customBaseline = useRef<CustomDraft>(blankCustom());
  const customCreationIntent = useRef(0);
  const [customCopyChoice, setCustomCopyChoice] = useState<CustomCopyChoice | null>(null);
  const customCopyChoiceRef = useRef(customCopyChoice);
  const [customCopyStatus, setCustomCopyStatus] = useState("");
  const clearCustomCopyChoice = useCallback(() => {
    customCopyChoiceRef.current = null;
    setCustomCopyChoice(null);
  }, []);
  const workspaceScroll = useRef<ScrollView | null>(null);
  const customEditorOffset = useRef(0);
  const [composer, setComposerState] = useState<NutrientComposer>(blankComposer);
  const composerRef = useRef(composer);
  const [composerStatus, setComposerStatus] = useState("");
  const customScopeRef = useRef({ ownerUserId, sessionEpoch, accessToken, base: apiBase.href });
  if (
    customScopeRef.current.ownerUserId !== ownerUserId ||
    customScopeRef.current.sessionEpoch !== sessionEpoch ||
    customScopeRef.current.accessToken !== accessToken ||
    customScopeRef.current.base !== apiBase.href
  )
    customScopeRef.current = { ownerUserId, sessionEpoch, accessToken, base: apiBase.href };
  const customScope = customScopeRef.current;
  const [verifiedFoodListScope, setVerifiedFoodListScope] = useState<typeof customScope | null>(
    null,
  );
  const foodFilterProfileKey = JSON.stringify([profileTimeZone, diaryGroups]);
  const foodFilterScopeRef = useRef({
    privateScope: customScope,
    profileKey: foodFilterProfileKey,
  });
  if (
    foodFilterScopeRef.current.privateScope !== customScope ||
    foodFilterScopeRef.current.profileKey !== foodFilterProfileKey
  )
    foodFilterScopeRef.current = { privateScope: customScope, profileKey: foodFilterProfileKey };
  const foodFilterScope = foodFilterScopeRef.current;
  const installedFoodFilterScope = useRef<typeof foodFilterScope | null>(null);
  useEffect(() => {
    if (installedFoodFilterScope.current !== foodFilterScope) {
      installedFoodFilterScope.current = foodFilterScope;
      resetSavedFoodFilter();
      clearCustomCopyChoice();
    }
  }, [clearCustomCopyChoice, foodFilterScope, resetSavedFoodFilter]);
  const customInstalled = useRef<typeof customScope | null>(null);
  const customClosed = useRef<typeof customScope | null>(null);
  const customMounted = useRef(false);
  const customActive = useRef(AppState.currentState === "active");
  const customEpoch = useRef(0);
  const [, setCustomEpoch] = useState(0);
  const registry = useRef<{
    scope: typeof customScope;
    values: readonly TargetableNutrient[];
  } | null>(null);
  const customFoodsScope = useRef<typeof customScope | null>(null);
  const customOperations = useRef(new Map<string, StableOperation>());
  const customWrite = useRef<AbortController | null>(null);
  const customPageRequest = useRef<AbortController | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const installCustom = useCallback(
    (value: CustomDraft, resetComposer = false) => {
      clearCustomCopyChoice();
      customRef.current = value;
      setCustomState(value);
      if (resetComposer) {
        customBaseline.current = value.id === null ? blankCustom() : value;
        setCustomCopyStatus("");
        const next = blankComposer();
        composerRef.current = next;
        setComposerState(next);
        setComposerStatus("");
      }
    },
    [clearCustomCopyChoice],
  );
  const currentCustomScope = useCallback(
    (epoch: number) =>
      customMounted.current &&
      customActive.current &&
      customScopeRef.current === customScope &&
      customInstalled.current === customScope &&
      customClosed.current !== customScope &&
      customEpoch.current === epoch &&
      ownerUserId.length > 0 &&
      accessToken.length > 0 &&
      Number.isSafeInteger(sessionEpoch) &&
      sessionEpoch >= 0,
    [accessToken, customScope, ownerUserId, sessionEpoch],
  );
  const closeCustom = useCallback(() => {
    if (!currentCustomScope(customEpoch.current)) return;
    customClosed.current = customScope;
    resetSavedFoodFilter();
    setVerifiedFoodListScope(null);
    abortTrendRead();
    foodDetailsReady.current = false;
    resetFoodDetails();
    customEpoch.current += 1;
    registry.current = null;
    customFoodsScope.current = null;
    customWrite.current?.abort();
    customWrite.current = null;
    customPageRequest.current?.abort();
    customPageRequest.current = null;
    customOperations.current.clear();
    installCustom(blankCustom(), true);
    if (busyRef.current === "custom" || busyRef.current === "food-more") setBusy(null);
  }, [
    abortTrendRead,
    currentCustomScope,
    customScope,
    installCustom,
    resetFoodDetails,
    resetSavedFoodFilter,
    setBusy,
  ]);
  useEffect(() => {
    customMounted.current = true;
    clearCustomCopyChoice();
    resetFoodDetails();
    customEpoch.current += 1;
    if (customInstalled.current !== customScope) {
      customInstalled.current = customScope;
      setVerifiedFoodListScope(null);
      foodDetailsReady.current = false;
      registry.current = null;
      customFoodsScope.current = null;
      setFoods([]);
      setFoodCursor(null);
      customOperations.current.clear();
      installCustom(blankCustom(), true);
    }
    if (
      (busyRef.current === "custom" && !customWrite.current) ||
      (busyRef.current === "food-more" && !customPageRequest.current)
    )
      setBusy(null);
    return () => {
      customMounted.current = false;
      customCopyChoiceRef.current = null;
      foodDetailsRef.current = new Set();
      customEpoch.current += 1;
      customWrite.current?.abort();
      customWrite.current = null;
      customPageRequest.current?.abort();
      customPageRequest.current = null;
    };
  }, [clearCustomCopyChoice, customScope, installCustom, resetFoodDetails, setBusy, setFoods]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      if (
        !customMounted.current ||
        customScopeRef.current !== customScope ||
        customActive.current === active
      )
        return;
      customActive.current = active;
      clearCustomCopyChoice();
      resetFoodDetails();
      customEpoch.current += 1;
      customWrite.current?.abort();
      customWrite.current = null;
      customPageRequest.current?.abort();
      customPageRequest.current = null;
      if (busyRef.current === "custom" || busyRef.current === "food-more") setBusy(null);
      setCustomEpoch(customEpoch.current);
    });
    return () => subscription.remove();
  }, [clearCustomCopyChoice, customScope, resetFoodDetails, setBusy]);
  const [customLog, setCustomLog] = useState<CustomLogDraft | null>(null);
  const [definitionName, setDefinitionName] = useState("Weight");
  const [definitionDimension, setDefinitionDimension] =
    useState<BiometricDefinition["dimension"]>("mass");
  const [definitionUnit, setDefinitionUnit] = useState("kg");
  const [definitionNotes, setDefinitionNotes] = useState("");
  const [editingDefinition, setEditingDefinition] = useState<BiometricDefinition | null>(null);
  const [eventDraft, setEventDraft] = useState(() => initialEvent(profileTimeZone));
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft>(initialReminder);
  const [trendInputs, setTrendInputsState] = useState(() => ({
    from: shiftLocalDate(today, -13),
    to: today,
    nutrientId: "",
    definitionId: "",
  }));
  const trendInputsRef = useRef(trendInputs);
  const installTrendInputs = useCallback((value: typeof trendInputs) => {
    trendInputsRef.current = value;
    setTrendInputsState(value);
  }, []);
  const { from, to, nutrientId: selectedNutrient, definitionId: selectedDefinition } = trendInputs;
  const [trendFilter, setTrendFilterState] = useState({ value: "" });
  const trendFilterRef = useRef(trendFilter);
  const installTrendFilter = useCallback((value: string) => {
    const next = { value };
    trendFilterRef.current = next;
    setTrendFilterState(next);
  }, []);
  const trendScopeRef = useRef({ privateScope: customScope, profileTimeZone });
  if (
    trendScopeRef.current.privateScope !== customScope ||
    trendScopeRef.current.profileTimeZone !== profileTimeZone
  )
    trendScopeRef.current = { privateScope: customScope, profileTimeZone };
  const trendScope = trendScopeRef.current;
  const trendInstalled = useRef<typeof trendScope | null>(null);
  const trendChoicesInstalled = useRef<typeof customScope | null>(null);
  const trendDefinitions = useRef<readonly BiometricDefinition[] | null>(null);
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
  const customLoadReceipts = useRef<{
    readonly controller: AbortController;
    readonly scope: typeof customScope;
    readonly foods: readonly CustomFood[];
  } | null>(null);
  useEffect(() => {
    const replacedOwner = trendChoicesInstalled.current !== customScope;
    trendInstalled.current = trendScope;
    abortTrendRead();
    setTrendPending(false);
    if (busyRef.current === "trends") setBusy(null);
    installTrendFilter("");
    installTrendInputs({
      ...trendInputsRef.current,
      ...(replacedOwner ? { nutrientId: "", definitionId: "" } : {}),
    });
    setNutrientTrend(null);
    setBiometricTrend(null);
    let active = AppState.currentState === "active";
    const subscription = AppState.addEventListener("change", (next) => {
      if (
        !customMounted.current ||
        trendScopeRef.current !== trendScope ||
        active === (next === "active")
      )
        return;
      active = next === "active";
      abortTrendRead();
      installTrendFilter("");
      installTrendInputs({ ...trendInputsRef.current });
      setNutrientTrend(null);
      setBiometricTrend(null);
    });
    return () => {
      subscription.remove();
      const controller = trendController.current;
      trendController.current = null;
      controller?.abort();
      trendInstalled.current = null;
    };
  }, [abortTrendRead, customScope, installTrendFilter, installTrendInputs, setBusy, trendScope]);
  const customLogEnqueueInFlight = useRef(false);
  const ownedCustomLogOperations = useRef(new Set<string>());

  useEffect(
    () =>
      subscribeQuickAddReceipts((receipt) => {
        if (!ownedCustomLogOperations.current.delete(receipt.operationId)) return;
        const entry = receipt.mutation.entry;
        if (entry?.entryKind !== "food" || entry.foodProvenance.kind !== "private_custom") {
          setMessage(
            "The queued custom food was accepted, but its diary entry could not be read. Refresh the diary before logging it again.",
          );
          return;
        }
        setMessage(
          receipt.mutation.replayed
            ? `The earlier queued custom-food log in ${diaryGroupLabel(diaryGroups, entry.mealSlot)} on ${entry.localDate} was confirmed safely.`
            : `The queued custom food was confirmed in ${diaryGroupLabel(diaryGroups, entry.mealSlot)} on ${entry.localDate}.`,
        );
      }),
    [diaryGroups, subscribeQuickAddReceipts],
  );

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
    const epoch = customEpoch.current;
    if (!currentCustomScope(epoch)) return;
    clearCustomCopyChoice();
    setVerifiedFoodListScope(null);
    abortTrendRead();
    setNutrientTrend(null);
    setBiometricTrend(null);
    foodDetailsReady.current = false;
    resetFoodDetails();
    registry.current = null;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    customLoadReceipts.current = { controller, scope: customScope, foods: [] };
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
      if (controller.signal.aborted) return;
      if (responses.some((response) => response.status === 401)) {
        if (currentCustomScope(epoch)) {
          closeCustom();
          await unauthorizedRef.current();
        }
        return;
      }
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
      if (currentCustomScope(epoch))
        registry.current = { scope: customScope, values: nextNutrients };
      if (currentCustomScope(epoch)) {
        const accepted = customLoadReceipts.current;
        const retained =
          accepted?.controller === controller && accepted.scope === customScope
            ? accepted.foods
            : [];
        setFoods([
          ...retained.map((saved) => {
            const listed = foodPage.items.find((item) => item.id === saved.id);
            return listed && BigInt(listed.revision) > BigInt(saved.revision) ? listed : saved;
          }),
          ...foodPage.items.filter((item) => !retained.some((saved) => saved.id === item.id)),
        ]);
        customFoodsScope.current = customScope;
        setVerifiedFoodListScope(customScope);
        foodDetailsReady.current = true;
        setFoodCursor(foodPage.nextCursor);
      }
      setDefinitions(nextDefinitions);
      setEvents(eventPage.items);
      setEventCursor(eventPage.nextCursor);
      setEventRange({ from: rangeFrom, to: rangeTo });
      setReminders(nextReminders);
      setIntegrations(parseIntegrations(values[5]));
      if (currentCustomScope(epoch)) {
        trendDefinitions.current = nextDefinitions;
        const firstInstall = trendChoicesInstalled.current !== customScope;
        trendChoicesInstalled.current = customScope;
        const previous = trendInputsRef.current;
        installTrendInputs({
          ...previous,
          nutrientId: firstInstall
            ? (nextNutrients[0]?.nutrientId ?? "")
            : nextNutrients.some((item) => item.nutrientId === previous.nutrientId)
              ? previous.nutrientId
              : "",
          definitionId: firstInstall
            ? (nextDefinitions.find((item) => item.status === "active")?.id ?? "")
            : nextDefinitions.some((item) => item.id === previous.definitionId)
              ? previous.definitionId
              : "",
        });
      }
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
      if (customLoadReceipts.current?.controller === controller) customLoadReceipts.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [
    abortTrendRead,
    accessToken,
    apiBase,
    clearCustomCopyChoice,
    closeCustom,
    currentCustomScope,
    customScope,
    installTrendInputs,
    reconcileReminders,
    resetFoodDetails,
    setDefinitions,
    setFoods,
    setLoading,
  ]);

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

  const renderedCustomEpoch = customEpoch.current;
  const savedFoodFilterVisible =
    currentCustomScope(renderedCustomEpoch) &&
    foodFilterScopeRef.current === foodFilterScope &&
    installedFoodFilterScope.current === foodFilterScope;
  const loadedSavedFoods =
    savedFoodFilterVisible && customFoodsScope.current === customScope ? foods : [];
  const matchingSavedFoods = loadedSavedFoods.filter((food) =>
    food.currentVersion.name.toLowerCase().includes(savedFoodFilter.value.trim().toLowerCase()),
  );
  function changeSavedFoodFilter(value: string) {
    if (
      !currentCustomScope(renderedCustomEpoch) ||
      foodFilterScopeRef.current !== foodFilterScope ||
      installedFoodFilterScope.current !== foodFilterScope ||
      savedFoodFilterRef.current !== savedFoodFilter
    )
      return;
    const bounded = value.slice(0, 200);
    if (bounded === savedFoodFilter.value) return;
    const next = { value: bounded };
    savedFoodFilterRef.current = next;
    setSavedFoodFilter(next);
  }
  const renderedFoodDetailsReady = foodDetailsReady.current && !loading;
  const trendScopeCurrent = () =>
    currentCustomScope(renderedCustomEpoch) &&
    trendScopeRef.current === trendScope &&
    trendInstalled.current === trendScope;
  const trendMetadataCurrent = () =>
    trendScopeCurrent() &&
    !loadingRef.current &&
    registry.current?.scope === customScope &&
    registry.current.values === nutrients &&
    trendDefinitions.current === definitions;
  const trendReady = trendMetadataCurrent();
  const chosenTrendNutrient = trendReady
    ? nutrients.find((item) => item.nutrientId === selectedNutrient)
    : undefined;
  const chosenTrendDefinition = trendReady
    ? definitions.find((item) => item.id === selectedDefinition)
    : undefined;
  const filteredTrendNutrients = trendReady
    ? nutrients.filter((item) =>
        item.name.toLowerCase().includes(trendFilter.value.trim().toLowerCase()),
      )
    : [];
  function changeTrendFilter(value: string) {
    if (
      !trendReady ||
      !trendMetadataCurrent() ||
      trendFilterRef.current !== trendFilter ||
      value.length > 200 ||
      value === trendFilter.value
    )
      return;
    installTrendFilter(value);
  }
  function changeTrendInput(field: keyof typeof trendInputs, value: string) {
    if (
      !trendReady ||
      !trendMetadataCurrent() ||
      trendInputsRef.current !== trendInputs ||
      trendInputs[field] === value
    )
      return;
    if (field === "nutrientId" && trendFilterRef.current !== trendFilter) return;
    if (field === "nutrientId" && !nutrients.some((item) => item.nutrientId === value)) return;
    if (field === "definitionId" && !definitions.some((item) => item.id === value)) return;
    abortTrendRead();
    installTrendInputs({ ...trendInputs, [field]: value });
    if (field !== "definitionId") setNutrientTrend(null);
    if (field !== "nutrientId") setBiometricTrend(null);
  }
  async function loadTrends() {
    if (
      !trendReady ||
      !trendMetadataCurrent() ||
      trendInputsRef.current !== trendInputs ||
      busyRef.current !== null ||
      trendController.current ||
      (!chosenTrendNutrient && !chosenTrendDefinition)
    )
      return;
    if (!isLocalDate(from) || !isLocalDate(to) || from > to) {
      setMessage("Trend dates must be a valid ordered local-date range.");
      return;
    }
    const controller = new AbortController();
    trendController.current = controller;
    setTrendPending(true);
    const current = () =>
      trendMetadataCurrent() &&
      trendInputsRef.current === trendInputs &&
      trendController.current === controller &&
      !controller.signal.aborted;
    const read = async (path: string) => {
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        headers: authenticatedHeaders(accessToken),
        signal: controller.signal,
      });
      if (!current()) return null;
      if (response.status === 401) {
        closeCustom();
        await unauthorizedRef.current();
        return null;
      }
      const value = await jsonBody(response);
      if (!current()) return null;
      if (!response.ok) throw new Error(responseError(value, "The private health request failed."));
      return value;
    };
    setBusy("trends");
    try {
      const [nutrientValue, biometricValue] = await Promise.all([
        chosenTrendNutrient
          ? read(
              `/v1/trends/nutrients?nutrientId=${encodeURIComponent(chosenTrendNutrient.nutrientId)}&from=${from}&to=${to}`,
            )
          : null,
        chosenTrendDefinition
          ? read(
              `/v1/trends/biometrics?definitionId=${encodeURIComponent(chosenTrendDefinition.id)}&from=${from}&to=${to}`,
            )
          : null,
      ]);
      if (!current()) return;
      const nextNutrient = nutrientValue ? parseNutrientTrend(nutrientValue) : null;
      const nextBiometric = biometricValue ? parseBiometricTrend(biometricValue) : null;
      if (
        chosenTrendNutrient &&
        (!nextNutrient ||
          nextNutrient.nutrient.id !== chosenTrendNutrient.nutrientId ||
          nextNutrient.nutrient.unit !== chosenTrendNutrient.unit ||
          nextNutrient.from !== from ||
          nextNutrient.to !== to ||
          nextNutrient.timeZone !== profileTimeZone ||
          nextNutrient.points.some(
            (point) =>
              point.aggregate !== null &&
              (point.aggregate.nutrientId !== nextNutrient.nutrient.id ||
                point.aggregate.unit !== nextNutrient.nutrient.unit),
          ))
      )
        throw new TypeError(
          "The nutrient trend does not match the selected nutrient, range or time zone. Load it again.",
        );
      if (
        chosenTrendDefinition &&
        (!nextBiometric ||
          nextBiometric.definition.id !== chosenTrendDefinition.id ||
          nextBiometric.from !== from ||
          nextBiometric.to !== to ||
          nextBiometric.timeZone !== profileTimeZone)
      )
        throw new TypeError(
          "The biometric trend does not match the selected metric, range or time zone. Load it again.",
        );
      setNutrientTrend(nextNutrient);
      setBiometricTrend(nextBiometric);
      setMessage(`Trends use local-day boundaries in ${profileTimeZone}.`);
    } catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : "Trends failed.");
    } finally {
      if (trendController.current === controller) {
        const canPublish = current();
        trendController.current = null;
        controller.abort();
        if (canPublish) {
          setTrendPending(false);
          if (busyRef.current === "trends") setBusy(null);
        }
      }
    }
  }

  function toggleFoodDetails(food: CustomFood) {
    if (
      !currentCustomScope(renderedCustomEpoch) ||
      !renderedFoodDetailsReady ||
      !foodDetailsReady.current ||
      loadingRef.current ||
      customFoodsScope.current !== customScope ||
      foodsRef.current !== foods ||
      !foodsRef.current.includes(food) ||
      foodDetailsRef.current !== foodDetails
    )
      return;
    const next = new Set(foodDetails);
    if (next.has(food)) next.delete(food);
    else next.add(food);
    setFoodDetails(next);
  }
  function canEditCustom() {
    return (
      currentCustomScope(renderedCustomEpoch) &&
      customRef.current === custom &&
      composerRef.current === composer &&
      !loadingRef.current &&
      busyRef.current === null &&
      customWrite.current === null
    );
  }
  function changeCustom(field: keyof Omit<CustomDraft, "id" | "revision">, value: string) {
    if (!canEditCustom() || custom[field] === value) return;
    installCustom({ ...custom, [field]: value });
  }
  function changeComposer(change: Partial<NutrientComposer>) {
    if (
      !canEditCustom() ||
      composerRef.current !== composer ||
      registry.current?.scope !== customScope ||
      registry.current.values !== nutrients
    )
      return;
    const next = { ...composer, ...change };
    if (
      Object.keys(change).every(
        (key) => next[key as keyof NutrientComposer] === composer[key as keyof NutrientComposer],
      )
    )
      return;
    clearCustomCopyChoice();
    composerRef.current = next;
    setComposerState(next);
    setComposerStatus("");
  }
  function addNutrientRow() {
    if (
      !canEditCustom() ||
      composerRef.current !== composer ||
      registry.current?.scope !== customScope ||
      registry.current.values !== nutrients
    )
      return;
    try {
      let candidate: CustomFoodNutrientDraft;
      if (composer.state === "quantified")
        candidate = {
          nutrientId: composer.nutrientId,
          state: "quantified",
          amountPer100Grams: composer.amount,
        };
      else if (composer.state === "trace")
        candidate = { nutrientId: composer.nutrientId, state: "trace", amountPer100Grams: null };
      else {
        if (!composer.reason)
          throw new TypeError("Choose an explicit unknown reason before adding this row.");
        candidate = {
          nutrientId: composer.nutrientId,
          state: "unknown",
          amountPer100Grams: null,
          reason: composer.reason,
        };
      }
      const nextText = appendCanonicalNutrientInput(custom.nutrients, candidate, nutrients);
      installCustom({ ...custom, nutrients: nextText });
      const next = { ...composer, amount: "" };
      composerRef.current = next;
      setComposerState(next);
      setComposerStatus(
        "Nutrient row added to the draft. Choose Create private food or Save new version to save it.",
      );
    } catch (error) {
      setComposerStatus(
        error instanceof Error ? error.message : "The nutrient row could not be added.",
      );
    }
  }
  function copySourceIsCurrent(food: CustomFood): boolean {
    return (
      canEditCustom() &&
      foodFilterScopeRef.current === foodFilterScope &&
      installedFoodFilterScope.current === foodFilterScope &&
      customFoodsScope.current === customScope &&
      foodsRef.current.includes(food)
    );
  }
  function installCopiedCustom(food: CustomFood) {
    customCreationIntent.current += 1;
    installCustom({ ...customDraft(food), id: null, revision: null }, true);
    setCustomCopyStatus(
      `Copied saved ${food.currentVersion.name}, version ${food.currentVersion.versionNumber}, to a new draft. Choose Create private food to save it.`,
    );
    workspaceScroll.current?.scrollTo({ y: customEditorOffset.current, animated: true });
  }
  function copySavedCustom(food: CustomFood) {
    if (!copySourceIsCurrent(food) || customCopyChoiceRef.current !== customCopyChoice) return;
    if (
      JSON.stringify(custom) !== JSON.stringify(customBaseline.current) ||
      JSON.stringify(composer) !== JSON.stringify(blankComposer())
    ) {
      const choice = {
        food,
        draft: custom,
        composer,
        profileScope: foodFilterScope,
        epoch: renderedCustomEpoch,
      };
      customCopyChoiceRef.current = choice;
      setCustomCopyChoice(choice);
      workspaceScroll.current?.scrollTo({ y: customEditorOffset.current, animated: true });
      return;
    }
    installCopiedCustom(food);
  }
  function customCopyChoiceIsCurrent(choice: CustomCopyChoice): boolean {
    return (
      customCopyChoiceRef.current === choice &&
      choice.draft === customRef.current &&
      choice.composer === composerRef.current &&
      choice.profileScope === foodFilterScopeRef.current &&
      choice.epoch === customEpoch.current &&
      copySourceIsCurrent(choice.food)
    );
  }
  function confirmCustomCopy(choice: CustomCopyChoice) {
    if (customCopyChoiceIsCurrent(choice)) installCopiedCustom(choice.food);
  }
  function keepEditingCustom(choice: CustomCopyChoice) {
    if (customCopyChoiceIsCurrent(choice)) clearCustomCopyChoice();
  }
  function reviseCustom(food: CustomFood) {
    if (
      !canEditCustom() ||
      customFoodsScope.current !== customScope ||
      foodsRef.current !== foods ||
      !foodsRef.current.includes(food)
    )
      return;
    installCustom(customDraft(food), true);
  }
  function cancelCustom() {
    if (!canEditCustom()) return;
    installCustom(blankCustom(), true);
  }

  async function saveCustomFood() {
    if (!canEditCustom()) return;
    clearCustomCopyChoice();
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
    )
      return setMessage("A serving requires a label and positive grams.");
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
    const key = `custom:${custom.id ?? `new:${customCreationIntent.current}`}:${custom.revision ?? "0"}:${JSON.stringify(body)}`;
    let operation = customOperations.current.get(key);
    if (!operation) {
      operation = { id: newOperationId(), serializedBody: JSON.stringify(body) };
      customOperations.current.set(key, operation);
    }
    const capturedOperation = operation;
    const controller = new AbortController();
    customWrite.current = controller;
    const current = () =>
      currentCustomScope(renderedCustomEpoch) &&
      customRef.current === custom &&
      customWrite.current === controller &&
      !controller.signal.aborted;
    setBusy("custom");
    try {
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        method: "POST",
        signal: controller.signal,
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": capturedOperation.id,
          ...(custom.revision ? { "if-match": quoteRevision(custom.revision) } : {}),
        }),
        body: capturedOperation.serializedBody,
      });
      if (!current()) return;
      if (response.status === 401) {
        closeCustom();
        await unauthorizedRef.current();
        return;
      }
      const value = await jsonBody(response);
      if (!current()) return;
      if (response.status === 412) customOperations.current.delete(key);
      if (!response.ok) throw new Error(responseError(value, "The private health request failed."));
      const saved = parseCustomFoodResponse(value);
      if (custom.id && saved.id !== custom.id)
        throw new TypeError("The custom-food receipt belongs to another food.");
      if (customOperations.current.get(key) === capturedOperation)
        customOperations.current.delete(key);
      const currentSaved =
        customFoodsScope.current === customScope
          ? foodsRef.current.find((item) => item.id === saved.id)
          : undefined;
      const retainedSaved =
        currentSaved && BigInt(currentSaved.revision) > BigInt(saved.revision)
          ? currentSaved
          : saved;
      const pendingList = customLoadReceipts.current;
      if (
        pendingList?.scope === customScope &&
        pendingList.controller === loadController.current &&
        !pendingList.controller.signal.aborted
      )
        customLoadReceipts.current = {
          ...pendingList,
          foods: [retainedSaved, ...pendingList.foods.filter((item) => item.id !== saved.id)],
        };
      setFoods(
        customFoodsScope.current === customScope
          ? [retainedSaved, ...foodsRef.current.filter((item) => item.id !== saved.id)]
          : [saved],
      );
      customFoodsScope.current = customScope;
      installCustom(blankCustom(), true);
      setMessage(`Saved owner-entered private food version ${saved.currentVersion.versionNumber}.`);
    } catch (error) {
      if (current())
        setMessage(
          `${error instanceof Error ? error.message : "Custom food failed."} Submit again for an exact retry.`,
        );
    } finally {
      if (customWrite.current === controller) {
        customWrite.current = null;
        if (currentCustomScope(renderedCustomEpoch) && busyRef.current === "custom") setBusy(null);
      }
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
    if (customLogEnqueueInFlight.current) {
      return setMessage("Wait for the current custom-food log to be secured on this device.");
    }
    const serving = customLog.food.currentVersion.serving;
    if (customLog.kind === "serving" && !serving)
      return setMessage("This food has no serving definition.");
    const currentQueue = quickAddOutboxController.getState();
    if (currentQueue.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS) {
      return setMessage(
        `The secure diary queue is full at ${MAX_QUICK_ADD_OUTBOX_ITEMS} items. Review queued logs before adding another.`,
      );
    }
    if (
      currentQueue.status === "closed" ||
      currentQueue.status === "owner_mismatch" ||
      (currentQueue.status === "unavailable" &&
        (currentQueue.reason === "storage" || currentQueue.reason === "credential"))
    ) {
      return setMessage(
        "Diary logging is unavailable until secure storage and authentication recover.",
      );
    }
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
    customLogEnqueueInFlight.current = true;
    setBusy("custom-log");
    try {
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "custom_food",
        customFoodName: customLog.food.currentVersion.name,
        customFoodId: customLog.food.id,
        customFoodVersionId: customLog.food.currentVersion.id,
        customFoodVersionNumber: customLog.food.currentVersion.versionNumber,
        portion:
          customLog.kind === "serving" && serving
            ? {
                kind: "serving",
                servingId: serving.id,
                amount: customLog.quantity,
                servingLabel: serving.label,
              }
            : { kind: "grams", grams: customLog.quantity },
        mealSlot: customLog.mealSlot,
        localDate: customLog.localDate,
        occurredAt,
      });
      ownedCustomLogOperations.current.add(item.operationId);
      setCustomLog(null);
      setMessage(
        `${customLog.food.currentVersion.name} v${customLog.food.currentVersion.versionNumber} is queued securely for ${diaryGroupLabel(diaryGroups, customLog.mealSlot)} on ${customLog.localDate}. It is not included in diary totals until the server confirms it.`,
      );
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (error) {
      if (error instanceof QuickAddEnqueueAmbiguousError) {
        ownedCustomLogOperations.current.add(error.operationId);
        setCustomLog(null);
        void quickAddOutboxController.requestDrain(error.operationId);
        setMessage(
          "Secure storage could not confirm whether the custom food was queued. Do not submit it again until the queue status recovers.",
        );
      } else {
        setMessage(
          "The custom food was not queued. Refresh this screen and try again after the diary session is current.",
        );
      }
    } finally {
      customLogEnqueueInFlight.current = false;
      setBusy(null);
    }
  }

  async function loadMoreFoods() {
    if (
      !currentCustomScope(renderedCustomEpoch) ||
      loadingRef.current ||
      busyRef.current !== null ||
      customFoodsScope.current !== customScope ||
      foodsRef.current !== foods ||
      !foodCursor ||
      !API_CURSOR.test(foodCursor)
    )
      return;
    const controller = new AbortController();
    customPageRequest.current = controller;
    const current = () =>
      currentCustomScope(renderedCustomEpoch) &&
      customPageRequest.current === controller &&
      !controller.signal.aborted &&
      foodsRef.current === foods;
    setBusy("food-more");
    try {
      const response = await fetch(
        apiUrl(
          apiBase,
          `/v1/custom-foods?limit=50&cursor=${encodeURIComponent(foodCursor)}`,
        ).toString(),
        {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        },
      );
      if (!current()) return;
      if (response.status === 401) {
        closeCustom();
        await unauthorizedRef.current();
        return;
      }
      const value = await jsonBody(response);
      if (!current()) return;
      if (!response.ok)
        throw new Error(responseError(value, "More custom foods could not be loaded."));
      const page = parseCustomFoodList(value);
      setFoods([
        ...foods,
        ...page.items.filter((item) => !foods.some((old) => old.id === item.id)),
      ]);
      setFoodCursor(page.nextCursor);
    } catch (error) {
      if (current())
        setMessage(
          error instanceof Error ? error.message : "More custom foods could not be loaded.",
        );
    } finally {
      if (customPageRequest.current === controller) {
        customPageRequest.current = null;
        if (currentCustomScope(renderedCustomEpoch) && busyRef.current === "food-more")
          setBusy(null);
      }
    }
  }

  function installDefinitionReceipt(saved: BiometricDefinition, archived = false): boolean {
    if (
      !customMounted.current ||
      customScopeRef.current !== customScope ||
      customInstalled.current !== customScope ||
      customClosed.current === customScope ||
      !ownerUserId ||
      !accessToken ||
      !Number.isSafeInteger(sessionEpoch) ||
      sessionEpoch < 0
    )
      return false;
    const latest = definitionsRef.current;
    const next = archived
      ? latest.map((item) => (item.id === saved.id ? saved : item))
      : [saved, ...latest.filter((item) => item.id !== saved.id)];
    if (registry.current?.scope === customScope && trendDefinitions.current === latest) {
      abortTrendRead();
      trendDefinitions.current = next;
    }
    setDefinitions(next);
    return true;
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
      if (!installDefinitionReceipt(saved)) return;
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
      if (!installDefinitionReceipt(saved, true)) return;
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

  const customVisible = currentCustomScope(customEpoch.current);
  const visibleComposer = customVisible ? composer : blankComposer();
  const customDisabled = !customVisible || loading || busy !== null || customWrite.current !== null;
  const composerAvailable =
    customVisible &&
    registry.current?.scope === customScope &&
    registry.current.values === nutrients;
  const composerDisabled = customDisabled || !composerAvailable;
  const availableNutrients = composerAvailable ? nutrients : [];
  const matchedNutrients = availableNutrients.filter((item) =>
    item.name.toLowerCase().includes(composer.query.trim().toLowerCase()),
  );
  const chosenNutrient = availableNutrients.find((item) => item.nutrientId === composer.nutrientId);

  const customLogUnavailable =
    busy !== null ||
    quickAddOutboxState.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS ||
    quickAddOutboxState.status === "closed" ||
    quickAddOutboxState.status === "owner_mismatch" ||
    (quickAddOutboxState.status === "unavailable" &&
      (quickAddOutboxState.reason === "storage" || quickAddOutboxState.reason === "credential"));

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        ref={workspaceScroll}
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
            value={trendScopeCurrent() ? from : ""}
            disabled={!trendReady}
            onChangeText={(value) => changeTrendInput("from", value)}
            maxLength={10}
          />
          <LabeledInput
            label="To (YYYY-MM-DD)"
            value={trendScopeCurrent() ? to : ""}
            disabled={!trendReady}
            onChangeText={(value) => changeTrendInput("to", value)}
            maxLength={10}
          />
          <Text style={styles.label}>Nutrient</Text>
          <LabeledInput
            label="Find a trend nutrient by name"
            value={trendScopeCurrent() ? trendFilter.value : ""}
            disabled={!trendReady}
            onChangeText={changeTrendFilter}
            maxLength={200}
          />
          <Button
            label="Clear trend nutrient filter"
            disabled={!trendReady}
            onPress={() => changeTrendFilter("")}
            secondary
          />
          <Text style={styles.help}>
            {trendReady
              ? nutrients.length === 0
                ? "No trend nutrients are available in the loaded list."
                : `${filteredTrendNutrients.length} matching of ${nutrients.length} loaded trend nutrients.`
              : loading && trendScopeCurrent()
                ? "Loading the trend nutrient list…"
                : "The trend nutrient list is unavailable. Choose Refresh private data to try again."}
          </Text>
          {trendReady && nutrients.length > 0 && filteredTrendNutrients.length === 0 ? (
            <Text style={styles.help}>No loaded nutrients match this name.</Text>
          ) : null}
          <Text style={styles.help}>
            {chosenTrendNutrient
              ? `Selected nutrient: ${chosenTrendNutrient.name} · ${chosenTrendNutrient.unit}`
              : "No trend nutrient selected."}
          </Text>
          <ChipRow
            items={filteredTrendNutrients.map((item) => ({
              key: item.nutrientId,
              label: `${item.name} · ${item.unit}`,
            }))}
            selected={trendReady ? selectedNutrient : ""}
            disabled={!trendReady}
            wrapLabels
            onSelect={(value) => changeTrendInput("nutrientId", value)}
          />
          <Text style={styles.label}>Biometric</Text>
          <ChipRow
            items={(trendReady ? definitions : []).map((item) => ({
              key: item.id,
              label: `${item.name}${item.status === "archived" ? " (archived)" : ""}`,
            }))}
            selected={trendReady ? selectedDefinition : ""}
            disabled={!trendReady}
            onSelect={(value) => changeTrendInput("definitionId", value)}
          />
          <Button
            disabled={
              !trendReady ||
              trendPending ||
              busy !== null ||
              (!chosenTrendNutrient && !chosenTrendDefinition)
            }
            label={trendPending ? "Loading…" : "Load local-day trends"}
            onPress={() => void loadTrends()}
          />
          {trendReady && nutrientTrend ? (
            <Text accessibilityRole="header" style={styles.cardTitle}>
              {`${nutrientTrend.nutrient.name} (${nutrientTrend.nutrient.unit}) · ${nutrientTrend.from} to ${nutrientTrend.to} · ${nutrientTrend.timeZone}`}
            </Text>
          ) : null}
          {(trendReady ? nutrientTrend?.points : [])?.map((point) => (
            <Text key={point.localDate} style={styles.rowText}>
              {point.localDate}: {nutrientTrendLabel(point.aggregate)}
            </Text>
          ))}
          {trendReady && biometricTrend ? (
            <Text accessibilityRole="header" style={styles.cardTitle}>
              {`${biometricTrend.definition.name} (${biometricTrend.definition.canonicalUnit}) · ${biometricTrend.from} to ${biometricTrend.to} · ${biometricTrend.timeZone}`}
            </Text>
          ) : null}
          {(trendReady ? biometricTrend?.points : [])?.map((point) => (
            <Text key={point.localDate} style={styles.rowText}>
              {point.localDate}: {point.last} {biometricTrend?.definition.canonicalUnit} ·{" "}
              {point.count} reading{point.count === 1 ? "" : "s"}
            </Text>
          ))}
        </Section>

        <Section
          title="Private custom foods"
          subtitle="Owner-entered foods are private and every diary log pins an immutable version."
          onLayout={(event) => {
            customEditorOffset.current = event.nativeEvent.layout.y;
          }}
        >
          {savedFoodFilterVisible && customCopyStatus ? (
            <Text accessibilityLiveRegion="polite" style={styles.help}>
              {customCopyStatus}
            </Text>
          ) : null}
          {customCopyChoice && customCopyChoiceIsCurrent(customCopyChoice) ? (
            <View style={styles.editor}>
              <Text style={styles.cardTitle}>Replace unsaved custom-food work?</Text>
              <Text style={styles.help}>
                Keep editing, or discard this draft and any nutrient inputs not yet added to it,
                then copy saved {customCopyChoice.food.currentVersion.name}, version{" "}
                {customCopyChoice.food.currentVersion.versionNumber}.
              </Text>
              <Button
                label="Keep editing"
                onPress={() => keepEditingCustom(customCopyChoice)}
                secondary
              />
              <Button
                label="Discard draft and copy saved version"
                onPress={() => confirmCustomCopy(customCopyChoice)}
                secondary
              />
            </View>
          ) : null}
          <LabeledInput
            label="Name"
            value={customVisible ? custom.name : ""}
            disabled={customDisabled}
            onChangeText={(name) => changeCustom("name", name)}
            maxLength={500}
          />
          <LabeledInput
            label="Brand (optional)"
            value={customVisible ? custom.brandName : ""}
            disabled={customDisabled}
            onChangeText={(brandName) => changeCustom("brandName", brandName)}
            maxLength={300}
          />
          <LabeledInput
            label="Serving label (optional)"
            value={customVisible ? custom.servingLabel : ""}
            disabled={customDisabled}
            onChangeText={(servingLabel) => changeCustom("servingLabel", servingLabel)}
            maxLength={200}
          />
          <LabeledInput
            label="Serving grams"
            value={customVisible ? custom.servingGrams : ""}
            disabled={customDisabled}
            onChangeText={(servingGrams) => changeCustom("servingGrams", servingGrams)}
            maxLength={19}
            keyboardType="decimal-pad"
          />
          <View style={styles.editor}>
            <Text accessibilityRole="header" style={styles.subheading}>
              Add a named nutrient row
            </Text>
            <Text style={styles.help}>
              This picker contains a limited nutrient list. Calories or missing nutrients can still
              use the manual text field below. Adding a row does not save the food.
            </Text>
            <LabeledInput
              label="Find an available nutrient by name"
              value={customVisible ? composer.query : ""}
              maxLength={200}
              disabled={composerDisabled}
              onChangeText={(query) => changeComposer({ query })}
            />
            <Text style={styles.help}>
              {composerAvailable
                ? `${matchedNutrients.length} matching of ${availableNutrients.length} available nutrients.`
                : "The named nutrient list has not loaded. Choose Refresh private data to try again. Manual text entry remains available."}
            </Text>
            <ChipRow
              disabled={composerDisabled}
              items={matchedNutrients.map((item) => ({
                key: item.nutrientId,
                label: `${item.name} (${item.unit})`,
              }))}
              selected={customVisible ? composer.nutrientId : ""}
              onSelect={(nutrientId) => changeComposer({ nutrientId })}
            />
            <Text style={styles.label}>
              {chosenNutrient
                ? `${chosenNutrient.name} · ${chosenNutrient.unit} per 100 g`
                : "Choose an available nutrient"}
            </Text>
            <ChipRow
              disabled={composerDisabled}
              items={[
                { key: "quantified", label: "Quantified" },
                { key: "trace", label: "Trace" },
                { key: "unknown", label: "Unknown" },
              ]}
              selected={visibleComposer.state}
              onSelect={(state) => {
                if (state === "quantified" || state === "trace" || state === "unknown")
                  changeComposer({ state });
              }}
            />
            {visibleComposer.state === "quantified" ? (
              <LabeledInput
                label={
                  chosenNutrient
                    ? `${chosenNutrient.name} amount (${chosenNutrient.unit} per 100 g)`
                    : "Exact amount per 100 g"
                }
                value={customVisible ? composer.amount : ""}
                maxLength={200}
                disabled={composerDisabled}
                keyboardType="decimal-pad"
                onChangeText={(amount) => changeComposer({ amount })}
              />
            ) : null}
            {visibleComposer.state === "unknown" ? (
              <>
                <Text style={styles.label}>Unknown reason (required)</Text>
                <ChipRow
                  disabled={composerDisabled}
                  items={[
                    { key: "not_reported", label: "Not reported" },
                    { key: "not_analyzed", label: "Not analyzed" },
                    { key: "not_applicable", label: "Not applicable" },
                    { key: "withheld", label: "Withheld" },
                  ]}
                  selected={customVisible ? composer.reason : ""}
                  onSelect={(reason) => {
                    if (
                      reason === "not_reported" ||
                      reason === "not_analyzed" ||
                      reason === "not_applicable" ||
                      reason === "withheld"
                    )
                      changeComposer({ reason });
                  }}
                />
              </>
            ) : null}
            <Button
              label="Add nutrient row to draft"
              disabled={composerDisabled}
              onPress={addNutrientRow}
              secondary
            />
            {customVisible && composerStatus ? (
              <Text accessibilityLiveRegion="polite" style={styles.help}>
                {composerStatus}
              </Text>
            ) : null}
          </View>
          <LabeledInput
            label="Canonical nutrients per 100 g"
            value={customVisible ? custom.nutrients : ""}
            disabled={customDisabled}
            onChangeText={(nutrientsValue) => changeCustom("nutrients", nutrientsValue)}
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
            value={customVisible ? custom.notes : ""}
            disabled={customDisabled}
            onChangeText={(notes) => changeCustom("notes", notes)}
            multiline
            maxLength={2_000}
          />
          <View style={styles.actions}>
            <Button
              disabled={customDisabled}
              label={customVisible && custom.id ? "Save new version" : "Create private food"}
              onPress={() => void saveCustomFood()}
            />
            {customVisible && custom.id ? (
              <Button
                label="Cancel edit"
                disabled={customDisabled}
                onPress={cancelCustom}
                secondary
              />
            ) : null}
          </View>
          {customVisible && !loading && foods.length > 0 && !foodDetailsReady.current ? (
            <Text style={styles.help}>
              Choose Refresh private data to load saved nutrient details.
            </Text>
          ) : null}
          <LabeledInput
            label="Filter loaded custom foods by name"
            value={savedFoodFilterVisible ? savedFoodFilter.value : ""}
            disabled={!savedFoodFilterVisible}
            onChangeText={changeSavedFoodFilter}
            maxLength={200}
          />
          <Button
            label="Clear custom food filter"
            disabled={!savedFoodFilterVisible}
            onPress={() => changeSavedFoodFilter("")}
            secondary
          />
          {savedFoodFilterVisible ? (
            <Text accessibilityLiveRegion="polite" style={styles.help}>
              {`${matchingSavedFoods.length} matching · ${loadedSavedFoods.length} loaded custom foods. ${
                loading
                  ? "Loading the saved custom-food list…"
                  : verifiedFoodListScope !== customScope
                    ? "The saved custom-food list has not been verified. Choose Refresh private data to load it."
                    : loadedSavedFoods.length === 0
                      ? foodCursor
                        ? "No custom foods loaded yet."
                        : "No custom foods were found in this listing."
                      : matchingSavedFoods.length === 0
                        ? "No loaded custom foods match this filter."
                        : ""
              } ${
                verifiedFoodListScope === customScope
                  ? foodCursor
                    ? "More records may remain; load more to include them."
                    : "No more records remain in this listing."
                  : ""
              }`}
            </Text>
          ) : null}
          <Text style={styles.help}>
            Only loaded food names are filtered. Pages load active foods; recently archived foods
            may remain in this list.
          </Text>
          {matchingSavedFoods.map((food) => (
            <View key={food.id} style={styles.card}>
              <Text style={styles.cardTitle}>{food.currentVersion.name}</Text>
              <Text style={styles.meta}>
                Version {food.currentVersion.versionNumber} · {food.status} · owner-entered
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${foodDetails.has(food) ? "Hide" : "Show"} nutrients for ${food.currentVersion.name}, version ${food.currentVersion.versionNumber}`}
                accessibilityState={{
                  expanded: foodDetails.has(food),
                  disabled: !renderedFoodDetailsReady,
                }}
                disabled={!renderedFoodDetailsReady}
                onPress={() => toggleFoodDetails(food)}
                style={[
                  styles.button,
                  styles.buttonSecondary,
                  !renderedFoodDetailsReady && styles.disabled,
                ]}
              >
                <Text style={[styles.buttonText, styles.buttonSecondaryText]}>
                  {foodDetails.has(food) ? "Hide nutrients" : "Show nutrients"}
                </Text>
              </Pressable>
              {foodDetails.has(food) ? (
                <View
                  nativeID={`saved-nutrients-${food.id}-${food.currentVersion.id}`}
                  style={styles.savedNutrients}
                >
                  <Text accessibilityRole="header" style={styles.cardTitle}>
                    {food.currentVersion.name} · Version {food.currentVersion.versionNumber}
                  </Text>
                  <Text style={styles.meta}>Saved nutrients per 100 g</Text>
                  {food.currentVersion.nutrients.map((row) => (
                    <View key={row.nutrient.id} style={styles.savedNutrientRow}>
                      <Text style={styles.rowText}>
                        {`${row.nutrient.name} (${row.nutrient.unit})`}
                      </Text>
                      <Text style={styles.rowText}>
                        {row.state === "quantified"
                          ? row.amountPer100Grams
                          : row.state === "trace"
                            ? "Trace"
                            : `Unknown · ${
                                {
                                  not_reported: "Not reported",
                                  not_analyzed: "Not analyzed",
                                  not_applicable: "Not applicable",
                                  withheld: "Withheld",
                                }[row.reason]
                              }`}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Copy saved ${food.currentVersion.name}, version ${food.currentVersion.versionNumber}, to a new draft`}
                  accessibilityState={{ disabled: customDisabled }}
                  disabled={customDisabled}
                  onPress={() => copySavedCustom(food)}
                  style={[styles.button, styles.buttonSecondary, customDisabled && styles.disabled]}
                >
                  <Text style={[styles.buttonText, styles.buttonSecondaryText]}>
                    Copy to new draft
                  </Text>
                </Pressable>
                <Button
                  label="Revise"
                  disabled={customDisabled}
                  onPress={() => reviseCustom(food)}
                  secondary
                />
                <Button
                  label="Log exact version"
                  onPress={() => setCustomLog(initialCustomLog(food, profileTimeZone))}
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
                items={diaryGroups.map(({ mealSlot, label }) => ({ key: mealSlot, label }))}
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
              {quickAddOutboxState.pendingCount > 0 ? (
                <Text accessibilityLiveRegion="polite" style={styles.help}>
                  {quickAddOutboxState.pendingCount} diary{" "}
                  {quickAddOutboxState.pendingCount === 1 ? "log is" : "logs are"} waiting securely
                  on this device.
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  disabled={customLogUnavailable}
                  label={
                    busy === "custom-log"
                      ? "Securing…"
                      : quickAddOutboxState.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS
                        ? `Queue full (${MAX_QUICK_ADD_OUTBOX_ITEMS})`
                        : "Secure & log pinned version"
                  }
                  onPress={() => void logCustomFood()}
                />
                <Button label="Cancel" onPress={() => setCustomLog(null)} secondary />
              </View>
            </View>
          ) : null}
          {savedFoodFilterVisible && customFoodsScope.current === customScope && foodCursor ? (
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
                    changeTrendInput("definitionId", definition.id);
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
  onLayout,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: React.ReactNode;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
}) {
  return (
    <View style={styles.section} onLayout={onLayout}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      <Text style={styles.intro}>{subtitle}</Text>
      {children}
    </View>
  );
}

function LabeledInput(props: {
  readonly disabled?: boolean;
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
        editable={!props.disabled}
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
  readonly disabled?: boolean;
  readonly items: readonly { readonly key: string; readonly label: string }[];
  readonly selected: string | readonly string[];
  readonly onSelect: (key: string) => void;
  readonly multiple?: boolean;
  readonly wrapLabels?: boolean;
}) {
  const selected = Array.isArray(props.selected) ? props.selected : [props.selected];
  return (
    <View accessibilityRole={props.multiple ? undefined : "radiogroup"} style={styles.chips}>
      {props.items.map((item) => {
        const active = selected.includes(item.key);
        return (
          <Pressable
            accessibilityRole={props.multiple ? "checkbox" : "radio"}
            accessibilityState={
              props.multiple
                ? { checked: active, disabled: Boolean(props.disabled) }
                : { selected: active, disabled: Boolean(props.disabled) }
            }
            disabled={props.disabled}
            key={item.key}
            onPress={() => props.onSelect(item.key)}
            style={[
              styles.chip,
              props.wrapLabels && styles.wrappingChip,
              active && styles.chipActive,
            ]}
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
  wrappingChip: { maxWidth: "100%", minWidth: 0, flexShrink: 1 },
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
  savedNutrients: { minWidth: 0, width: "100%", marginTop: 14 },
  savedNutrientRow: { minWidth: 0, width: "100%", marginTop: 7 },
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
