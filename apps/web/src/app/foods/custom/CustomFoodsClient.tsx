"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultDiaryGroups,
  diaryGroupLabel,
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  mealSlots,
  parseDiaryMutation,
  parseSession,
  quoteRevision,
  type SessionSummary,
} from "../../../lib/diary";
import { formatNutrientAmount } from "../../../lib/nutrition-display";
import { confirmBrowserLogout } from "../../../lib/private-api";
import { installPrivateDataForOwner, PrivateOwnerFenceError } from "../../../lib/private-owner";
import { parseTargetableNutrients, type TargetableNutrient } from "../../../lib/recipes-goals";
import {
  type CustomFood,
  type CustomFoodNutrient,
  isPositiveInputDecimal,
  operationId,
  parseCustomFoodList,
  parseCustomFoodMutation,
} from "../../../lib/retention";
import { AppNavigation } from "../../ui/AppNavigation";
import FoodsNavigation from "../../ui/FoodsNavigation";
import { Icon } from "../../ui/Icon";

type LoadState = "loading" | "ready" | "error";
interface CustomDraft {
  readonly id: string | null;
  readonly revision: string | null;
  readonly name: string;
  readonly brandName: string;
  readonly servingLabel: string;
  readonly servingGrams: string;
  readonly notes: string;
  readonly nutrients: readonly CustomFoodNutrient[];
}

interface CustomDraftChoice {
  readonly action: "copy" | "revise";
  readonly food: CustomFood;
  readonly draft: CustomDraft;
  readonly generation: number;
}
interface CustomLogDraft {
  readonly food: CustomFood;
  readonly kind: "serving" | "grams";
  readonly quantity: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
}

const unknownNutrientReasons = {
  not_reported: "Not reported",
  not_analyzed: "Not analyzed",
  not_applicable: "Not applicable",
  withheld: "Withheld",
} as const;
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
/** A typed time-zone conflict proves no write occurred, so its stale retry must not survive. */
export function fenceCustomFoodLogForTimeZoneChange(
  pending: Map<string, string>,
  intentKey: string,
  operationId: string,
  status: number,
  body: unknown,
): boolean {
  const changed =
    status === 409 &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "code" in body &&
    body.code === "DIARY_TIME_ZONE_CHANGED";
  if (!changed) return false;
  if (pending.get(intentKey) === operationId) pending.delete(intentKey);
  return true;
}

export function customFoodLogTimeZoneReviewMessage(
  localDate: string,
  currentTimeZone: string | null,
): string {
  return currentTimeZone
    ? `Your profile time zone changed to ${currentTimeZone}. This private food was not logged. Review ${localDate} as a local day in that zone, then confirm the day before logging again.`
    : "Your profile time zone changed. This private food was not logged, and its stale retry was cleared. Current account settings could not be reloaded; refresh this page, then review the local diary day before logging again.";
}

export function customFoodProfileRefreshBelongsToOwner(
  initiatingUserId: string,
  refreshedUserId: string,
): boolean {
  return initiatingUserId === refreshedUserId;
}

function blankCustom(nutrientId: string): CustomDraft {
  return {
    id: null,
    revision: null,
    name: "",
    brandName: "",
    servingLabel: "",
    servingGrams: "",
    notes: "",
    nutrients: nutrientId ? [{ nutrientId, state: "quantified", amountPer100Grams: "0" }] : [],
  };
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
    nutrients: food.currentVersion.nutrients.map((snapshot) =>
      snapshot.state === "quantified"
        ? {
            nutrientId: snapshot.nutrient.id,
            state: snapshot.state,
            amountPer100Grams: snapshot.amountPer100Grams,
          }
        : snapshot.state === "trace"
          ? { nutrientId: snapshot.nutrient.id, state: snapshot.state, amountPer100Grams: null }
          : {
              nutrientId: snapshot.nutrient.id,
              state: snapshot.state,
              amountPer100Grams: null,
              reason: snapshot.reason,
            },
    ),
  };
}

function mergeAcceptedCustomFood(
  items: readonly CustomFood[],
  saved: CustomFood,
): readonly CustomFood[] {
  const current = items.find((item) => item.id === saved.id);
  if (current && BigInt(current.revision) > BigInt(saved.revision)) return items;
  return [saved, ...items.filter((item) => item.id !== saved.id)];
}

export function CustomFoodsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryDates = searchParams.getAll("date");
  const requestedDate = queryDates.length === 1 ? queryDates[0] : undefined;
  const validatedDate = requestedDate && isLocalDate(requestedDate) ? requestedDate : undefined;
  const queryMeals = searchParams.getAll("meal");
  const requestedMeal = queryMeals.length === 1 ? queryMeals[0] : undefined;
  const validatedMeal = mealSlots.find((slot) => slot === requestedMeal);
  const routeDestination = useRef({ date: validatedDate, meal: validatedMeal });
  if (
    routeDestination.current.date !== validatedDate ||
    routeDestination.current.meal !== validatedMeal
  ) {
    routeDestination.current = { date: validatedDate, meal: validatedMeal };
  }
  const renderedRouteDestination = routeDestination.current;
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your personal foods…");
  const [session, setSessionState] = useState<SessionSummary | null>(null);
  const [nutrients, setNutrients] = useState<readonly TargetableNutrient[]>([]);
  const nutrientRegistry = useRef<{
    readonly values: readonly TargetableNutrient[];
    readonly scope: string;
  } | null>(null);
  const renderedNutrientRegistry = nutrientRegistry.current;
  const [customFoods, setCustomFoods] = useState<readonly CustomFood[]>([]);
  const [savedFoodFilter, setSavedFoodFilter] = useState("");
  const [verifiedFoodListOwner, setVerifiedFoodListOwner] = useState<string | null>(null);
  const [expandedFoods, setExpandedFoods] = useState<ReadonlySet<CustomFood>>(new Set());
  const [customFoodCursor, setCustomFoodCursor] = useState<string | null>(null);
  const [custom, setCustomState] = useState<CustomDraft>(() => blankCustom(""));
  const [customSource, setCustomSource] = useState<CustomFood | null>(null);
  const [customDraftChoice, setCustomDraftChoice] = useState<CustomDraftChoice | null>(null);
  const [customSaving, setCustomSaving] = useState(false);
  const [customLog, setCustomLogState] = useState<CustomLogDraft | null>(null);
  const customLogRef = useRef<CustomLogDraft | null>(null);
  const customLogGeneration = useRef(0);
  const renderedLogGeneration = customLogGeneration.current;
  const activeLog = useRef<object | null>(null);
  const replaceCustomLog = useCallback((next: CustomLogDraft | null) => {
    customLogRef.current = next;
    customLogGeneration.current += 1;
    setCustomLogState(next);
  }, []);
  const [customLogDateReviewRequired, setCustomLogDateReviewRequired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const customRef = useRef(custom);
  const customBaseline = useRef<CustomDraft | null>(custom);
  const customGeneration = useRef(0);
  const customControlGeneration = useRef(0);
  const customLifecycle = useRef(0);
  const customCreateIntent = useRef(0);
  const customWrite = useRef<object | null>(null);
  const customLoadReceipts = useRef<{
    readonly controller: AbortController;
    readonly generation: number;
    readonly owner: string | null;
    readonly foods: Map<string, CustomFood>;
  } | null>(null);
  const customDraftChoiceRef = useRef<CustomDraftChoice | null>(null);
  const customNameInput = useRef<HTMLInputElement | null>(null);
  const customKeepButton = useRef<HTMLButtonElement | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const privateReadControllers = useRef(new Set<AbortController>());
  const profileRefreshController = useRef<AbortController | null>(null);
  const ownerUserId = useRef<string | null>(null);
  const privateUiClosed = useRef(false);
  const customInitialized = useRef(false);
  const mounted = useRef(false);
  const visible = useRef(true);
  const installedSession = useRef<SessionSummary | null>(null);
  const savedFoodFilterGeneration = useRef(0);
  const savedFoodFilterScope = useRef<string | null>(null);
  const savedFoodFilterRef = useRef("");
  const renderedFilterGeneration = savedFoodFilterGeneration.current;
  const installedFoods = useRef<readonly CustomFood[]>([]);
  const foodListGeneration = useRef(0);
  const foodDetailsReady = useRef(false);
  const disclosureGeneration = useRef(0);
  const disclosureVersions = useRef(new Map<CustomFood, number>());
  const expandedFoodsRef = useRef<ReadonlySet<CustomFood>>(new Set());
  const renderedListGeneration = foodListGeneration.current;
  const renderedDisclosureGeneration = disclosureGeneration.current;
  const diaryGroups = session?.profile.diaryGroups ?? defaultDiaryGroups;
  function canUseCustomLogControls() {
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      session !== null &&
      installedSession.current === session &&
      ownerUserId.current === session.user.id &&
      customLogRef.current === customLog &&
      customLogGeneration.current === renderedLogGeneration &&
      routeDestination.current === renderedRouteDestination
    );
  }
  function setCustomLog(next: CustomLogDraft | null) {
    if (!canUseCustomLogControls() || JSON.stringify(next) === JSON.stringify(customLogRef.current))
      return;
    replaceCustomLog(next);
  }

  const renderedCustomGeneration = customGeneration.current;
  const renderedCustomControl = customControlGeneration.current;
  const customScope = session ? JSON.stringify([session.user.id, session.profile]) : null;

  const clearCustomDraftChoice = useCallback(() => {
    customDraftChoiceRef.current = null;
    setCustomDraftChoice(null);
  }, []);
  const invalidateCustomControls = useCallback(() => {
    customControlGeneration.current += 1;
    clearCustomDraftChoice();
  }, [clearCustomDraftChoice]);
  const replaceCustom = useCallback(
    (next: CustomDraft, source: CustomFood | null = null, clean = true) => {
      customRef.current = next;
      customGeneration.current += 1;
      customBaseline.current = clean ? next : null;
      clearCustomDraftChoice();
      setCustomState(next);
      setCustomSource(source);
    },
    [clearCustomDraftChoice],
  );
  function canUseCustomControls() {
    const currentSession = installedSession.current;
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      customControlGeneration.current === renderedCustomControl &&
      customGeneration.current === renderedCustomGeneration &&
      customRef.current === custom &&
      (currentSession ? JSON.stringify([currentSession.user.id, currentSession.profile]) : null) ===
        customScope &&
      (currentSession === null || ownerUserId.current === currentSession.user.id)
    );
  }
  function setCustom(next: CustomDraft) {
    if (!canUseCustomControls() || JSON.stringify(next) === JSON.stringify(customRef.current))
      return;
    customRef.current = next;
    customGeneration.current += 1;
    clearCustomDraftChoice();
    setCustomState(next);
  }
  function currentCustomNutrientMetadata() {
    return (
      canUseCustomControls() &&
      session !== null &&
      installedSession.current === session &&
      state === "ready" &&
      loadController.current === null &&
      profileRefreshController.current === null &&
      nutrientRegistry.current === renderedNutrientRegistry &&
      renderedNutrientRegistry?.values === nutrients &&
      renderedNutrientRegistry.scope === customScope
    );
  }
  const customNutrientMetadataReady = currentCustomNutrientMetadata();
  const nextCustomNutrient = customNutrientMetadataReady
    ? nutrients.find((item) => !custom.nutrients.some((row) => row.nutrientId === item.nutrientId))
    : undefined;
  function addCustomNutrient() {
    if (!currentCustomNutrientMetadata() || !nextCustomNutrient) return;
    setCustom({
      ...custom,
      nutrients: [
        ...custom.nutrients,
        { nutrientId: nextCustomNutrient.nutrientId, state: "quantified", amountPer100Grams: "0" },
      ],
    });
  }
  function changeCustomNutrient(index: number, nutrientId: string) {
    if (!currentCustomNutrientMetadata()) return;
    const row = custom.nutrients[index];
    if (
      !row ||
      row.nutrientId === nutrientId ||
      !nutrients.some((item) => item.nutrientId === nutrientId) ||
      custom.nutrients.some(
        (item, rowIndex) => rowIndex !== index && item.nutrientId === nutrientId,
      )
    )
      return;
    setCustom({
      ...custom,
      nutrients: custom.nutrients.map((item, rowIndex) =>
        rowIndex === index ? { nutrientId, state: "quantified", amountPer100Grams: "0" } : item,
      ),
    });
  }
  function canCopyCustomFood(food: CustomFood) {
    return (
      canUseCustomControls() &&
      session !== null &&
      foodDetailsReady.current &&
      foodListGeneration.current === renderedListGeneration &&
      installedFoods.current.includes(food) &&
      customWrite.current === null
    );
  }
  function installCustomDraft(food: CustomFood, action: CustomDraftChoice["action"]) {
    if (!canCopyCustomFood(food)) return;
    if (action === "copy") {
      customCreateIntent.current += 1;
      replaceCustom({ ...customDraft(food), id: null, revision: null }, food, false);
    } else replaceCustom(customDraft(food), food);
    customNameInput.current?.focus();
  }
  function requestCustomDraftChoice(food: CustomFood, action: CustomDraftChoice["action"]) {
    if (customDraftChoiceRef.current !== customDraftChoice || !canCopyCustomFood(food)) return;
    if (
      customBaseline.current &&
      JSON.stringify(customRef.current) === JSON.stringify(customBaseline.current)
    ) {
      installCustomDraft(food, action);
      return;
    }
    const choice = { action, food, draft: customRef.current, generation: customGeneration.current };
    customDraftChoiceRef.current = choice;
    setCustomDraftChoice(choice);
  }
  function resolveCustomDraftChoice(discard: boolean) {
    if (
      !customDraftChoice ||
      customDraftChoiceRef.current !== customDraftChoice ||
      customDraftChoice.draft !== customRef.current ||
      customDraftChoice.generation !== customGeneration.current ||
      !canCopyCustomFood(customDraftChoice.food)
    )
      return;
    if (discard) installCustomDraft(customDraftChoice.food, customDraftChoice.action);
    else clearCustomDraftChoice();
  }
  function cancelCustomEdit() {
    if (!canUseCustomControls() || customWrite.current !== null) return;
    replaceCustom(blankCustom(nutrients[0]?.nutrientId ?? ""));
  }
  useEffect(() => {
    if (customDraftChoice) customKeepButton.current?.focus();
  }, [customDraftChoice]);

  const closeFoodDetails = useCallback(() => {
    disclosureGeneration.current += 1;
    disclosureVersions.current.clear();
    expandedFoodsRef.current = new Set();
    setExpandedFoods(expandedFoodsRef.current);
  }, []);

  const resetSavedFoodFilter = useCallback(() => {
    savedFoodFilterGeneration.current += 1;
    savedFoodFilterRef.current = "";
    setSavedFoodFilter("");
  }, []);

  const setSession = useCallback(
    (next: SessionSummary | null) => {
      if (installedSession.current !== next) {
        closeFoodDetails();
        invalidateCustomControls();
        savedFoodFilterGeneration.current += 1;
      }
      if (next !== null) {
        const nextScope = JSON.stringify([next.user.id, next.profile]);
        if (savedFoodFilterScope.current !== nextScope) {
          resetSavedFoodFilter();
          nutrientRegistry.current = null;
        }
        savedFoodFilterScope.current = nextScope;
      }
      installedSession.current = next;
      setSessionState(next);
    },
    [closeFoodDetails, invalidateCustomControls, resetSavedFoodFilter],
  );
  const installCustomFoods = useCallback(
    (
      update: readonly CustomFood[] | ((items: readonly CustomFood[]) => readonly CustomFood[]),
      generation: number,
      expectedOwner: string | null,
    ) => {
      if (
        !mounted.current ||
        privateUiClosed.current ||
        foodListGeneration.current !== generation ||
        expectedOwner === null ||
        ownerUserId.current !== expectedOwner ||
        installedSession.current?.user.id !== expectedOwner
      )
        return false;
      const next = typeof update === "function" ? update(installedFoods.current) : update;
      installedFoods.current = next;
      expandedFoodsRef.current = new Set(
        [...expandedFoodsRef.current].filter((food) => next.includes(food)),
      );
      for (const food of disclosureVersions.current.keys()) {
        if (!next.includes(food)) disclosureVersions.current.delete(food);
      }
      setExpandedFoods(expandedFoodsRef.current);
      setCustomFoods(next);
      return true;
    },
    [],
  );

  function canInspectFood(food: CustomFood, version: number): boolean {
    return (
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      foodDetailsReady.current &&
      installedSession.current === session &&
      session !== null &&
      ownerUserId.current === session.user.id &&
      disclosureGeneration.current === renderedDisclosureGeneration &&
      installedFoods.current.includes(food) &&
      (disclosureVersions.current.get(food) ?? 0) === version
    );
  }

  function toggleFoodDetails(food: CustomFood, version: number) {
    if (!canInspectFood(food, version)) return;
    disclosureVersions.current.set(food, version + 1);
    const next = new Set(expandedFoodsRef.current);
    if (next.has(food)) next.delete(food);
    else next.add(food);
    expandedFoodsRef.current = next;
    setExpandedFoods(next);
  }

  const signInAgain = useCallback(() => {
    privateUiClosed.current = true;
    activeLog.current = null;
    customLifecycle.current += 1;
    customWrite.current = null;
    setCustomSaving(false);
    invalidateCustomControls();
    resetSavedFoodFilter();
    savedFoodFilterScope.current = null;
    setVerifiedFoodListOwner(null);
    foodListGeneration.current += 1;
    foodDetailsReady.current = false;
    installedFoods.current = [];
    closeFoodDetails();
    loadController.current?.abort();
    for (const controller of privateReadControllers.current) controller.abort();
    privateReadControllers.current.clear();
    profileRefreshController.current?.abort();
    ownerUserId.current = null;
    operations.current.clear();
    setSession(null);
    nutrientRegistry.current = null;
    setNutrients([]);
    setCustomFoods([]);
    setCustomFoodCursor(null);
    replaceCustom(blankCustom(""));
    replaceCustomLog(null);
    setCustomLogDateReviewRequired(false);
    setBusy(null);
    setState("loading");
    setMessage("Closing your personal foods…");
    router.replace("/login");
    router.refresh();
  }, [
    closeFoodDetails,
    invalidateCustomControls,
    replaceCustom,
    replaceCustomLog,
    resetSavedFoodFilter,
    router,
    setSession,
  ]);
  const revalidateFoodSession = useCallback(async (signal: AbortSignal) => {
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
        readonly signal?: AbortSignal;
      } = {},
    ) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.key) headers["idempotency-key"] = operation(input.key);
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
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
          responseError(body, "The personal-food request failed."),
          response.status,
          body,
        );
      return body;
    },
    [operation, signInAgain],
  );

  const loadFoods = useCallback(async () => {
    if (
      privateUiClosed.current ||
      !mounted.current ||
      (loadController.current && !loadController.current.signal.aborted)
    )
      return;
    const controller = new AbortController();
    loadController.current = controller;
    privateReadControllers.current.add(controller);
    const generation = ++foodListGeneration.current;
    const receiptOverlay = {
      controller,
      generation,
      owner: ownerUserId.current,
      foods: new Map<string, CustomFood>(),
    };
    customLoadReceipts.current = receiptOverlay;
    const current = () =>
      !controller.signal.aborted &&
      !privateUiClosed.current &&
      mounted.current &&
      loadController.current === controller;
    nutrientRegistry.current = null;
    invalidateCustomControls();
    setVerifiedFoodListOwner(null);
    foodDetailsReady.current = false;
    closeFoodDetails();
    setState("loading");
    try {
      const nextSession = await revalidateFoodSession(controller.signal);
      controller.signal.throwIfAborted();
      if (ownerUserId.current !== null && ownerUserId.current !== nextSession.user.id)
        throw new PrivateOwnerFenceError();
      const read = async (path: string) => {
        const response = await fetch(path, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          if (current()) signInAgain();
          throw new PrivateOwnerFenceError();
        }
        const value = await json(response);
        if (!response.ok)
          throw new Error(responseError(value, "Your personal foods could not be loaded."));
        return value;
      };
      await installPrivateDataForOwner({
        expectedOwnerUserId: nextSession.user.id,
        signal: controller.signal,
        loadPrivateData: async () => {
          const [nutrientBody, customBody] = await Promise.all([
            read("/api/nutrients/targetable"),
            read("/api/retention/custom-foods?limit=50"),
          ]);
          return {
            nutrients: parseTargetableNutrients(nutrientBody),
            customPage: parseCustomFoodList(customBody),
          };
        },
        revalidateSession: () => revalidateFoodSession(controller.signal),
        install: (data, currentSession) => {
          if (!current()) return;
          if (ownerUserId.current !== null && ownerUserId.current !== nextSession.user.id)
            throw new PrivateOwnerFenceError();
          ownerUserId.current = nextSession.user.id;
          setSession(currentSession);
          setNutrients(data.nutrients);
          const accepted =
            customLoadReceipts.current === receiptOverlay &&
            receiptOverlay.owner === nextSession.user.id
              ? [...receiptOverlay.foods.values()]
              : [];
          const customItems = accepted.reduce<readonly CustomFood[]>(
            mergeAcceptedCustomFood,
            data.customPage.items,
          );
          if (!installCustomFoods(customItems, generation, nextSession.user.id)) return;
          nutrientRegistry.current = {
            values: data.nutrients,
            scope: JSON.stringify([currentSession.user.id, currentSession.profile]),
          };
          foodDetailsReady.current = true;
          setVerifiedFoodListOwner(nextSession.user.id);
          setCustomFoodCursor(data.customPage.nextCursor);
          if (!customInitialized.current) {
            customInitialized.current = true;
            const value = customRef.current;
            if (
              value.id === null &&
              value.nutrients.length === 0 &&
              !value.name &&
              !value.brandName &&
              !value.servingLabel &&
              !value.servingGrams &&
              !value.notes
            )
              replaceCustom(blankCustom(data.nutrients[0]?.nutrientId ?? ""));
          }
          setState("ready");
          setMessage("Your personal foods are current.");
        },
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof PrivateOwnerFenceError) return signInAgain();
      setState("error");
      setMessage(
        error instanceof Error ? error.message : "Your personal foods could not be loaded.",
      );
    } finally {
      privateReadControllers.current.delete(controller);
      if (loadController.current === controller) loadController.current = null;
      if (customLoadReceipts.current === receiptOverlay) customLoadReceipts.current = null;
    }
  }, [
    closeFoodDetails,
    installCustomFoods,
    invalidateCustomControls,
    replaceCustom,
    revalidateFoodSession,
    setSession,
    signInAgain,
  ]);
  async function loadMoreCustomFoods() {
    if (!customFoodCursor) return;
    const initiatingOwnerUserId = ownerUserId.current;
    if (initiatingOwnerUserId === null || privateUiClosed.current) return;
    const controller = new AbortController();
    privateReadControllers.current.add(controller);
    setBusy("custom-more");
    try {
      await installPrivateDataForOwner({
        expectedOwnerUserId: initiatingOwnerUserId,
        signal: controller.signal,
        loadPrivateData: async () =>
          parseCustomFoodList(
            await request(`custom-foods?limit=50&cursor=${encodeURIComponent(customFoodCursor)}`, {
              signal: controller.signal,
            }),
          ),
        revalidateSession: () => revalidateFoodSession(controller.signal),
        install: (page) => {
          if (privateUiClosed.current || ownerUserId.current !== initiatingOwnerUserId) {
            throw new PrivateOwnerFenceError();
          }
          if (
            !installCustomFoods(
              (items) => [
                ...items,
                ...page.items.filter((food) => !items.some((existing) => existing.id === food.id)),
              ],
              renderedListGeneration,
              initiatingOwnerUserId,
            )
          )
            return;
          setCustomFoodCursor(page.nextCursor);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof PrivateOwnerFenceError) return signInAgain();
      setMessage(error instanceof Error ? error.message : "More custom foods could not be loaded.");
    } finally {
      privateReadControllers.current.delete(controller);
      if (!privateUiClosed.current) setBusy(null);
    }
  }
  useEffect(() => {
    mounted.current = true;
    setCustomSaving(false);
    visible.current = typeof document === "undefined" || document.visibilityState !== "hidden";
    const visibilityChanged = () => {
      visible.current = document.visibilityState !== "hidden";
      activeLog.current = null;
      customLogGeneration.current += 1;
      setBusy((current) => (current === "custom-log" ? null : current));
      customLifecycle.current += 1;
      customWrite.current = null;
      setCustomSaving(false);
      invalidateCustomControls();
      savedFoodFilterGeneration.current += 1;
      closeFoodDetails();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visibilityChanged);
    void loadFoods();
    return () => {
      mounted.current = false;
      activeLog.current = null;
      customLogGeneration.current += 1;
      customLifecycle.current += 1;
      customControlGeneration.current += 1;
      customDraftChoiceRef.current = null;
      customWrite.current = null;
      savedFoodFilterGeneration.current += 1;
      foodListGeneration.current += 1;
      foodDetailsReady.current = false;
      disclosureGeneration.current += 1;
      disclosureVersions.current.clear();
      expandedFoodsRef.current = new Set();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibilityChanged);
      loadController.current?.abort();
      for (const controller of privateReadControllers.current) controller.abort();
      privateReadControllers.current.clear();
      profileRefreshController.current?.abort();
    };
  }, [closeFoodDetails, invalidateCustomControls, loadFoods]);
  async function refreshCustomLogProfileAfterTimeZoneChange(
    initiatingUserId: string,
  ): Promise<string | null> {
    profileRefreshController.current?.abort();
    const controller = new AbortController();
    profileRefreshController.current = controller;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        signInAgain();
        return null;
      }
      if (!response.ok) return null;
      const nextSession = parseSession(await json(response));
      if (controller.signal.aborted || privateUiClosed.current) return null;
      if (
        ownerUserId.current !== initiatingUserId ||
        !customFoodProfileRefreshBelongsToOwner(initiatingUserId, nextSession.user.id)
      ) {
        signInAgain();
        return null;
      }
      setSession(nextSession);
      return nextSession.profile.timeZone;
    } catch {
      return null;
    } finally {
      if (profileRefreshController.current === controller) profileRefreshController.current = null;
    }
  }

  async function saveCustomFood() {
    if (!canUseCustomControls() || !session || customWrite.current !== null) return;
    clearCustomDraftChoice();
    if (!custom.name.trim() || custom.nutrients.length < 1)
      return setMessage("Enter a name and at least one nutrient.");
    if (
      new Set(custom.nutrients.map((nutrient) => nutrient.nutrientId)).size !==
      custom.nutrients.length
    ) {
      return setMessage("Each nutrient can appear only once in a custom food.");
    }
    if (
      (custom.servingLabel.trim() || custom.servingGrams.trim()) &&
      (!custom.servingLabel.trim() || !isPositiveInputDecimal(custom.servingGrams))
    ) {
      return setMessage("A serving needs both a label and positive grams.");
    }
    for (const nutrient of custom.nutrients) {
      if (
        nutrient.state === "quantified" &&
        (nutrient.amountPer100Grams.length > 200 ||
          !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(nutrient.amountPer100Grams))
      ) {
        return setMessage("Enter zero or a positive decimal for each measured nutrient per 100 g.");
      }
    }
    const body = {
      name: custom.name.trim(),
      brandName: custom.brandName.trim() || null,
      serving: custom.servingLabel.trim()
        ? { label: custom.servingLabel.trim(), grams: custom.servingGrams }
        : null,
      nutrients: custom.nutrients,
      notes: custom.notes.trim() || null,
    };
    const path = custom.id ? `custom-foods/${custom.id}/revisions` : "custom-foods";
    const key = `custom:${custom.id ?? `new:${customCreateIntent.current}`}:${custom.revision ?? "0"}:${JSON.stringify(body)}`;
    const token = {};
    const initiatingScope = customScope;
    const lifecycle = customLifecycle.current;
    const generation = customGeneration.current;
    const initiatingOwner = session.user.id;
    customWrite.current = token;
    setCustomSaving(true);
    const ownsWrite = () =>
      mounted.current &&
      !privateUiClosed.current &&
      customWrite.current === token &&
      customLifecycle.current === lifecycle &&
      ownerUserId.current === initiatingOwner &&
      installedSession.current !== null &&
      JSON.stringify([installedSession.current.user.id, installedSession.current.profile]) ===
        initiatingScope;
    const isCurrent = () =>
      ownsWrite() &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      customGeneration.current === generation &&
      customRef.current === custom;
    try {
      const response = await fetch(`/api/retention/${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation(key),
          ...(custom.revision ? { "if-match": quoteRevision(custom.revision) } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!isCurrent()) return;
      if (response.status === 401) return signInAgain();
      const value = await json(response);
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(responseError(value, "The personal-food request failed."));
      const saved = parseCustomFoodMutation(value);
      operations.current.delete(key);
      const overlay = customLoadReceipts.current;
      if (
        overlay &&
        overlay.controller === loadController.current &&
        !overlay.controller.signal.aborted &&
        overlay.generation === foodListGeneration.current &&
        overlay.owner === initiatingOwner
      ) {
        const current = installedFoods.current.find((item) => item.id === saved.id);
        const retained =
          current && BigInt(current.revision) > BigInt(saved.revision) ? current : saved;
        overlay.foods.delete(saved.id);
        overlay.foods.set(saved.id, retained);
      }
      installCustomFoods(
        (items) => mergeAcceptedCustomFood(items, saved),
        foodListGeneration.current,
        initiatingOwner,
      );
      replaceCustom(blankCustom(nutrients[0]?.nutrientId ?? ""));
      setMessage(`Saved private custom food version ${saved.currentVersion.versionNumber}.`);
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(
        `${error instanceof Error ? error.message : "Custom food could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      if (customWrite.current === token) {
        customWrite.current = null;
        if (mounted.current && !privateUiClosed.current) setCustomSaving(false);
      }
    }
  }

  async function archiveCustomFood(food: CustomFood) {
    if (
      !window.confirm(
        `Archive ${food.currentVersion.name}? Historical diary entries keep their pinned version.`,
      )
    )
      return;
    const key = `custom-archive:${food.id}:${food.revision}`;
    setBusy(`custom:${food.id}`);
    try {
      const archived = parseCustomFoodMutation(
        await request(`custom-foods/${food.id}`, {
          method: "DELETE",
          key,
          revision: food.revision,
        }),
      );
      operations.current.delete(key);
      installCustomFoods(
        (items) => items.map((item) => (item.id === archived.id ? archived : item)),
        renderedListGeneration,
        session?.user.id ?? null,
      );
      setMessage("Custom food archived; pinned diary history was preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Custom food could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  async function logCustomFood() {
    if (!canUseCustomLogControls() || activeLog.current !== null) return;
    if (customLogDateReviewRequired) {
      return setMessage("Review and confirm the local diary day before logging again.");
    }
    if (!session || !customLog || !isPositiveInputDecimal(customLog.quantity)) {
      return setMessage("Choose a private food and enter a positive quantity.");
    }
    const initiatingOwnerUserId = session.user.id;
    const serving = customLog.food.currentVersion.serving;
    if (customLog.kind === "serving" && !serving)
      return setMessage("This food has no serving definition.");
    let occurredAt: string;
    try {
      occurredAt = localDateTimeToInstant(
        customLog.localDate,
        customLog.localTime,
        session.profile.timeZone,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enter a valid diary date and time.");
      return;
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
    const key = `custom-log:${customLog.food.id}:${customLog.food.currentVersion.id}:${session.profile.timeZone}:${JSON.stringify(body)}`;
    const exactOperationId = operation(key);
    const token = {};
    const lifecycle = customLifecycle.current;
    const generation = customLogGeneration.current;
    const initiatingScope = JSON.stringify([session.user.id, session.profile]);
    activeLog.current = token;
    const ownsLog = () =>
      mounted.current &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      !privateUiClosed.current &&
      activeLog.current === token &&
      customLifecycle.current === lifecycle &&
      ownerUserId.current === initiatingOwnerUserId &&
      installedSession.current !== null &&
      JSON.stringify([installedSession.current.user.id, installedSession.current.profile]) ===
        initiatingScope;
    const ownsDraft = () =>
      ownsLog() &&
      customLogRef.current === customLog &&
      customLogGeneration.current === generation &&
      routeDestination.current === renderedRouteDestination;
    setBusy("custom-log");
    try {
      const response = await fetch(
        `/api/retention/custom-foods/${customLog.food.id}/log?profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": exactOperationId,
            "x-expected-profile-time-zone": session.profile.timeZone,
          },
          body: JSON.stringify(body),
          cache: "no-store",
        },
      );
      if (!ownsLog()) return;
      if (response.status === 401) {
        if (ownsDraft()) signInAgain();
        return;
      }
      const value = await json(response);
      if (!ownsLog()) return;
      if (!response.ok)
        throw new PrivateRequestFailure(
          responseError(value, "The personal-food request failed."),
          response.status,
          value,
        );
      const mutation = parseDiaryMutation(value);
      if (!ownsDraft()) return;
      if (operations.current.get(key) === exactOperationId) operations.current.delete(key);
      replaceCustomLog(null);
      setMessage(
        `Pinned private food version logged to ${diaryGroupLabel(diaryGroups, customLog.mealSlot)} on ${mutation.entry?.localDate ?? customLog.localDate}.`,
      );
    } catch (error) {
      if (!ownsLog()) return;
      if (
        error instanceof PrivateRequestFailure &&
        fenceCustomFoodLogForTimeZoneChange(
          operations.current,
          key,
          exactOperationId,
          error.status,
          error.body,
        )
      ) {
        setCustomLogDateReviewRequired(true);
        setSession(null);
        const currentTimeZone =
          await refreshCustomLogProfileAfterTimeZoneChange(initiatingOwnerUserId);
        if (!mounted.current || privateUiClosed.current || activeLog.current !== token) return;
        setMessage(
          customFoodLogTimeZoneReviewMessage(
            customLogRef.current?.localDate ?? customLog.localDate,
            currentTimeZone,
          ),
        );
        return;
      }
      if (!ownsDraft()) return;
      setMessage(
        `${error instanceof Error ? error.message : "Private food could not be logged."} Submit again to retry the exact version safely.`,
      );
    } finally {
      if (activeLog.current === token) {
        activeLog.current = null;
        if (mounted.current && !privateUiClosed.current)
          setBusy((current) => (current === "custom-log" ? null : current));
      }
    }
  }

  function confirmCustomFoodLogDateReview() {
    if (!canUseCustomLogControls() || activeLog.current !== null) return;
    if (!session || !customLog) {
      setMessage(
        "Current account settings are unavailable. Refresh this page before confirming a local diary day.",
      );
      return;
    }
    setCustomLogDateReviewRequired(false);
    setMessage(
      `${customLog.localDate} is confirmed as a local diary day in ${session.profile.timeZone}. Submit when ready.`,
    );
  }
  const savedFilterScopeReady =
    customInitialized.current &&
    mounted.current &&
    visible.current &&
    (typeof document === "undefined" || document.visibilityState !== "hidden") &&
    !privateUiClosed.current &&
    session !== null &&
    installedSession.current === session &&
    ownerUserId.current === session.user.id &&
    savedFoodFilterScope.current === JSON.stringify([session.user.id, session.profile]);
  const foodListVerified = savedFilterScopeReady && verifiedFoodListOwner === session?.user.id;
  const savedFilterValue = savedFilterScopeReady ? savedFoodFilter : "";
  const normalizedSavedFilter = savedFilterValue.trim().toLowerCase();
  const visibleSavedFoods = savedFilterScopeReady
    ? customFoods.filter((food) =>
        food.currentVersion.name.toLowerCase().includes(normalizedSavedFilter),
      )
    : [];

  function changeSavedFoodFilter(value: string) {
    if (
      !savedFilterScopeReady ||
      !mounted.current ||
      !visible.current ||
      (typeof document !== "undefined" && document.visibilityState === "hidden") ||
      privateUiClosed.current ||
      installedSession.current !== session ||
      ownerUserId.current !== session?.user.id ||
      savedFoodFilterGeneration.current !== renderedFilterGeneration ||
      savedFoodFilterRef.current !== savedFoodFilter
    )
      return;
    const bounded = value.slice(0, 200);
    if (bounded === savedFoodFilterRef.current) return;
    savedFoodFilterGeneration.current += 1;
    savedFoodFilterRef.current = bounded;
    setSavedFoodFilter(bounded);
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
        <AppNavigation active="foods" date={validatedDate} />
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
            <p className="wellnessNote">Wellness information only, not medical advice.</p>
          </div>
        </details>
      </aside>
      <section className="dashboard customFoodsDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">Your food library</p>
            <h1>My foods</h1>
          </div>
          <span className="statusPill">Private to you</span>
        </header>
        <FoodsNavigation active="custom" date={validatedDate} meal={validatedMeal} />
        <p className="foodPageIntro">
          Save foods you use often, enter their nutrition information, and add a saved version to
          your diary.
        </p>
        <p className={`diaryStatus diaryStatus--${state}`} role="status" aria-live="polite">
          {message}
        </p>
        {state === "error" ? (
          <button className="secondaryAction" onClick={() => void loadFoods()} type="button">
            Retry private data
          </button>
        ) : null}
        <section className="retentionSection" aria-label="Personal food library">
          <p className="fieldHelp">
            Enter nutrients per 100 g. Changing a food won’t change past diary entries.
          </p>
          <div className="retentionColumns customFoodsWorkspace">
            <form
              className="retentionForm customFoodEditor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveCustomFood();
              }}
            >
              <h2>{custom.id ? "Revise food" : "New food"}</h2>
              {customSource && !custom.id && canUseCustomControls() ? (
                <p className="fieldHelp" aria-live="polite">
                  New draft copied from saved {customSource.currentVersion.name} v
                  {customSource.currentVersion.versionNumber}. Create to save a separate private
                  food.
                </p>
              ) : null}
              {customDraftChoice &&
              customDraftChoiceRef.current === customDraftChoice &&
              canCopyCustomFood(customDraftChoice.food) ? (
                <fieldset aria-labelledby="custom-draft-choice">
                  <p id="custom-draft-choice" aria-live="polite">
                    This editor has an unsaved draft. Keep editing, or discard it and{" "}
                    {customDraftChoice.action === "copy" ? "copy" : "revise"} saved{" "}
                    {customDraftChoice.food.currentVersion.name} v
                    {customDraftChoice.food.currentVersion.versionNumber}.
                  </p>
                  <button
                    ref={customKeepButton}
                    onClick={() => resolveCustomDraftChoice(false)}
                    type="button"
                  >
                    Keep editing
                  </button>
                  <button onClick={() => resolveCustomDraftChoice(true)} type="button">
                    {customDraftChoice.action === "copy"
                      ? "Discard draft and copy saved version"
                      : "Discard draft and revise"}
                  </button>
                </fieldset>
              ) : null}
              <label>
                Name
                <input
                  maxLength={500}
                  ref={customNameInput}
                  value={custom.name}
                  onChange={(event) => setCustom({ ...custom, name: event.target.value })}
                />
              </label>
              <label>
                Brand (optional)
                <input
                  maxLength={300}
                  value={custom.brandName}
                  onChange={(event) => setCustom({ ...custom, brandName: event.target.value })}
                />
              </label>
              <div className="inlineFields">
                <label>
                  Serving label
                  <input
                    maxLength={200}
                    value={custom.servingLabel}
                    onChange={(event) => setCustom({ ...custom, servingLabel: event.target.value })}
                  />
                </label>
                <label>
                  Serving grams
                  <input
                    inputMode="decimal"
                    maxLength={19}
                    value={custom.servingGrams}
                    onChange={(event) => setCustom({ ...custom, servingGrams: event.target.value })}
                  />
                </label>
              </div>
              <fieldset>
                <legend>Nutrients per 100 g</legend>
                {custom.nutrients.map((row, index) => (
                  <div className="nutrientDraftRow" key={row.nutrientId}>
                    <select
                      aria-label={`Nutrient ${index + 1}`}
                      value={row.nutrientId}
                      onChange={(event) => changeCustomNutrient(index, event.target.value)}
                    >
                      {!nutrients.some((item) => item.nutrientId === row.nutrientId) ? (
                        <option value={row.nutrientId}>
                          {(() => {
                            const saved = customSource?.currentVersion.nutrients.find(
                              (item) => item.nutrient.id === row.nutrientId,
                            )?.nutrient;
                            return saved
                              ? `${saved.name} (${saved.unit}) · saved nutrient`
                              : `Nutrient ${row.nutrientId}`;
                          })()}
                        </option>
                      ) : null}
                      {nutrients.map((item) => {
                        const usedElsewhere =
                          item.nutrientId !== row.nutrientId &&
                          custom.nutrients.some(
                            (other, rowIndex) =>
                              rowIndex !== index && other.nutrientId === item.nutrientId,
                          );
                        return (
                          <option
                            key={item.nutrientId}
                            value={item.nutrientId}
                            disabled={usedElsewhere}
                          >
                            {item.name} ({item.unit})
                            {usedElsewhere ? " · already in this draft" : ""}
                          </option>
                        );
                      })}
                    </select>
                    <select
                      aria-label={`Nutrient state ${index + 1}`}
                      value={row.state}
                      onChange={(event) => {
                        const stateValue = event.target.value;
                        setCustom({
                          ...custom,
                          nutrients: custom.nutrients.map((item, rowIndex) =>
                            rowIndex !== index
                              ? item
                              : stateValue === "quantified"
                                ? {
                                    nutrientId: item.nutrientId,
                                    state: "quantified",
                                    amountPer100Grams: "0",
                                  }
                                : stateValue === "trace"
                                  ? {
                                      nutrientId: item.nutrientId,
                                      state: "trace",
                                      amountPer100Grams: null,
                                    }
                                  : {
                                      nutrientId: item.nutrientId,
                                      state: "unknown",
                                      amountPer100Grams: null,
                                      reason: "not_reported",
                                    },
                          ),
                        });
                      }}
                    >
                      <option value="quantified">Quantified</option>
                      <option value="trace">Trace</option>
                      <option value="unknown">Unknown</option>
                    </select>
                    {row.state === "quantified" ? (
                      <input
                        aria-label={`Amount per 100 grams ${index + 1}`}
                        inputMode="decimal"
                        value={row.amountPer100Grams}
                        onChange={(event) =>
                          setCustom({
                            ...custom,
                            nutrients: custom.nutrients.map((item, rowIndex) =>
                              rowIndex === index && item.state === "quantified"
                                ? { ...item, amountPer100Grams: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    ) : row.state === "unknown" ? (
                      <select
                        aria-label={`Unknown reason ${index + 1}`}
                        value={row.reason}
                        onChange={(event) =>
                          setCustom({
                            ...custom,
                            nutrients: custom.nutrients.map((item, rowIndex) =>
                              rowIndex === index && item.state === "unknown"
                                ? {
                                    ...item,
                                    reason: event.target.value as
                                      | "not_reported"
                                      | "not_analyzed"
                                      | "not_applicable"
                                      | "withheld",
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="not_reported">Not reported</option>
                        <option value="not_analyzed">Not analyzed</option>
                        <option value="not_applicable">Not applicable</option>
                        <option value="withheld">Withheld</option>
                      </select>
                    ) : (
                      <span>Trace amount</span>
                    )}
                    <button
                      aria-label={`Remove nutrient ${index + 1}`}
                      onClick={() =>
                        setCustom({
                          ...custom,
                          nutrients: custom.nutrients.filter((_, rowIndex) => rowIndex !== index),
                        })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  disabled={!nextCustomNutrient}
                  aria-describedby="custom-nutrient-availability"
                  onClick={addCustomNutrient}
                  type="button"
                >
                  Add nutrient
                </button>
                <p className="finePrint" id="custom-nutrient-availability" aria-live="polite">
                  {!customNutrientMetadataReady
                    ? "The nutrient list is not available right now."
                    : nutrients.length === 0
                      ? "No nutrients are available in the loaded list."
                      : !nextCustomNutrient
                        ? "All loaded nutrients are already in this draft. Remove a row to add that nutrient again."
                        : "Add the next unused nutrient from the loaded list."}
                </p>
              </fieldset>
              <label>
                Notes (optional)
                <textarea
                  maxLength={2000}
                  value={custom.notes}
                  onChange={(event) => setCustom({ ...custom, notes: event.target.value })}
                />
              </label>
              <div className="entryActions">
                <button
                  disabled={customSaving || !canUseCustomControls() || !session}
                  type="submit"
                >
                  {customSaving
                    ? "Saving…"
                    : custom.id
                      ? "Save new version"
                      : "Create private food"}
                </button>
                {custom.id ? (
                  <button
                    disabled={customSaving || !canUseCustomControls()}
                    onClick={cancelCustomEdit}
                    type="button"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
            <div className="customFoodLibrary">
              <h2>Saved foods</h2>
              <label className="formField" htmlFor="saved-food-filter">
                <span>Filter loaded saved foods by name</span>
                <input
                  id="saved-food-filter"
                  type="search"
                  maxLength={200}
                  disabled={!savedFilterScopeReady}
                  aria-describedby="saved-food-filter-status"
                  value={savedFilterValue}
                  onChange={(event) => changeSavedFoodFilter(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!savedFilterScopeReady || savedFilterValue === ""}
                onClick={() => changeSavedFoodFilter("")}
              >
                Clear saved-food filter
              </button>
              <p className="fieldHelp" id="saved-food-filter-status" aria-live="polite">
                {foodListVerified ? (
                  <>
                    {visibleSavedFoods.length} of {customFoods.length} loaded saved foods match.
                    {customFoods.length === 0
                      ? customFoodCursor
                        ? " No saved foods are loaded yet."
                        : " No saved foods were returned in this listing."
                      : normalizedSavedFilter && visibleSavedFoods.length === 0
                        ? " No loaded saved foods match this name."
                        : ""}
                    {customFoodCursor
                      ? " More records may be available. Load more to include them."
                      : " No more records in this listing."}
                  </>
                ) : state === "loading" ? (
                  "Saved-food listing is loading."
                ) : (
                  "Saved-food listing is unavailable."
                )}
              </p>
              <ul className="recordList">
                {visibleSavedFoods.map((food) => {
                  const disclosureVersion = disclosureVersions.current.get(food) ?? 0;
                  const canInspect = canInspectFood(food, disclosureVersion);
                  const expanded = canInspect && expandedFoods.has(food);
                  const detailsId = `saved-food-nutrients-${food.id}-${food.currentVersion.id}`;
                  return (
                    <li
                      key={food.id}
                      style={{ flexWrap: "wrap", minWidth: 0, overflowWrap: "anywhere" }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <strong>{food.currentVersion.name}</strong>
                        <small>
                          v{food.currentVersion.versionNumber} · {food.status} · private
                          user-entered data
                        </small>
                      </div>
                      <div className="entryActions">
                        <button
                          aria-controls={detailsId}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Hide" : "Show"} nutrients for ${food.currentVersion.name} v${food.currentVersion.versionNumber}`}
                          disabled={!canInspect}
                          onClick={() => toggleFoodDetails(food, disclosureVersion)}
                          type="button"
                        >
                          {expanded ? "Hide nutrients" : "Show nutrients"}
                        </button>
                        <button
                          disabled={!canCopyCustomFood(food)}
                          onClick={() => requestCustomDraftChoice(food, "revise")}
                          type="button"
                        >
                          Revise
                        </button>
                        <button
                          disabled={!canCopyCustomFood(food)}
                          onClick={() => requestCustomDraftChoice(food, "copy")}
                          aria-label={`Copy ${food.currentVersion.name} v${food.currentVersion.versionNumber} to new draft`}
                          type="button"
                        >
                          Copy to new draft
                        </button>
                        {food.status === "active" ? (
                          <>
                            <button
                              disabled={!session}
                              onClick={() => {
                                if (routeDestination.current !== renderedRouteDestination) return;
                                if (!session) {
                                  setMessage("Refresh current account settings before logging.");
                                  return;
                                }
                                const now = new Date();
                                setCustomLog({
                                  food,
                                  kind: food.currentVersion.serving ? "serving" : "grams",
                                  quantity: "1",
                                  mealSlot: validatedMeal ?? "snacks",
                                  localDate:
                                    validatedDate ??
                                    localDateInTimeZone(now, session.profile.timeZone),
                                  localTime: localTimeInTimeZone(
                                    now,
                                    session.profile.timeZone,
                                  ).slice(0, 5),
                                });
                              }}
                              type="button"
                            >
                              Log pinned v{food.currentVersion.versionNumber}
                            </button>
                            <button
                              className="dangerAction"
                              disabled={busy === `custom:${food.id}`}
                              onClick={() => void archiveCustomFood(food)}
                              type="button"
                            >
                              Archive
                            </button>
                          </>
                        ) : null}
                      </div>
                      <div
                        id={detailsId}
                        hidden={!expanded}
                        style={{ flexBasis: "100%", minWidth: 0 }}
                      >
                        {expanded ? (
                          <>
                            <p>
                              Saved {food.currentVersion.name} v{food.currentVersion.versionNumber}{" "}
                              · Nutrients per 100 g
                            </p>
                            <dl style={{ margin: 0 }}>
                              {food.currentVersion.nutrients.map((snapshot) => (
                                <div
                                  key={snapshot.nutrient.id}
                                  style={{ marginBlock: "12px", overflowWrap: "anywhere" }}
                                >
                                  <dt>
                                    {snapshot.nutrient.name} ({snapshot.nutrient.unit})
                                  </dt>
                                  <dd style={{ marginInlineStart: 0 }}>
                                    {snapshot.state === "quantified"
                                      ? formatNutrientAmount(
                                          snapshot.amountPer100Grams,
                                          snapshot.nutrient.unit,
                                        )
                                      : snapshot.state === "trace"
                                        ? "Trace"
                                        : `Unknown — ${unknownNutrientReasons[snapshot.reason]}`}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {savedFilterScopeReady && customFoodCursor ? (
                <button
                  disabled={busy === "custom-more"}
                  onClick={() => void loadMoreCustomFoods()}
                  type="button"
                >
                  Load more private foods
                </button>
              ) : null}
              {customLog ? (
                <form
                  className="retentionForm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void logCustomFood();
                  }}
                >
                  <h3>
                    Log {customLog.food.currentVersion.name} v
                    {customLog.food.currentVersion.versionNumber}
                  </h3>
                  <div className="inlineFields">
                    <label>
                      Portion
                      <select
                        disabled={!canUseCustomLogControls()}
                        value={customLog.kind}
                        onChange={(event) =>
                          setCustomLog({
                            ...customLog,
                            kind: event.target.value as "serving" | "grams",
                          })
                        }
                      >
                        <option value="grams">Grams</option>
                        {customLog.food.currentVersion.serving ? (
                          <option value="serving">
                            {customLog.food.currentVersion.serving.label}
                          </option>
                        ) : null}
                      </select>
                    </label>
                    <label>
                      Exact quantity
                      <input
                        disabled={!canUseCustomLogControls()}
                        inputMode="decimal"
                        value={customLog.quantity}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, quantity: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Meal
                      <select
                        disabled={!canUseCustomLogControls()}
                        value={customLog.mealSlot}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, mealSlot: event.target.value as MealSlot })
                        }
                      >
                        {diaryGroups.map((group) => (
                          <option key={group.mealSlot} value={group.mealSlot}>
                            {group.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Local date
                      <input
                        disabled={!canUseCustomLogControls()}
                        type="date"
                        value={customLog.localDate}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, localDate: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Local time
                      <input
                        disabled={!canUseCustomLogControls()}
                        type="time"
                        value={customLog.localTime}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, localTime: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <small>
                    Uses {session?.profile.timeZone ?? "your verified profile zone"} local time.
                    This entry keeps the saved nutrition even if you revise the food later.
                  </small>
                  <div className="entryActions">
                    {customLogDateReviewRequired ? (
                      <button
                        disabled={!canUseCustomLogControls() || activeLog.current !== null}
                        onClick={confirmCustomFoodLogDateReview}
                        type="button"
                      >
                        Confirm {customLog.localDate} as local day
                      </button>
                    ) : null}
                    <button
                      disabled={
                        !canUseCustomLogControls() ||
                        activeLog.current !== null ||
                        customLogDateReviewRequired
                      }
                      type="submit"
                    >
                      Log exact version
                    </button>
                    <button
                      disabled={!canUseCustomLogControls()}
                      onClick={() => setCustomLog(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>
        </section>
      </section>
    </>
  );
}
