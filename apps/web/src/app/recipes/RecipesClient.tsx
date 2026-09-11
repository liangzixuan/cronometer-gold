"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createOperationId,
  type DiaryGroup,
  defaultDiaryGroups,
  defaultMealForTime,
  diaryGroupLabel,
  isLocalDate,
  localDateInTimeZone,
  type MealSlot,
  nutrientDisplay,
  parseDiaryMutation,
  parseSession,
  type SessionSummary,
} from "../../lib/diary";
import {
  buildSearchRequestPath,
  type FoodSearchHit,
  parseFoodSearchPage,
} from "../../lib/food-search";
import {
  isRecipePositiveDecimal,
  mergeRecipePage,
  parseRecipeCollection,
  parseRecipeMutation,
  parseRecipeResponse,
  prepareRecipeLogOperation,
  prepareStableMutation,
  type RecipeIngredientDraft,
  type RecipeLogBody,
  type RecipeSummaryView,
  type RecipeView,
  recipeLogInstant,
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "../../lib/recipes-goals";

import { PastedIngredientReview } from "./PastedIngredientReview";

type LoadState = "loading" | "ready" | "error";
type NutritionBasis = "per100Grams" | "perServing";

interface BuilderState {
  readonly recipeId: string | null;
  readonly revision: string | null;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly yieldGrams: string;
  readonly yieldSource: "measured" | "estimated";
  readonly servingCount: string;
  readonly servingLabel: string;
  readonly ingredients: readonly RecipeIngredientDraft[];
}

interface CopyConfirmation {
  readonly selectionGeneration: number;
  readonly builderGeneration: number;
}

function sameEditableBuilder(left: BuilderState, right: BuilderState): boolean {
  const editable = (builder: BuilderState) => ({
    ...builder,
    ingredients: builder.ingredients.map(ingredientRequest),
  });
  return JSON.stringify(editable(left)) === JSON.stringify(editable(right));
}

function emptyBuilder(): BuilderState {
  return {
    recipeId: null,
    revision: null,
    name: "",
    description: "",
    instructions: "",
    yieldGrams: "",
    yieldSource: "measured",
    servingCount: "",
    servingLabel: "serving",
    ingredients: [],
  };
}

export function draftFromRecipe(recipe: RecipeView): BuilderState {
  return {
    recipeId: recipe.id,
    revision: recipe.revision,
    name: recipe.name,
    description: recipe.description ?? "",
    instructions: recipe.instructions ?? "",
    yieldGrams: recipe.finalYieldGrams,
    yieldSource: recipe.yieldSource,
    servingCount: recipe.servingCount ?? "",
    servingLabel: recipe.servingLabel ?? "serving",
    ingredients: recipe.ingredients.map((ingredient) => {
      if (ingredient.kind === "recipe") {
        if (!ingredient.recipeId || !ingredient.recipeVersionId)
          throw new TypeError("Nested recipe identity is missing.");
        return {
          kind: "recipe" as const,
          clientKey: `recipe:${ingredient.recipeVersionId}:${ingredient.position}`,
          recipeId: ingredient.recipeId,
          recipeVersionId: ingredient.recipeVersionId,
          name: ingredient.name,
          grams:
            ingredient.portion.kind === "grams"
              ? ingredient.portion.grams
              : ingredient.resolvedGrams,
          note: ingredient.note,
        };
      }
      if (!ingredient.foodVersionId || !ingredient.foodProvenance) {
        throw new TypeError("Food ingredient provenance is missing.");
      }
      return {
        kind: "food" as const,
        clientKey: `food:${ingredient.foodVersionId}:${ingredient.position}`,
        foodVersionId: ingredient.foodVersionId,
        name: ingredient.name,
        brandName: ingredient.brandName,
        portion:
          ingredient.portion.kind === "serving"
            ? {
                kind: "serving" as const,
                servingId: ingredient.portion.servingId,
                servingLabel: ingredient.portion.servingLabel,
                amount: ingredient.portion.amount,
              }
            : ingredient.portion,
        source: ingredient.source,
        foodProvenance: ingredient.foodProvenance,
        note: ingredient.note,
      };
    }),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

export class RecipeOwnerFenceError extends Error {
  constructor() {
    super("The signed-in account changed while private recipe data was loading.");
    this.name = "RecipeOwnerFenceError";
  }
}

/**
 * Keeps the private response and its state transition on one side of the owner check.
 * The install callback is deliberately unreachable until a second server-authenticated
 * session read confirms the same user that initiated the request.
 */
export async function installRecipePrivateDataForOwner<T>(input: {
  readonly expectedOwnerUserId: string;
  readonly loadPrivateData: () => Promise<T>;
  readonly revalidateSession: () => Promise<SessionSummary>;
  readonly install: (data: T, session: SessionSummary) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const data = await input.loadPrivateData();
  input.signal?.throwIfAborted();
  const session = await input.revalidateSession();
  input.signal?.throwIfAborted();
  if (session.user.id !== input.expectedOwnerUserId) throw new RecipeOwnerFenceError();
  input.install(data, session);
}

/** A typed time-zone conflict proves no write occurred, so its stale retry must not survive. */
export function fenceRecipeLogForTimeZoneChange(
  pending: Map<string, StableMutation<RecipeLogBody>>,
  operation: StableMutation<RecipeLogBody>,
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
  if (pending.get(operation.intentKey) === operation) pending.delete(operation.intentKey);
  return true;
}

export function recipeLogTimeZoneReviewMessage(
  localDate: string,
  currentTimeZone: string | null,
  localTime = "",
): string {
  if (localTime) {
    return currentTimeZone
      ? `Your profile time zone changed to ${currentTimeZone}. This recipe was not logged. Review ${localDate} at ${localTime} in that zone, then confirm the day and time before logging again.`
      : "Your profile time zone changed. This recipe was not logged, and its stale retry was cleared. Current account settings could not be reloaded; refresh this page, then review the local diary day and time before logging again.";
  }
  return currentTimeZone
    ? `Your profile time zone changed to ${currentTimeZone}. This recipe was not logged. Review ${localDate} as a local day in that zone, then confirm the day before logging again.`
    : "Your profile time zone changed. This recipe was not logged, and its stale retry was cleared. Current account settings could not be reloaded; refresh this page, then review the local diary day before logging again.";
}

export function recipeProfileRefreshBelongsToOwner(
  initiatingUserId: string,
  activeUserId: string | null,
  refreshedUserId: string,
): boolean {
  return activeUserId === initiatingUserId && refreshedUserId === initiatingUserId;
}

function ingredientRequest(ingredient: RecipeIngredientDraft, position: number) {
  if (ingredient.kind === "recipe") {
    return {
      kind: "recipe" as const,
      recipeVersionId: ingredient.recipeVersionId,
      grams: ingredient.grams,
      position,
      note: ingredient.note,
    };
  }
  return {
    kind: "food" as const,
    foodVersionId: ingredient.foodVersionId,
    portion:
      ingredient.portion.kind === "serving"
        ? {
            kind: "serving" as const,
            servingId: ingredient.portion.servingId,
            amount: ingredient.portion.amount,
          }
        : ingredient.portion,
    position,
    note: ingredient.note,
  };
}

function foodIngredientAttribution(
  ingredient: Extract<RecipeIngredientDraft, { readonly kind: "food" }>,
): string {
  if (ingredient.foodProvenance.kind === "private_custom") {
    return `Owner-entered private custom food · pinned version ${ingredient.foodProvenance.customFoodVersionNumber}`;
  }
  return ingredient.source
    ? `${ingredient.source.attributionText} · ${ingredient.source.licenseExpression}`
    : "Public source metadata unavailable";
}

function foodSource(food: FoodSearchHit) {
  return {
    displayName: food.source.displayName,
    licenseExpression: food.source.licenseExpression,
    attributionText: food.source.attributionText,
  };
}

export function foodDraftIngredient(
  food: FoodSearchHit,
  mode: "grams" | "serving",
): RecipeIngredientDraft {
  const serving = food.defaultServing;
  if (mode === "serving" && !serving?.gramWeight) {
    throw new RangeError("This food does not have a reviewed gram-resolved serving.");
  }
  return {
    kind: "food",
    clientKey: createOperationId(),
    foodVersionId: food.foodVersionId,
    name: food.name,
    brandName: food.brandName,
    portion:
      mode === "serving" && serving?.gramWeight
        ? {
            kind: "serving",
            servingId: serving.servingId,
            servingLabel: serving.label,
            amount: "1",
          }
        : { kind: "grams", grams: "100" },
    source: foodSource(food),
    foodProvenance: { kind: "public", source: foodSource(food) },
    note: null,
  };
}

export function RecipesClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const filterScopeRef = useRef({ requestedDate });
  if (filterScopeRef.current.requestedDate !== requestedDate) {
    filterScopeRef.current = { requestedDate };
  }
  const filterScope = filterScopeRef.current;
  const [savedFilter, setSavedFilter] = useState({ scope: filterScope, value: "" });
  const savedFilterRef = useRef(savedFilter);
  const [nestedFilter, setNestedFilter] = useState({ scope: filterScope, value: "" });
  const nestedFilterRef = useRef(nestedFilter);
  const [filterVerifiedScope, setFilterVerifiedScope] = useState<typeof filterScope | null>(null);
  const [loadedRecipesScope, setLoadedRecipesScope] = useState<typeof filterScope | null>(null);
  const [date, setDate] = useState(
    requestedDate && isLocalDate(requestedDate) ? requestedDate : "",
  );
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [dateReviewRequired, setDateReviewRequired] = useState(false);
  const [recipes, setRecipes] = useState<readonly RecipeSummaryView[]>([]);
  const recipesRef = useRef(recipes);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelectedState] = useState<RecipeView | null>(null);
  const [nutritionBasis, setNutritionBasis] = useState<NutritionBasis>("per100Grams");
  const selectionGeneration = useRef(0);
  const [builder, setBuilderState] = useState<BuilderState>(emptyBuilder);
  const [copyConfirmation, setCopyConfirmation] = useState<CopyConfirmation | null>(null);
  const copyConfirmationRef = useRef<CopyConfirmation | null>(null);
  const createDraftGeneration = useRef(0);
  const [state, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Loading your private recipes…");
  const [busy, setBusyState] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foodResults, setFoodResults] = useState<readonly FoodSearchHit[]>([]);
  const [searchState, setSearchState] = useState<"idle" | LoadState>("idle");
  const [mealSlot, setMealSlot] = useState<MealSlot>(() => defaultMealForTime());
  const [diaryGroups, setDiaryGroups] = useState<readonly DiaryGroup[]>(defaultDiaryGroups);
  const [logKind, setLogKind] = useState<"grams" | "serving">("serving");
  const [logAmount, setLogAmount] = useState("1");
  const [logTime, setLogTime] = useState("");
  const logTimeInput = useRef<HTMLInputElement | null>(null);
  const logDraftGeneration = useRef(0);
  const activeLog = useRef<object | null>(null);
  const logProfileRef = useRef({ timeZone, diaryGroups });
  if (
    logProfileRef.current.timeZone !== timeZone ||
    logProfileRef.current.diaryGroups !== diaryGroups
  ) {
    logProfileRef.current = { timeZone, diaryGroups };
  }
  const logProfile = logProfileRef.current;
  const logContext = logDraftGeneration.current;
  const logRouteReady =
    filterScopeRef.current === filterScope && filterVerifiedScope === filterScope;
  const logControlsUnavailable =
    busy !== null || state !== "ready" || !logRouteReady || activeLog.current !== null;
  const pendingSaves = useRef(
    new Map<string, StableMutation<ReturnType<typeof recipeBodyFromBuilder>>>(),
  );
  const pendingLogs = useRef(new Map<string, StableMutation<RecipeLogBody>>());
  const privateReadControllers = useRef(new Set<AbortController>());
  const profileRefreshController = useRef<AbortController | null>(null);
  const ownerUserId = useRef<string | null>(null);
  const privateUiClosed = useRef(false);

  const mounted = useRef(false);
  const builderRef = useRef(builder);
  const builderGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const builderRequest = useRef<AbortController | null>(null);
  const busyRef = useRef<string | null>(null);
  const stateRef = useRef<LoadState>("loading");

  const resetSavedFilter = useCallback(() => {
    const next = { scope: filterScopeRef.current, value: "" };
    savedFilterRef.current = next;
    setSavedFilter(next);
    nestedFilterRef.current = next;
    setNestedFilter(next);
    setFilterVerifiedScope(null);
    setLoadedRecipesScope(null);
  }, []);

  const clearCopyConfirmation = useCallback(() => {
    copyConfirmationRef.current = null;
    setCopyConfirmation(null);
  }, []);

  const setSelected = useCallback(
    (next: RecipeView | null) => {
      // Invalidate retained controls even when a previously viewed version is reopened.
      selectionGeneration.current += 1;
      activeLog.current = null;
      logDraftGeneration.current += 1;
      setLogTime("");
      clearCopyConfirmation();
      setSelectedState(next);
      setNutritionBasis(next?.nutrientsPerServing != null ? "perServing" : "per100Grams");
    },
    [clearCopyConfirmation],
  );

  const replaceBuilder = useCallback(
    (next: BuilderState) => {
      builderRef.current = next;
      builderGeneration.current += 1;
      clearCopyConfirmation();
      setBuilderState(next);
    },
    [clearCopyConfirmation],
  );
  const builderScope = reviewGeneration.current;
  const renderedBuilderGeneration = builderGeneration.current;
  const setBuilder = useCallback(
    (next: BuilderState) => {
      if (
        !mounted.current ||
        privateUiClosed.current ||
        ownerUserId.current === null ||
        reviewGeneration.current !== builderScope ||
        builderGeneration.current !== renderedBuilderGeneration
      )
        return;
      replaceBuilder(next);
    },
    [replaceBuilder, builderScope, renderedBuilderGeneration],
  );
  const setBusy = useCallback((next: string | null) => {
    busyRef.current = next;
    setBusyState(next);
  }, []);
  const setState = useCallback((next: LoadState) => {
    stateRef.current = next;
    setLoadState(next);
  }, []);
  const reviewOwner = ownerUserId.current;
  const reviewContext = reviewGeneration.current;
  const nutritionContext = selectionGeneration.current;
  const builderContext = builderGeneration.current;

  function canCopySelected() {
    return (
      mounted.current &&
      !privateUiClosed.current &&
      reviewOwner !== null &&
      ownerUserId.current === reviewOwner &&
      selected !== null &&
      selectionGeneration.current === nutritionContext &&
      builderGeneration.current === builderContext &&
      stateRef.current === "ready" &&
      busyRef.current === null
    );
  }

  function copySelectedToNewDraft() {
    if (!canCopySelected() || !selected) return;
    const copied = { ...draftFromRecipe(selected), recipeId: null, revision: null };
    builderRequest.current?.abort();
    builderRequest.current = null;
    createDraftGeneration.current += 1;
    reviewGeneration.current += 1;
    setSelected(null);
    replaceBuilder(copied);
    setQuery("");
    setFoodResults([]);
    setSearchState("idle");
    setLogKind("grams");
    setLogAmount("1");
    setMessage(
      `Copied ${selected.name} saved version ${selected.versionNumber} to a new draft. Edit and create it when ready; the original recipe is unchanged.`,
    );
  }

  function requestCopySelected() {
    if (!canCopySelected() || !selected) return;
    if (sameEditableBuilder(builderRef.current, draftFromRecipe(selected))) {
      copySelectedToNewDraft();
      return;
    }
    const confirmation = {
      selectionGeneration: nutritionContext,
      builderGeneration: builderContext,
    };
    copyConfirmationRef.current = confirmation;
    setCopyConfirmation(confirmation);
  }

  function resolveCopyConfirmation(discard: boolean) {
    if (
      !canCopySelected() ||
      !copyConfirmation ||
      copyConfirmationRef.current !== copyConfirmation ||
      copyConfirmation.selectionGeneration !== nutritionContext ||
      copyConfirmation.builderGeneration !== builderContext
    )
      return;
    if (discard) copySelectedToNewDraft();
    else clearCopyConfirmation();
  }

  function selectNutritionBasis(next: NutritionBasis) {
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !reviewOwner ||
      ownerUserId.current !== reviewOwner ||
      selectionGeneration.current !== nutritionContext ||
      stateRef.current !== "ready" ||
      busyRef.current !== null ||
      !selected ||
      (next === "perServing" && selected.nutrientsPerServing === null)
    )
      return;
    setNutritionBasis(next);
  }

  function confirmReviewedIngredients(ingredients: readonly RecipeIngredientDraft[]): boolean {
    const current = builderRef.current;
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !reviewOwner ||
      ownerUserId.current !== reviewOwner ||
      reviewGeneration.current !== reviewContext ||
      stateRef.current !== "ready" ||
      busyRef.current !== null ||
      current.recipeId !== null ||
      ingredients.length === 0 ||
      current.ingredients.length + ingredients.length > 50
    )
      return false;
    const keys = new Set(current.ingredients.map((ingredient) => ingredient.clientKey));
    for (const ingredient of ingredients) {
      if (ingredient.kind !== "food" || ingredient.note !== null || keys.has(ingredient.clientKey))
        return false;
      const quantity =
        ingredient.portion.kind === "grams" ? ingredient.portion.grams : ingredient.portion.amount;
      if (!isRecipePositiveDecimal(quantity)) return false;
      keys.add(ingredient.clientKey);
    }
    reviewGeneration.current += 1;
    replaceBuilder({ ...current, ingredients: [...current.ingredients, ...ingredients] });
    setMessage(
      `${ingredients.length} reviewed ingredients added. Review the final yield before creating the recipe.`,
    );
    return true;
  }

  function startNewRecipe() {
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !reviewOwner ||
      ownerUserId.current !== reviewOwner ||
      reviewGeneration.current !== reviewContext ||
      busyRef.current === "log"
    )
      return;
    builderRequest.current?.abort();
    builderRequest.current = null;
    reviewGeneration.current += 1;
    createDraftGeneration.current += 1;
    setBusy(null);
    setSelected(null);
    replaceBuilder(emptyBuilder());
    setQuery("");
    setFoodResults([]);
    setSearchState("idle");
    setLogKind("grams");
    setLogAmount("1");
    setMessage("New recipe builder opened.");
  }

  const signInAgain = useCallback(() => {
    if (!mounted.current) return;
    privateUiClosed.current = true;
    resetSavedFilter();
    reviewGeneration.current += 1;
    builderRequest.current = null;
    for (const controller of privateReadControllers.current) controller.abort();
    privateReadControllers.current.clear();
    profileRefreshController.current?.abort();
    ownerUserId.current = null;
    pendingSaves.current.clear();
    pendingLogs.current.clear();
    activeLog.current = null;
    setDate("");
    setTimeZone(null);
    setDateReviewRequired(false);
    recipesRef.current = [];
    setRecipes([]);
    setNextCursor(null);
    setSelected(null);
    replaceBuilder(emptyBuilder());
    setState("loading");
    setMessage("Closing your private recipe workspace…");
    setBusy(null);
    setQuery("");
    setFoodResults([]);
    setSearchState("idle");
    setMealSlot(defaultMealForTime());
    setDiaryGroups(defaultDiaryGroups);
    setLogKind("serving");
    setLogAmount("1");
    router.replace("/login");
    router.refresh();
  }, [router, replaceBuilder, resetSavedFilter, setBusy, setState, setSelected]);

  const revalidateRecipeSession = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/auth/me", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
    signal.throwIfAborted();
    if (response.status === 401) throw new RecipeOwnerFenceError();
    if (!response.ok) throw new Error("Your recipe session could not be checked. Try again.");
    const body = await responseJson(response);
    signal.throwIfAborted();
    return parseSession(body);
  }, []);

  const loadRecipes = useCallback(
    async (cursor: string | null = null) => {
      if (privateUiClosed.current) return;
      const initiatingOwnerUserId = ownerUserId.current;
      if (initiatingOwnerUserId === null) return;
      const requestScope = filterScopeRef.current;
      const controller = new AbortController();
      privateReadControllers.current.add(controller);
      setState("loading");
      try {
        const requestPath =
          cursor === null
            ? "/api/recipes?limit=50"
            : `/api/recipes?limit=50&cursor=${encodeURIComponent(cursor)}`;
        await installRecipePrivateDataForOwner({
          expectedOwnerUserId: initiatingOwnerUserId,
          signal: controller.signal,
          loadPrivateData: async () => {
            const response = await fetch(requestPath, {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            });
            if (response.status === 401) throw new RecipeOwnerFenceError();
            const body = await responseJson(response);
            if (!response.ok)
              throw new Error(responseMessage(body, "Recipes could not be loaded."));
            return parseRecipeCollection(body);
          },
          revalidateSession: () => revalidateRecipeSession(controller.signal),
          install: (page) => {
            if (filterScopeRef.current !== requestScope) return;
            if (privateUiClosed.current || ownerUserId.current !== initiatingOwnerUserId) {
              throw new RecipeOwnerFenceError();
            }
            const merged = mergeRecipePage(recipesRef.current, page.data, cursor !== null);
            recipesRef.current = merged;
            setRecipes(merged);
            setMessage(
              merged.length === 0 && page.nextCursor === null
                ? "No recipes yet."
                : `${merged.length} recipes loaded${page.nextCursor ? "; more available" : ""}.`,
            );
            setNextCursor(page.nextCursor);
            setLoadedRecipesScope(requestScope);
            setState("ready");
          },
        });
      } catch (caught) {
        if (controller.signal.aborted || filterScopeRef.current !== requestScope) return;
        if (caught instanceof RecipeOwnerFenceError) return signInAgain();
        setState("error");
        setMessage(caught instanceof Error ? caught.message : "Recipes could not be loaded.");
      } finally {
        privateReadControllers.current.delete(controller);
      }
    },
    [revalidateRecipeSession, signInAgain, setState],
  );

  async function refreshRecipeProfileAfterTimeZoneChange(
    initiatingUserId: string,
  ): Promise<string | null> {
    profileRefreshController.current?.abort();
    const controller = new AbortController();
    profileRefreshController.current = controller;
    const requestScope = filterScopeRef.current;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !mounted.current ||
        privateUiClosed.current ||
        filterScopeRef.current !== requestScope
      )
        return null;
      if (response.status === 401) {
        signInAgain();
        return null;
      }
      if (!response.ok) return null;
      const session = parseSession(await responseJson(response));
      if (
        controller.signal.aborted ||
        privateUiClosed.current ||
        filterScopeRef.current !== requestScope
      )
        return null;
      if (
        !recipeProfileRefreshBelongsToOwner(initiatingUserId, ownerUserId.current, session.user.id)
      ) {
        signInAgain();
        return null;
      }
      if (
        session.profile.timeZone !== timeZone ||
        JSON.stringify(session.profile.diaryGroups) !== JSON.stringify(diaryGroups)
      ) {
        const next = { scope: requestScope, value: "" };
        savedFilterRef.current = next;
        setSavedFilter(next);
        nestedFilterRef.current = next;
        setNestedFilter(next);
      }
      logDraftGeneration.current += 1;
      setTimeZone(session.profile.timeZone);
      setDiaryGroups(session.profile.diaryGroups);
      return session.profile.timeZone;
    } catch {
      return null;
    } finally {
      if (profileRefreshController.current === controller) profileRefreshController.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    logDraftGeneration.current += 1;
    setLogTime("");
    if (activeLog.current !== null) {
      activeLog.current = null;
      setBusy(null);
    }
    resetSavedFilter();
    const requestScope = filterScopeRef.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          !mounted.current ||
          privateUiClosed.current ||
          filterScopeRef.current !== requestScope
        )
          return;
        if (response.status === 401) return signInAgain();
        if (!response.ok) throw new Error("Session verification failed.");
        const session = parseSession(await responseJson(response));
        const localDate =
          requestedDate && isLocalDate(requestedDate)
            ? requestedDate
            : localDateInTimeZone(new Date(), session.profile.timeZone);
        if (
          !controller.signal.aborted &&
          !privateUiClosed.current &&
          filterScopeRef.current === requestScope
        ) {
          if (ownerUserId.current !== null && ownerUserId.current !== session.user.id) {
            signInAgain();
            return;
          }
          ownerUserId.current = session.user.id;
          setFilterVerifiedScope(requestScope);
          setDiaryGroups(session.profile.diaryGroups);
          setDate(localDate);
          setTimeZone(session.profile.timeZone);
          void loadRecipes();
        }
      } catch {
        if (!controller.signal.aborted && filterScopeRef.current === requestScope) {
          setState("error");
          setMessage("Your private recipe session could not be verified.");
        }
      }
    })();
    return () => {
      mounted.current = false;
      filterScopeRef.current = { requestedDate: filterScopeRef.current.requestedDate };
      copyConfirmationRef.current = null;
      selectionGeneration.current += 1;
      builderGeneration.current += 1;
      reviewGeneration.current += 1;
      builderRequest.current = null;
      controller.abort();
      for (const privateController of privateReadControllers.current) privateController.abort();
      privateReadControllers.current.clear();
      profileRefreshController.current?.abort();
    };
  }, [loadRecipes, requestedDate, resetSavedFilter, signInAgain, setBusy, setState]);

  async function openRecipe(recipeId: string, successMessage?: string) {
    const initiatingOwnerUserId = ownerUserId.current;
    if (
      initiatingOwnerUserId === null ||
      privateUiClosed.current ||
      !mounted.current ||
      initiatingOwnerUserId !== reviewOwner ||
      reviewGeneration.current !== reviewContext
    )
      return;
    clearCopyConfirmation();
    builderRequest.current?.abort();
    const controller = new AbortController();
    builderRequest.current = controller;
    const generation = builderGeneration.current;
    const isCurrent = () =>
      mounted.current &&
      !privateUiClosed.current &&
      !controller.signal.aborted &&
      builderRequest.current === controller &&
      ownerUserId.current === initiatingOwnerUserId &&
      builderGeneration.current === generation;
    privateReadControllers.current.add(controller);
    setBusy(`open:${recipeId}`);
    setMessage("Loading the immutable recipe revision…");
    try {
      await installRecipePrivateDataForOwner({
        expectedOwnerUserId: initiatingOwnerUserId,
        signal: controller.signal,
        loadPrivateData: async () => {
          const response = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 401) throw new RecipeOwnerFenceError();
          const body = await responseJson(response);
          if (!response.ok)
            throw new Error(responseMessage(body, "The recipe could not be loaded."));
          return parseRecipeResponse(body);
        },
        revalidateSession: () => revalidateRecipeSession(controller.signal),
        install: (recipe) => {
          if (!isCurrent()) return;
          reviewGeneration.current += 1;
          setSelected(recipe);
          replaceBuilder(draftFromRecipe(recipe));
          setLogKind(recipeLogKindFor(recipe));
          setLogAmount("1");
          setMessage(successMessage ?? `Version ${recipe.versionNumber} loaded.`);
        },
      });
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof RecipeOwnerFenceError) return signInAgain();
      setMessage(caught instanceof Error ? caught.message : "The recipe could not be loaded.");
    } finally {
      privateReadControllers.current.delete(controller);
      if (builderRequest.current === controller) {
        builderRequest.current = null;
        if (mounted.current && !privateUiClosed.current) setBusy(null);
      }
    }
  }

  async function searchFoods() {
    const searchContext = reviewGeneration.current;
    const initiatingOwnerUserId = ownerUserId.current;
    if (
      initiatingOwnerUserId === null ||
      privateUiClosed.current ||
      !mounted.current ||
      initiatingOwnerUserId !== reviewOwner ||
      reviewGeneration.current !== reviewContext
    )
      return;
    const controller = new AbortController();
    privateReadControllers.current.add(controller);
    setSearchState("loading");
    try {
      await installRecipePrivateDataForOwner({
        expectedOwnerUserId: initiatingOwnerUserId,
        signal: controller.signal,
        loadPrivateData: async () => {
          const response = await fetch(buildSearchRequestPath({ query, intent: "all" }), {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 401) throw new RecipeOwnerFenceError();
          const body = await responseJson(response);
          if (!response.ok) throw new Error(responseMessage(body, "Food search is unavailable."));
          return parseFoodSearchPage(body);
        },
        revalidateSession: () => revalidateRecipeSession(controller.signal),
        install: (page) => {
          if (privateUiClosed.current || ownerUserId.current !== initiatingOwnerUserId) {
            throw new RecipeOwnerFenceError();
          }
          if (!mounted.current || reviewGeneration.current !== searchContext) return;
          setFoodResults(page.data);
          setSearchState("ready");
        },
      });
    } catch (caught) {
      if (controller.signal.aborted || reviewGeneration.current !== searchContext) return;
      if (caught instanceof RecipeOwnerFenceError) return signInAgain();
      setFoodResults([]);
      setSearchState("error");
      setMessage(caught instanceof Error ? caught.message : "Food search is unavailable.");
    } finally {
      privateReadControllers.current.delete(controller);
    }
  }

  function addFood(food: FoodSearchHit, mode: "grams" | "serving") {
    if (reviewGeneration.current !== reviewContext) return;
    if (builder.ingredients.length >= 50) {
      setMessage("A recipe supports at most 50 ingredients.");
      return;
    }
    setBuilder({
      ...builder,
      ingredients: [...builder.ingredients, foodDraftIngredient(food, mode)],
    });
    setMessage(
      mode === "serving"
        ? `${food.name} added with its reviewed serving.`
        : `${food.name} added as an explicit 100 gram ingredient.`,
    );
  }

  function addNested(recipe: RecipeSummaryView) {
    if (
      !canUseNestedFilter() ||
      reviewGeneration.current !== reviewContext ||
      builderGeneration.current !== builderContext ||
      builderRef.current !== builder ||
      !recipesRef.current.includes(recipe) ||
      !recipe.name.toLowerCase().includes(normalizedNestedFilter)
    )
      return;
    if (recipe.id === builder.recipeId) {
      setMessage("A recipe cannot contain itself.");
      return;
    }
    if (builder.ingredients.length >= 50) {
      setMessage("A recipe supports at most 50 ingredients.");
      return;
    }
    setBuilder({
      ...builder,
      ingredients: [
        ...builder.ingredients,
        {
          kind: "recipe",
          clientKey: createOperationId(),
          recipeId: recipe.id,
          recipeVersionId: recipe.versionId,
          name: recipe.name,
          grams: "100",
          note: null,
        },
      ],
    });
    setMessage(`${recipe.name} version ${recipe.versionNumber} pinned as a nested ingredient.`);
  }

  function editableIngredientBuilder(clientKey: string): BuilderState | null {
    const current = builderRef.current;
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !reviewOwner ||
      ownerUserId.current !== reviewOwner ||
      reviewGeneration.current !== reviewContext ||
      builderGeneration.current !== builderContext ||
      stateRef.current !== "ready" ||
      busyRef.current !== null ||
      !current.ingredients.some((ingredient) => ingredient.clientKey === clientKey)
    )
      return null;
    return current;
  }

  function updateIngredient(clientKey: string, quantity: string) {
    const current = editableIngredientBuilder(clientKey);
    if (!current) return;
    setBuilder({
      ...current,
      ingredients: current.ingredients.map((ingredient) => {
        if (ingredient.clientKey !== clientKey) return ingredient;
        if (ingredient.kind === "recipe") return { ...ingredient, grams: quantity };
        return {
          ...ingredient,
          portion:
            ingredient.portion.kind === "serving"
              ? { ...ingredient.portion, amount: quantity }
              : { ...ingredient.portion, grams: quantity },
        };
      }),
    });
  }

  function updateIngredientNote(clientKey: string, note: string) {
    const current = editableIngredientBuilder(clientKey);
    if (!current) return;
    setBuilder({
      ...current,
      ingredients: current.ingredients.map((ingredient) =>
        ingredient.clientKey === clientKey ? { ...ingredient, note: note || null } : ingredient,
      ),
    });
  }

  function removeIngredient(clientKey: string) {
    const current = editableIngredientBuilder(clientKey);
    if (!current) return;
    setBuilder({
      ...current,
      ingredients: current.ingredients.filter((ingredient) => ingredient.clientKey !== clientKey),
    });
  }

  function moveIngredient(clientKey: string, direction: -1 | 1) {
    const current = editableIngredientBuilder(clientKey);
    if (!current) return;
    const index = current.ingredients.findIndex((ingredient) => ingredient.clientKey === clientKey);
    const target = index + direction;
    const moving = current.ingredients[index];
    const adjacent = current.ingredients[target];
    if (index < 0 || target < 0 || target >= current.ingredients.length || !moving || !adjacent)
      return;
    const ingredients = [...current.ingredients];
    ingredients[index] = adjacent;
    ingredients[target] = moving;
    setBuilder({ ...current, ingredients });
    setMessage(
      `${moving.name} moved to ingredient ${target + 1} of ${ingredients.length}. Save to keep this order.`,
    );
  }

  async function saveRecipe(event: FormEvent) {
    event.preventDefault();
    const initiatingOwnerUserId = ownerUserId.current;
    if (
      !mounted.current ||
      privateUiClosed.current ||
      !initiatingOwnerUserId ||
      initiatingOwnerUserId !== reviewOwner ||
      reviewGeneration.current !== reviewContext ||
      busyRef.current !== null
    )
      return;
    clearCopyConfirmation();
    const savingBuilder = builderRef.current;
    let body: ReturnType<typeof recipeBodyFromBuilder>;
    try {
      body = recipeBodyFromBuilder(savingBuilder);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the recipe fields.");
      return;
    }
    const generation = builderGeneration.current;
    const controller = new AbortController();
    builderRequest.current = controller;
    privateReadControllers.current.add(controller);
    const isCurrent = () =>
      mounted.current &&
      !privateUiClosed.current &&
      !controller.signal.aborted &&
      builderRequest.current === controller &&
      ownerUserId.current === initiatingOwnerUserId &&
      builderGeneration.current === generation;
    const intentKey = `${savingBuilder.recipeId ?? `create:${createDraftGeneration.current}`}:${savingBuilder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(
      pendingSaves.current,
      intentKey,
      () => body,
      createOperationId,
    );
    pendingSaves.current.set(intentKey, operation);
    setBusy("save");
    setMessage(
      savingBuilder.recipeId ? "Publishing a new immutable revision…" : "Creating recipe…",
    );
    try {
      const beforeSession = await revalidateRecipeSession(controller.signal);
      if (!isCurrent()) return;
      if (beforeSession.user.id !== initiatingOwnerUserId) throw new RecipeOwnerFenceError();
      const path = savingBuilder.recipeId
        ? `/api/recipes/${encodeURIComponent(savingBuilder.recipeId)}/revisions`
        : "/api/recipes";
      const response = await fetch(path, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(savingBuilder.revision ? { "if-match": `"${savingBuilder.revision}"` } : {}),
        },
        body: JSON.stringify(operation.body),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401) return signInAgain();
      const responseBody = await responseJson(response);
      if (!isCurrent()) return;
      if (response.status === 412) {
        pendingSaves.current.delete(intentKey);
        if (savingBuilder.recipeId)
          await openRecipe(
            savingBuilder.recipeId,
            "This recipe changed elsewhere. Fresh values were loaded; review before saving again.",
          );
        return;
      }
      if (!response.ok)
        throw new Error(responseMessage(responseBody, "The recipe could not be saved."));
      const mutation = parseRecipeMutation(responseBody);
      const afterSession = await revalidateRecipeSession(controller.signal);
      if (!isCurrent()) return;
      if (afterSession.user.id !== initiatingOwnerUserId) throw new RecipeOwnerFenceError();
      pendingSaves.current.delete(intentKey);
      reviewGeneration.current += 1;
      setSelected(mutation.recipe);
      replaceBuilder(draftFromRecipe(mutation.recipe));
      setLogKind(recipeLogKindFor(mutation.recipe));
      setLogAmount("1");
      // The receipt is installed. Do not let the later list refresh replace a newer draft's status.
      const installedGeneration = builderGeneration.current;
      await loadRecipes();
      if (
        !mounted.current ||
        privateUiClosed.current ||
        controller.signal.aborted ||
        ownerUserId.current !== initiatingOwnerUserId ||
        builderGeneration.current !== installedGeneration
      )
        return;
      setMessage(
        mutation.replayed
          ? "The earlier save was confirmed safely."
          : `Recipe version ${mutation.recipe.versionNumber} published.`,
      );
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof RecipeOwnerFenceError) return signInAgain();
      setMessage(
        `${caught instanceof Error ? caught.message : "The recipe could not be saved."} Choose Save again to retry safely.`,
      );
    } finally {
      privateReadControllers.current.delete(controller);
      if (builderRequest.current === controller) {
        builderRequest.current = null;
        if (mounted.current && !privateUiClosed.current) setBusy(null);
      }
    }
  }

  function canEditLogSelection() {
    return (
      mounted.current &&
      !privateUiClosed.current &&
      reviewOwner !== null &&
      ownerUserId.current === reviewOwner &&
      selected !== null &&
      selectionGeneration.current === nutritionContext &&
      logDraftGeneration.current === logContext &&
      activeLog.current === null &&
      logProfileRef.current === logProfile &&
      filterScopeRef.current === filterScope &&
      filterVerifiedScope === filterScope &&
      stateRef.current === "ready" &&
      busyRef.current === null
    );
  }

  function changeLogField<T>(current: T, next: T, install: (value: T) => void) {
    if (!canEditLogSelection() || current === next) return;
    logDraftGeneration.current += 1;
    install(next);
  }

  function validateLogTimeInput(): boolean {
    if (logTimeInput.current?.validity.valid === false) {
      setMessage("Complete the local time, or clear every time segment to use the automatic time.");
      return false;
    }
    return true;
  }

  async function logRecipe() {
    if (!canEditLogSelection() || !validateLogTimeInput()) return;
    if (dateReviewRequired) {
      setMessage(
        "Review and confirm the local diary day and optional time before logging this recipe again.",
      );
      return;
    }
    if (!isLocalDate(date)) {
      setMessage("Diary date must use YYYY-MM-DD and be a real local calendar day.");
      return;
    }
    const initiatingOwnerUserId = ownerUserId.current;
    if (
      !selected ||
      !timeZone ||
      initiatingOwnerUserId === null ||
      !isRecipePositiveDecimal(logAmount)
    ) {
      setMessage("Choose a positive recipe amount before logging.");
      return;
    }
    const effectiveLogKind = selected.servingCount === null ? "grams" : logKind;
    const portion =
      effectiveLogKind === "grams"
        ? ({ kind: "grams", grams: logAmount } as const)
        : ({ kind: "serving", amount: logAmount } as const);
    const token = {};
    activeLog.current = token;
    const isCurrent = () =>
      activeLog.current === token &&
      mounted.current &&
      !privateUiClosed.current &&
      ownerUserId.current === initiatingOwnerUserId &&
      selectionGeneration.current === nutritionContext &&
      filterScopeRef.current === filterScope;
    setBusy("log");
    setMessage("Logging this exact recipe revision…");
    try {
      const operation = prepareRecipeLogOperation(
        pendingLogs.current,
        {
          recipeId: selected.id,
          recipeVersionId: selected.versionId,
          portion,
          mealSlot,
          localDate: date,
          timeZone,
          localTime: logTime,
        },
        new Date(),
        createOperationId,
      );
      pendingLogs.current.set(operation.intentKey, operation);
      const response = await fetch(
        `/api/recipes/${encodeURIComponent(selected.id)}/log?profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": operation.operationId,
            "x-expected-profile-time-zone": timeZone,
          },
          body: JSON.stringify(operation.body),
          cache: "no-store",
        },
      );
      if (!isCurrent()) return;
      if (response.status === 401) return signInAgain();
      const body = await responseJson(response);
      if (!isCurrent()) return;
      if (!response.ok) {
        if (
          fenceRecipeLogForTimeZoneChange(pendingLogs.current, operation, response.status, body)
        ) {
          logDraftGeneration.current += 1;
          setDateReviewRequired(true);
          setTimeZone(null);
          const currentTimeZone =
            await refreshRecipeProfileAfterTimeZoneChange(initiatingOwnerUserId);
          if (!isCurrent()) return;
          setMessage(recipeLogTimeZoneReviewMessage(date, currentTimeZone, logTime));
          return;
        }
        throw new Error(responseMessage(body, "The recipe could not be logged."));
      }
      const mutation = parseDiaryMutation(body);
      pendingLogs.current.delete(operation.intentKey);
      const loggedDate = mutation.entry?.localDate ?? date;
      logDraftGeneration.current += 1;
      setDate(loggedDate);
      setMessage(
        mutation.replayed
          ? `The earlier diary log to ${diaryGroupLabel(diaryGroups, mealSlot)} was confirmed safely.`
          : `Recipe logged to ${diaryGroupLabel(diaryGroups, mealSlot)}.`,
      );
    } catch (caught) {
      if (!isCurrent()) return;
      setMessage(
        `${caught instanceof Error ? caught.message : "The recipe could not be logged."} Choose Log again to retry safely.`,
      );
    } finally {
      if (isCurrent()) {
        activeLog.current = null;
        setBusy(null);
      }
    }
  }

  function confirmRecipeDateReview() {
    if (!canEditLogSelection() || !validateLogTimeInput()) return;
    if (!timeZone) {
      setMessage(
        "Current account settings are unavailable. Refresh this page before confirming a local diary day.",
      );
      return;
    }
    try {
      if (!isLocalDate(date)) throw new RangeError("Choose a valid local diary day.");
      if (logTime !== "") recipeLogInstant(date, logTime, timeZone);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Choose a valid local diary time.");
      return;
    }
    logDraftGeneration.current += 1;
    setDateReviewRequired(false);
    setMessage(
      logTime
        ? `${date} at ${logTime} is confirmed in ${timeZone}. Choose Log when ready.`
        : `${date} is confirmed as a local diary day in ${timeZone}. Choose Log when ready.`,
    );
  }

  const filterOwner = ownerUserId.current;
  const filterScopeReady =
    mounted.current &&
    !privateUiClosed.current &&
    filterOwner !== null &&
    filterVerifiedScope === filterScope &&
    savedFilter.scope === filterScope;
  const loadedListVerified = filterScopeReady && loadedRecipesScope === filterScope;
  const savedFilterValue = filterScopeReady ? savedFilter.value : "";
  const normalizedSavedFilter = savedFilterValue.trim().toLowerCase();
  const visibleRecipes = loadedListVerified
    ? recipes.filter((recipe) => recipe.name.toLowerCase().includes(normalizedSavedFilter))
    : [];

  function changeSavedFilter(value: string) {
    if (
      !filterScopeReady ||
      !mounted.current ||
      privateUiClosed.current ||
      ownerUserId.current !== filterOwner ||
      filterScopeRef.current !== filterScope ||
      savedFilterRef.current !== savedFilter
    )
      return;
    const bounded = value.slice(0, 200);
    if (bounded === savedFilter.value) return;
    const next = { scope: filterScope, value: bounded };
    savedFilterRef.current = next;
    setSavedFilter(next);
  }

  const nestedFilterReady = filterScopeReady && nestedFilter.scope === filterScope;
  const nestedFilterValue = nestedFilterReady ? nestedFilter.value : "";
  const normalizedNestedFilter = nestedFilterValue.trim().toLowerCase();
  const eligibleNestedRecipes = loadedListVerified
    ? recipes.filter((recipe) => recipe.id !== builder.recipeId)
    : [];
  const visibleNestedRecipes = eligibleNestedRecipes.filter((recipe) =>
    recipe.name.toLowerCase().includes(normalizedNestedFilter),
  );
  const nestedFilterDisabled = !nestedFilterReady || state !== "ready" || busy !== null;

  function canUseNestedFilter() {
    return (
      nestedFilterReady &&
      mounted.current &&
      !privateUiClosed.current &&
      ownerUserId.current === filterOwner &&
      filterScopeRef.current === filterScope &&
      nestedFilterRef.current === nestedFilter &&
      builderRef.current === builder &&
      builderGeneration.current === builderContext &&
      stateRef.current === "ready" &&
      busyRef.current === null
    );
  }

  function changeNestedFilter(value: string) {
    if (!canUseNestedFilter()) return;
    const bounded = value.slice(0, 200);
    if (bounded === nestedFilter.value) return;
    const next = { scope: filterScope, value: bounded };
    nestedFilterRef.current = next;
    setNestedFilter(next);
  }

  const recipeAttribution = useMemo(
    () => (selected ? recipeSourceLines(selected) : []),
    [selected],
  );

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/dashboard?date=${date}`}>Diary</Link>
          <Link href={`/foods?date=${date}`}>Foods</Link>
          <Link aria-current="page" href={`/recipes?date=${date}`}>
            Recipes
          </Link>
          <Link href={`/goals?date=${date}`}>Goals</Link>
          <Link href={`/hydration?date=${date}`}>Hydration</Link>
          <Link href={`/activities?date=${date}`}>Activity</Link>
          <Link href={date ? `/reports?to=${encodeURIComponent(date)}` : "/reports"}>Reports</Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        <p className="wellnessNote">Wellness information only—not medical advice.</p>
      </aside>
      <section className="dashboard recipesDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">VERSIONED RECIPE WORKSPACE</p>
            <h1>Recipes</h1>
          </div>
          <span className="statusPill">Yield-aware</span>
        </header>
        <p className="workspaceIntro">
          Build from immutable food or recipe revisions. Yield, coverage gaps, default retention
          assumptions, and source attribution stay visible.
        </p>
        <div className="recipeWorkspace">
          <aside className="recipeRail" aria-label="Your recipes">
            <button
              className="buttonPrimary"
              disabled={busy === "log" || state !== "ready"}
              onClick={startNewRecipe}
              type="button"
            >
              New recipe
            </button>
            <p className="workspaceStatus" data-state={state} aria-live="polite">
              {message}
            </p>
            {state === "error" ? (
              <button className="buttonSecondary" onClick={() => void loadRecipes()} type="button">
                Retry recipes
              </button>
            ) : null}
            <label className="formField" htmlFor="saved-recipe-filter">
              <span>Filter loaded saved recipes by name</span>
              <input
                id="saved-recipe-filter"
                type="search"
                maxLength={200}
                disabled={!filterScopeReady}
                aria-describedby="saved-recipe-filter-status"
                value={savedFilterValue}
                onChange={(event) => changeSavedFilter(event.target.value)}
              />
            </label>
            <button
              className="buttonQuiet"
              type="button"
              disabled={!filterScopeReady || savedFilterValue === ""}
              onClick={() => changeSavedFilter("")}
            >
              Clear filter
            </button>
            <p className="fieldHelp" id="saved-recipe-filter-status" aria-live="polite">
              {loadedListVerified ? (
                <>
                  {visibleRecipes.length} of {recipes.length} loaded recipes match.
                  {normalizedSavedFilter && visibleRecipes.length === 0
                    ? " No loaded recipes match this name."
                    : ""}
                  {nextCursor
                    ? " More recipes may be available. Load more to include them."
                    : " All saved recipes are loaded."}
                </>
              ) : (
                "Saved recipes have not been loaded yet."
              )}
            </p>
            <ul className="recipeList">
              {visibleRecipes.map((recipe) => (
                <li key={recipe.id}>
                  <button
                    aria-current={selected?.id === recipe.id}
                    disabled={busy === `open:${recipe.id}`}
                    onClick={() => void openRecipe(recipe.id)}
                    type="button"
                  >
                    <strong>{recipe.name}</strong>
                    <small>
                      v{recipe.versionNumber} · {recipe.finalYieldGrams} g yield
                      {recipe.warningCount ? ` · ${recipe.warningCount} warnings` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {loadedListVerified && nextCursor ? (
              <button
                className="buttonSecondary"
                disabled={state === "loading"}
                onClick={() => void loadRecipes(nextCursor)}
                type="button"
              >
                {state === "loading" ? "Loading…" : "Load more recipes"}
              </button>
            ) : null}
          </aside>
          <section className="workspacePanel">
            <div className="workspaceHeading">
              <div>
                <p className="kicker">
                  {builder.recipeId ? `REVISION ${selected?.versionNumber ?? ""}` : "NEW RECIPE"}
                </p>
                <h2>{builder.recipeId ? builder.name : "Recipe builder"}</h2>
              </div>
              {selected ? <span className="statusPill">v{selected.versionNumber}</span> : null}
            </div>
            {selected ? (
              <section className="workspaceSection" aria-label="Copy saved recipe">
                <p className="fieldHelp">
                  Copy {selected.name} saved version {selected.versionNumber} to make a separate
                  recipe. The original stays unchanged.
                </p>
                <button
                  className="buttonSecondary"
                  disabled={busy !== null || state !== "ready"}
                  onClick={requestCopySelected}
                  type="button"
                >
                  Copy to new draft
                </button>
                {copyConfirmation && copyConfirmationRef.current === copyConfirmation ? (
                  <fieldset
                    aria-labelledby="copy-recipe-confirmation"
                    disabled={busy !== null || state !== "ready"}
                    style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
                  >
                    <p id="copy-recipe-confirmation" className="coverageCopy" aria-live="polite">
                      This editor has unsaved changes. Keep editing, or discard them and copy{" "}
                      {selected.name} saved version {selected.versionNumber}.
                    </p>
                    <button
                      className="buttonQuiet"
                      onClick={() => resolveCopyConfirmation(false)}
                      type="button"
                    >
                      Keep editing
                    </button>{" "}
                    <button
                      className="buttonSecondary"
                      onClick={() => resolveCopyConfirmation(true)}
                      type="button"
                    >
                      Discard edits and copy saved version
                    </button>
                  </fieldset>
                ) : null}
              </section>
            ) : null}
            {builder.recipeId === null && reviewOwner && !privateUiClosed.current ? (
              <PastedIngredientReview
                key={reviewContext}
                ownerUserId={reviewOwner}
                disabled={busy !== null || state !== "ready"}
                remainingCapacity={50 - builder.ingredients.length}
                onConfirm={confirmReviewedIngredients}
                onSessionClosed={signInAgain}
              />
            ) : null}
            <form className="workspaceForm" onSubmit={(event) => void saveRecipe(event)}>
              <fieldset
                disabled={busy !== null || state !== "ready"}
                style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
              >
                <div className="formGrid">
                  <label className="formField">
                    <span>Name</span>
                    <input
                      maxLength={200}
                      onChange={(event) => setBuilder({ ...builder, name: event.target.value })}
                      required
                      value={builder.name}
                    />
                  </label>
                  <label className="formField">
                    <span>Final yield grams</span>
                    <input
                      inputMode="decimal"
                      maxLength={19}
                      onChange={(event) =>
                        setBuilder({ ...builder, yieldGrams: event.target.value })
                      }
                      required
                      value={builder.yieldGrams}
                    />
                  </label>
                  <label className="formField">
                    <span>Yield source</span>
                    <select
                      onChange={(event) =>
                        setBuilder({
                          ...builder,
                          yieldSource: event.target.value as "measured" | "estimated",
                        })
                      }
                      value={builder.yieldSource}
                    >
                      <option value="measured">Measured after preparation</option>
                      <option value="estimated">Estimated</option>
                    </select>
                  </label>
                  <label className="formField">
                    <span>Serving count (optional)</span>
                    <input
                      inputMode="decimal"
                      maxLength={19}
                      onChange={(event) =>
                        setBuilder({ ...builder, servingCount: event.target.value })
                      }
                      value={builder.servingCount}
                    />
                  </label>
                  <label className="formField">
                    <span>Serving label</span>
                    <input
                      disabled={!builder.servingCount}
                      maxLength={100}
                      onChange={(event) =>
                        setBuilder({ ...builder, servingLabel: event.target.value })
                      }
                      value={builder.servingLabel}
                    />
                  </label>
                  <label className="formField formField--wide">
                    <span>Description</span>
                    <textarea
                      maxLength={2_000}
                      onChange={(event) =>
                        setBuilder({ ...builder, description: event.target.value })
                      }
                      value={builder.description}
                    />
                  </label>
                  <label className="formField formField--wide">
                    <span>Instructions (optional)</span>
                    <textarea
                      maxLength={10_000}
                      onChange={(event) =>
                        setBuilder({ ...builder, instructions: event.target.value })
                      }
                      value={builder.instructions}
                    />
                  </label>
                </div>
                <section className="workspaceSection" aria-labelledby="ingredient-heading">
                  <h3 id="ingredient-heading">Ingredients ({builder.ingredients.length}/50)</h3>
                  <ul className="ingredientList">
                    {builder.ingredients.map((ingredient, index) => {
                      const quantity =
                        ingredient.kind === "recipe"
                          ? ingredient.grams
                          : ingredient.portion.kind === "serving"
                            ? ingredient.portion.amount
                            : ingredient.portion.grams;
                      const unit =
                        ingredient.kind === "recipe" || ingredient.portion.kind === "grams"
                          ? "grams"
                          : ingredient.portion.servingLabel;
                      return (
                        <li className="ingredientRow" key={ingredient.clientKey}>
                          <div>
                            <strong>{ingredient.name}</strong>
                            <p className="sourceLine">
                              {ingredient.kind === "recipe"
                                ? `Pinned recipe revision ${ingredient.recipeVersionId}`
                                : foodIngredientAttribution(ingredient)}
                            </p>
                            <label className="formField">
                              <span className="srOnly">{ingredient.name} note</span>
                              <input
                                aria-label={`${ingredient.name} note`}
                                maxLength={500}
                                onChange={(event) =>
                                  updateIngredientNote(ingredient.clientKey, event.target.value)
                                }
                                placeholder="Ingredient note (optional)"
                                value={ingredient.note ?? ""}
                              />
                            </label>
                          </div>
                          <label className="formField">
                            <span className="srOnly">
                              {ingredient.name} quantity in {unit}
                            </span>
                            <input
                              aria-label={`${ingredient.name} quantity in ${unit}`}
                              inputMode="decimal"
                              maxLength={19}
                              onChange={(event) =>
                                updateIngredient(ingredient.clientKey, event.target.value)
                              }
                              value={quantity}
                            />
                          </label>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxWidth: 240 }}>
                            <button
                              aria-label={`Move ${ingredient.name} up from position ${index + 1} of ${builder.ingredients.length}`}
                              className="buttonQuiet"
                              disabled={busy !== null || state !== "ready" || index === 0}
                              onClick={() => moveIngredient(ingredient.clientKey, -1)}
                              type="button"
                            >
                              Move up
                            </button>
                            <button
                              aria-label={`Move ${ingredient.name} down from position ${index + 1} of ${builder.ingredients.length}`}
                              className="buttonQuiet"
                              disabled={
                                busy !== null ||
                                state !== "ready" ||
                                index === builder.ingredients.length - 1
                              }
                              onClick={() => moveIngredient(ingredient.clientKey, 1)}
                              type="button"
                            >
                              Move down
                            </button>
                            <button
                              aria-label={`Remove ${ingredient.name} at position ${index + 1} of ${builder.ingredients.length}`}
                              className="buttonDanger"
                              disabled={busy !== null || state !== "ready"}
                              onClick={() => removeIngredient(ingredient.clientKey)}
                              type="button"
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="workspaceForm">
                    <label className="formField">
                      <span>Find a reviewed food</span>
                      <div className="searchInputRow">
                        <input
                          maxLength={128}
                          onChange={(event) => {
                            if (reviewGeneration.current === reviewContext)
                              setQuery(event.target.value);
                          }}
                          placeholder="e.g. rolled oats"
                          value={query}
                        />
                        <button
                          className="buttonSecondary"
                          disabled={searchState === "loading"}
                          onClick={() => void searchFoods()}
                          type="button"
                        >
                          {searchState === "loading" ? "Searching…" : "Search"}
                        </button>
                      </div>
                    </label>
                  </div>
                  {foodResults.length ? (
                    <div className="ingredientSearchResults">
                      {foodResults.map((food) => (
                        <article className="ingredientResult" key={food.foodVersionId}>
                          <div>
                            <strong>{food.name}</strong>
                            <p className="sourceLine">
                              {food.defaultServing?.gramWeight
                                ? `${food.defaultServing.label} · ${food.defaultServing.gramWeight} g`
                                : "No reviewed gram-resolved serving; explicit grams are available"}
                            </p>
                            <p className="sourceLine">
                              {food.source.attributionText} · {food.source.licenseExpression}
                            </p>
                          </div>
                          <div>
                            <button
                              className="buttonQuiet"
                              disabled={
                                !food.defaultServing?.gramWeight || builder.ingredients.length >= 50
                              }
                              onClick={() => addFood(food, "serving")}
                              type="button"
                            >
                              Add serving
                            </button>{" "}
                            <button
                              className="buttonQuiet"
                              disabled={builder.ingredients.length >= 50}
                              onClick={() => addFood(food, "grams")}
                              type="button"
                            >
                              Add 100 g
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  <section className="workspaceSection" aria-labelledby="nested-recipes-heading">
                    <h3 id="nested-recipes-heading">Nested recipe ingredients</h3>
                    <label className="formField" htmlFor="nested-recipe-filter">
                      <span>Filter loaded nested recipes by name</span>
                      <input
                        id="nested-recipe-filter"
                        type="search"
                        maxLength={200}
                        disabled={nestedFilterDisabled}
                        aria-describedby="nested-recipe-filter-status"
                        value={nestedFilterValue}
                        onChange={(event) => changeNestedFilter(event.target.value)}
                      />
                    </label>
                    <button
                      className="buttonQuiet"
                      type="button"
                      disabled={nestedFilterDisabled}
                      onClick={() => changeNestedFilter("")}
                    >
                      Clear nested recipe filter
                    </button>
                    <p className="fieldHelp" id="nested-recipe-filter-status" aria-live="polite">
                      {loadedListVerified ? (
                        <>
                          {visibleNestedRecipes.length} matching · {eligibleNestedRecipes.length}{" "}
                          eligible loaded recipes.
                          {eligibleNestedRecipes.length === 0
                            ? " No eligible nested recipes are loaded."
                            : visibleNestedRecipes.length === 0
                              ? " No loaded nested recipes match this name."
                              : ""}
                          {nextCursor
                            ? " More recipes may be available. Use Load more recipes in Your recipes to include them."
                            : " All saved recipes are loaded."}
                          {builder.recipeId ? " The recipe being edited is excluded." : ""}
                        </>
                      ) : (
                        "Nested recipe choices have not been loaded yet."
                      )}
                    </p>
                    <div className="ingredientSearchResults">
                      {visibleNestedRecipes.map((recipe) => (
                        <article className="ingredientResult" key={recipe.id}>
                          <div>
                            <strong>{recipe.name}</strong>
                            <p className="sourceLine">
                              Version {recipe.versionNumber} · {recipe.finalYieldGrams} g yield
                            </p>
                          </div>
                          <button
                            className="buttonQuiet"
                            aria-label={`Pin 100 g of ${recipe.name} version ${recipe.versionNumber}`}
                            disabled={nestedFilterDisabled || builder.ingredients.length >= 50}
                            onClick={() => addNested(recipe)}
                            type="button"
                          >
                            Add 100 g
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                </section>
                <button
                  className="buttonPrimary"
                  disabled={busy === "save" || builder.ingredients.length === 0}
                  type="submit"
                >
                  {busy === "save"
                    ? "Saving…"
                    : builder.recipeId
                      ? "Publish new revision"
                      : "Create recipe"}
                </button>
              </fieldset>
            </form>
            {selected ? (
              <>
                <section className="workspaceSection" aria-labelledby="warnings-heading">
                  <h3 id="warnings-heading">Calculation assumptions & warnings</h3>
                  <ul className="warningList">
                    <li>
                      <strong>{selected.retentionPolicy.code.replaceAll("-", " ")}</strong>
                      <br />
                      {selected.retentionPolicy.assumption}
                    </li>
                    {selected.warnings.map((warning) => (
                      <li key={warning.code}>
                        <strong>{warning.code.replaceAll("_", " ")}</strong>
                        <br />
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                  <p className="coverageCopy">
                    Retention factors default to one unless a warning identifies a named, reviewed
                    factor set. This is not a claim that cooking retained every nutrient.
                  </p>
                </section>
                <section className="workspaceSection" aria-labelledby="nutrition-heading">
                  <h3 id="nutrition-heading">Saved recipe nutrition</h3>
                  <p className="coverageCopy">
                    {selected.name} · Saved version {selected.versionNumber}. Unsaved recipe edits
                    and the diary logging amount do not change these values.
                  </p>
                  <fieldset disabled={busy !== null || state !== "ready"}>
                    <legend>Nutrition basis</legend>
                    <button
                      aria-pressed={nutritionBasis === "per100Grams"}
                      className={nutritionBasis === "per100Grams" ? "buttonPrimary" : "buttonQuiet"}
                      onClick={() => selectNutritionBasis("per100Grams")}
                      type="button"
                    >
                      Per 100 g
                    </button>{" "}
                    {selected.nutrientsPerServing !== null ? (
                      <button
                        aria-pressed={nutritionBasis === "perServing"}
                        className={
                          nutritionBasis === "perServing" ? "buttonPrimary" : "buttonQuiet"
                        }
                        onClick={() => selectNutritionBasis("perServing")}
                        type="button"
                      >
                        Per serving ({selected.servingLabel ?? "serving"})
                      </button>
                    ) : null}
                  </fieldset>
                  <table className="nutritionTable">
                    <caption>
                      {nutritionBasis === "perServing"
                        ? `Per serving (${selected.servingLabel ?? "serving"})`
                        : "Per 100 g"}
                    </caption>
                    <thead>
                      <tr>
                        <th>Nutrient</th>
                        <th>Coverage</th>
                        <th>Known amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(nutritionBasis === "perServing" && selected.nutrientsPerServing !== null
                        ? selected.nutrientsPerServing
                        : selected.nutrientsPer100Grams
                      ).map((nutrient) => {
                        const display = nutrientDisplay(nutrient);
                        return (
                          <tr key={nutrient.nutrientId}>
                            <td>{nutrient.name}</td>
                            <td>{display.qualification}</td>
                            <td>{display.amount}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
                <section className="workspaceSection" aria-labelledby="source-heading">
                  <h3 id="source-heading">Transitive source provenance</h3>
                  {recipeAttribution.map((line) => (
                    <p className="sourceLine" key={line}>
                      {line}
                    </p>
                  ))}
                </section>
                <section className="workspaceSection" aria-labelledby="log-heading">
                  <h3 id="log-heading">Log this exact revision</h3>
                  <div className="formGrid">
                    <label className="formField">
                      <span>Portion</span>
                      <select
                        disabled={logControlsUnavailable}
                        onChange={(event) => {
                          changeLogField(
                            logKind,
                            event.target.value as "grams" | "serving",
                            setLogKind,
                          );
                        }}
                        value={logKind}
                      >
                        <option value="grams">Grams</option>
                        {selected.servingCount ? (
                          <option value="serving">{selected.servingLabel ?? "Serving"}</option>
                        ) : null}
                      </select>
                    </label>
                    <label className="formField">
                      <span>Amount</span>
                      <input
                        inputMode="decimal"
                        maxLength={19}
                        disabled={logControlsUnavailable}
                        onChange={(event) => {
                          changeLogField(logAmount, event.target.value, setLogAmount);
                        }}
                        value={logAmount}
                      />
                    </label>
                    <label className="formField">
                      <span>Local diary date</span>
                      <input
                        maxLength={10}
                        disabled={logControlsUnavailable}
                        onChange={(event) => {
                          changeLogField(date, event.target.value, setDate);
                        }}
                        value={date}
                      />
                    </label>
                    <label className="formField">
                      <span>Local time (optional)</span>
                      <input
                        ref={logTimeInput}
                        type="time"
                        step={60}
                        disabled={logControlsUnavailable}
                        onChange={(event) => {
                          changeLogField(logTime, event.target.value, setLogTime);
                        }}
                        value={logRouteReady ? logTime : ""}
                      />
                    </label>
                    <label className="formField">
                      <span>Meal</span>
                      <select
                        disabled={logControlsUnavailable}
                        onChange={(event) => {
                          changeLogField(mealSlot, event.target.value as MealSlot, setMealSlot);
                        }}
                        value={mealSlot}
                      >
                        {diaryGroups.map((group) => (
                          <option key={group.mealSlot} value={group.mealSlot}>
                            {group.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="fieldHelp">
                    Interpreted in {timeZone ?? "your verified profile zone"}. Leave time blank to
                    use the current instant for today or noon for another day. The diary snapshot
                    pins recipe version {selected.versionNumber}.
                  </p>
                  {dateReviewRequired ? (
                    <button
                      className="buttonSecondary"
                      disabled={!timeZone || logControlsUnavailable}
                      onClick={confirmRecipeDateReview}
                      type="button"
                    >
                      {logTime
                        ? `Confirm ${date} at ${logTime} in ${timeZone}`
                        : `Confirm ${date} as local day`}
                    </button>
                  ) : null}{" "}
                  <button
                    className="buttonPrimary"
                    disabled={dateReviewRequired || !timeZone || logControlsUnavailable}
                    onClick={() => void logRecipe()}
                    type="button"
                  >
                    {busy === "log" ? "Logging…" : "Log recipe"}
                  </button>{" "}
                  <Link className="buttonQuiet" href={`/dashboard?date=${date}`}>
                    Open diary
                  </Link>
                </section>
              </>
            ) : null}
          </section>
        </div>
      </section>
    </>
  );
}

function recipeBodyFromBuilder(builder: BuilderState) {
  const name = builder.name.normalize("NFKC").trim();
  if (!name || name.length > 200) throw new RangeError("Recipe name is required.");
  if (!isRecipePositiveDecimal(builder.yieldGrams))
    throw new RangeError("Final yield must be a positive gram amount.");
  if (builder.ingredients.length < 1 || builder.ingredients.length > 50)
    throw new RangeError("Add between 1 and 50 ingredients.");
  if (builder.servingCount && !isRecipePositiveDecimal(builder.servingCount))
    throw new RangeError("Serving count must be a positive decimal.");
  for (const ingredient of builder.ingredients) {
    const quantity =
      ingredient.kind === "recipe"
        ? ingredient.grams
        : ingredient.portion.kind === "serving"
          ? ingredient.portion.amount
          : ingredient.portion.grams;
    if (!isRecipePositiveDecimal(quantity))
      throw new RangeError(`${ingredient.name} needs a positive quantity.`);
  }
  return {
    name,
    description: builder.description.trim() || null,
    instructions: builder.instructions.trim() || null,
    ingredients: builder.ingredients.map(ingredientRequest),
    finalYield: { grams: builder.yieldGrams, source: builder.yieldSource },
    servingCount: builder.servingCount || null,
    servingLabel: builder.servingCount
      ? builder.servingLabel.normalize("NFKC").trim() || "serving"
      : null,
  };
}
