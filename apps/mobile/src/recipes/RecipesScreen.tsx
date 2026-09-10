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
import { newOperationId } from "../auth/operation-id";
import {
  type DiaryGroup,
  defaultMealForTime,
  diaryGroupLabel,
  isLocalDate,
  localDateInTimeZone,
  type MealSlot,
  nutrientDisplay,
  parseSession,
  quickAddOccurredAt,
} from "../diary/diary";
import {
  MAX_QUICK_ADD_OUTBOX_ITEMS,
  QuickAddEnqueueAmbiguousError,
  type QuickAddOutboxController,
  type QuickAddOutboxControllerState,
  type QuickAddReceipt,
} from "../diary/quick-add-outbox";
import { buildSearchUrl, type FoodSearchHit, parseSearchPage } from "../search/food-search";
import { palette } from "../theme";
import { PastedIngredientReview } from "./PastedIngredientReview";
import {
  isRecipePositiveDecimal,
  mergeRecipePage,
  parseRecipeCollection,
  parseRecipeMutation,
  parseRecipeResponse,
  prepareStableMutation,
  type RecipeIngredientDraft,
  type RecipeSummaryView,
  type RecipeView,
  recipeDraftIngredients,
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "./recipes-goals";

interface Props {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly ownerUserId: string;
  readonly profileTimeZone: string;
  readonly diaryGroups: readonly DiaryGroup[];
  readonly onUnauthorized: () => Promise<void>;
  readonly onLogged: (date: string) => void;
  readonly onGoals: () => void;
  readonly quickAddOutboxController: QuickAddOutboxController;
  readonly quickAddOutboxState: QuickAddOutboxControllerState;
  readonly subscribeQuickAddReceipts: (listener: (receipt: QuickAddReceipt) => void) => () => void;
}

interface Builder {
  readonly recipeId: string | null;
  readonly revision: string | null;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly yieldGrams: string;
  readonly yieldSource: "estimated" | "measured";
  readonly servingCount: string;
  readonly servingLabel: string;
  readonly ingredients: readonly RecipeIngredientDraft[];
}

function emptyBuilder(): Builder {
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

export function mobileBuilderFromRecipe(recipe: RecipeView): Builder {
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
    ingredients: recipeDraftIngredients(recipe),
  };
}

export function mobileFoodIngredient(
  food: FoodSearchHit,
  mode: "grams" | "serving",
): RecipeIngredientDraft {
  if (mode === "serving" && !food.defaultServing?.gramWeight)
    throw new RangeError("No reviewed gram-resolved serving is available.");
  const serving = food.defaultServing;
  return {
    kind: "food",
    clientKey: newOperationId(),
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
    source: {
      displayName: food.source.displayName,
      licenseExpression: food.source.licenseExpression,
      attributionText: food.source.attributionText,
    },
    foodProvenance: {
      kind: "public",
      source: {
        displayName: food.source.displayName,
        licenseExpression: food.source.licenseExpression,
        attributionText: food.source.attributionText,
      },
    },
    note: null,
  };
}

function requestBody(builder: Builder) {
  const name = builder.name.normalize("NFKC").trim();
  if (!name || name.length > 200) throw new RangeError("Recipe name is required.");
  if (!isRecipePositiveDecimal(builder.yieldGrams))
    throw new RangeError("Final yield must be a positive gram amount.");
  if (builder.ingredients.length < 1 || builder.ingredients.length > 50)
    throw new RangeError("Add between 1 and 50 ingredients.");
  if (builder.servingCount && !isRecipePositiveDecimal(builder.servingCount))
    throw new RangeError("Serving count must be positive.");
  const ingredients = builder.ingredients.map((ingredient, position) => {
    const quantity =
      ingredient.kind === "recipe"
        ? ingredient.grams
        : ingredient.portion.kind === "serving"
          ? ingredient.portion.amount
          : ingredient.portion.grams;
    if (!isRecipePositiveDecimal(quantity))
      throw new RangeError(`${ingredient.name} needs a positive quantity.`);
    return ingredient.kind === "recipe"
      ? {
          kind: "recipe" as const,
          recipeVersionId: ingredient.recipeVersionId,
          grams: ingredient.grams,
          position,
          note: ingredient.note,
        }
      : {
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
  });
  return {
    name,
    description: builder.description.trim() || null,
    instructions: builder.instructions.trim() || null,
    ingredients,
    finalYield: { grams: builder.yieldGrams, source: builder.yieldSource },
    servingCount: builder.servingCount || null,
    servingLabel: builder.servingCount ? builder.servingLabel.trim() || "serving" : null,
  };
}

function foodIngredientAttribution(
  ingredient: Extract<RecipeIngredientDraft, { readonly kind: "food" }>,
): string {
  if (ingredient.foodProvenance.kind === "private_custom") {
    return `Owner-entered private custom food, pinned version ${ingredient.foodProvenance.customFoodVersionNumber}`;
  }
  return ingredient.source?.attributionText ?? "Public source metadata unavailable";
}

export function RecipesScreen({
  apiBase,
  accessToken,
  ownerUserId,
  profileTimeZone,
  diaryGroups,
  onUnauthorized,
  onLogged,
  onGoals,
  quickAddOutboxController,
  quickAddOutboxState,
  subscribeQuickAddReceipts,
}: Props) {
  const [recipes, setRecipes] = useState<readonly RecipeSummaryView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecipeView | null>(null);
  const [nutritionBasis, setNutritionBasis] = useState<"100g" | "serving">("100g");
  const selectedRef = useRef(selected);
  const [builder, setBuilderState] = useState<Builder>(emptyBuilder);
  const [message, setMessage] = useState("Loading your private recipes…");
  const [loading, setLoading] = useState(true);
  const [busy, setBusyState] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foods, setFoods] = useState<readonly FoodSearchHit[]>([]);
  const [date, setDate] = useState(() => localDateInTimeZone(new Date(), profileTimeZone));
  const [meal, setMeal] = useState<MealSlot>(() => defaultMealForTime());
  const [logKind, setLogKind] = useState<"grams" | "serving">("serving");
  const [logAmount, setLogAmount] = useState("1");
  const [ready, setReadyState] = useState(false);
  const [closed, setClosed] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);
  const scopeRef = useRef({ ownerUserId, accessToken, apiBase: apiBase.toString() });
  if (
    scopeRef.current.ownerUserId !== ownerUserId ||
    scopeRef.current.accessToken !== accessToken ||
    scopeRef.current.apiBase !== apiBase.toString()
  )
    scopeRef.current = { ownerUserId, accessToken, apiBase: apiBase.toString() };
  const scope = scopeRef.current;
  const installedScope = useRef<typeof scope | null>(null);
  const mounted = useRef(false);
  const privateClosed = useRef(false);
  const active = useRef(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const lifecycle = useRef(0);
  const builderRef = useRef(builder);
  const builderGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const busyRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const builderRequest = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const pending = useRef(new Map<string, StableMutation<ReturnType<typeof requestBody>>>());
  const recipeLogEnqueueInFlight = useRef(false);
  const ownedRecipeLogOperations = useRef(new Set<string>());
  const onLoggedRef = useRef(onLogged);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onLoggedRef.current = onLogged;
  onUnauthorizedRef.current = onUnauthorized;

  const setBusy = useCallback((value: string | null) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const setReady = useCallback((value: boolean) => {
    readyRef.current = value;
    setReadyState(value);
  }, []);
  const replaceSelected = useCallback((recipe: RecipeView | null) => {
    selectedRef.current = recipe;
    setSelected(recipe);
    setNutritionBasis(recipe?.nutrientsPerServing ? "serving" : "100g");
  }, []);
  const replaceBuilder = useCallback((value: Builder) => {
    builderRef.current = value;
    builderGeneration.current += 1;
    setBuilderState(value);
  }, []);
  const invalidateReview = useCallback(() => {
    reviewGeneration.current += 1;
    setReviewKey(reviewGeneration.current);
  }, []);
  const abortRequests = useCallback(() => {
    builderRequest.current?.abort();
    listRequest.current?.abort();
    builderRequest.current = null;
    listRequest.current = null;
  }, []);
  const scopeIsCurrent = useCallback(
    (epoch: number) =>
      mounted.current &&
      !privateClosed.current &&
      active.current &&
      scopeRef.current === scope &&
      installedScope.current === scope &&
      lifecycle.current === epoch,
    [scope],
  );
  const closeSession = useCallback(() => {
    if (!mounted.current || privateClosed.current || scopeRef.current !== scope) return;
    privateClosed.current = true;
    lifecycle.current += 1;
    abortRequests();
    invalidateReview();
    pending.current.clear();
    ownedRecipeLogOperations.current.clear();
    replaceBuilder(emptyBuilder());
    setRecipes([]);
    replaceSelected(null);
    setNextCursor(null);
    setQuery("");
    setFoods([]);
    setReady(false);
    setClosed(true);
    setBusy(null);
    setLoading(false);
    setMessage("Closing your private recipe workspace…");
    void onUnauthorizedRef.current();
  }, [abortRequests, invalidateReview, replaceBuilder, replaceSelected, scope, setBusy, setReady]);

  const verifyOwner = useCallback(
    async (controller: AbortController, current: () => boolean) => {
      const response = await fetch(apiUrl(new URL(scope.apiBase), "/v1/auth/me").toString(), {
        headers: authenticatedHeaders(scope.accessToken),
        signal: controller.signal,
      });
      if (!current()) return false;
      if (response.status === 401) {
        closeSession();
        return false;
      }
      if (!response.ok) throw new Error("Your recipe session could not be checked. Try again.");
      const body = await jsonBody(response);
      if (!current()) return false;
      if (parseSession(body).user.id !== scope.ownerUserId) {
        closeSession();
        return false;
      }
      return true;
    },
    [closeSession, scope],
  );

  useEffect(() => {
    installedScope.current = scope;
    mounted.current = true;
    privateClosed.current = false;
    lifecycle.current += 1;
    active.current = AppState.currentState !== "background" && AppState.currentState !== "inactive";
    abortRequests();
    invalidateReview();
    pending.current.clear();
    ownedRecipeLogOperations.current.clear();
    replaceBuilder(emptyBuilder());
    setRecipes([]);
    replaceSelected(null);
    setNextCursor(null);
    setQuery("");
    setFoods([]);
    setBusy(null);
    setReady(false);
    setClosed(false);
    return () => {
      mounted.current = false;
      installedScope.current = null;
      lifecycle.current += 1;
      abortRequests();
      reviewGeneration.current += 1;
      builderRef.current = emptyBuilder();
      pending.current.clear();
      ownedRecipeLogOperations.current.clear();
    };
  }, [abortRequests, invalidateReview, replaceBuilder, replaceSelected, scope, setBusy, setReady]);

  const loadRecipes = useCallback(
    async (cursor: string | null = null) => {
      const epoch = lifecycle.current;
      if (!scopeIsCurrent(epoch)) return;
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      const current = () =>
        scopeIsCurrent(epoch) && !controller.signal.aborted && listRequest.current === controller;
      setLoading(true);
      setReady(false);
      try {
        const url = apiUrl(new URL(scope.apiBase), "/v1/recipes");
        url.searchParams.set("limit", "50");
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const response = await fetch(url.toString(), {
          headers: authenticatedHeaders(scope.accessToken),
          signal: controller.signal,
        });
        if (!current()) return;
        if (response.status === 401) {
          closeSession();
          return;
        }
        const body = await jsonBody(response);
        if (!current()) return;
        if (!response.ok) throw new Error(responseError(body, "Recipes could not be loaded."));
        const page = parseRecipeCollection(body);
        if (!(await verifyOwner(controller, current)) || !current()) return;
        setRecipes((existing) => mergeRecipePage(existing, page.data, cursor !== null));
        setNextCursor(page.nextCursor);
        setReady(true);
        setMessage(
          page.data.length
            ? `Recipes loaded${page.nextCursor ? "; more available" : ""}.`
            : "No recipes yet.",
        );
      } catch (caught) {
        if (current())
          setMessage(caught instanceof Error ? caught.message : "Recipes could not be loaded.");
      } finally {
        if (current()) {
          setLoading(false);
          listRequest.current = null;
        }
      }
    },
    [closeSession, scope, scopeIsCurrent, setReady, verifyOwner],
  );

  useEffect(() => {
    void loadRecipes();
  }, [loadRecipes]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (!mounted.current || privateClosed.current || scopeRef.current !== scope) return;
      if (state !== "active") {
        active.current = false;
        lifecycle.current += 1;
        abortRequests();
        invalidateReview();
        setBusy(null);
        setReady(false);
        setLoading(false);
      } else if (!active.current) {
        active.current = true;
        void loadRecipes();
      }
    });
    return () => subscription.remove();
  }, [abortRequests, invalidateReview, loadRecipes, scope, setBusy, setReady]);
  useEffect(() => {
    return subscribeQuickAddReceipts((receipt) => {
      if (
        !scopeIsCurrent(lifecycle.current) ||
        !ownedRecipeLogOperations.current.delete(receipt.operationId)
      )
        return;
      const entry = receipt.mutation.entry;
      if (entry?.entryKind !== "recipe") {
        setMessage(
          "The queued recipe was accepted, but its diary day could not be read. Refresh the diary before logging it again.",
        );
        return;
      }
      const loggedDate = entry.localDate;
      const loggedGroup = diaryGroupLabel(diaryGroups, entry.mealSlot);
      setMessage(
        receipt.mutation.replayed
          ? `The earlier queued ${loggedGroup} recipe log on ${loggedDate} was confirmed safely.`
          : `The queued recipe was confirmed in ${loggedGroup} on ${loggedDate}.`,
      );
      onLoggedRef.current(loggedDate);
    });
  }, [diaryGroups, scopeIsCurrent, subscribeQuickAddReceipts]);

  const renderEpoch = lifecycle.current;
  const renderReview = reviewGeneration.current;
  function canEdit(expectedReview = renderReview) {
    return (
      scopeIsCurrent(renderEpoch) &&
      reviewGeneration.current === expectedReview &&
      readyRef.current &&
      busyRef.current === null
    );
  }
  function selectNutritionBasis(basis: "100g" | "serving") {
    if (
      !canEdit() ||
      !selected ||
      selectedRef.current !== selected ||
      (basis === "serving" && selected.nutrientsPerServing === null)
    )
      return;
    setNutritionBasis(basis);
  }
  function updateBuilder(change: (current: Builder) => Builder) {
    if (canEdit()) replaceBuilder(change(builderRef.current));
  }
  function confirmReviewedIngredients(ingredients: readonly RecipeIngredientDraft[]): boolean {
    const current = builderRef.current;
    if (
      !canEdit() ||
      renderReview !== reviewGeneration.current ||
      current.recipeId !== null ||
      ingredients.length === 0 ||
      current.ingredients.length + ingredients.length > 50
    )
      return false;
    const keys = new Set(current.ingredients.map((ingredient) => ingredient.clientKey));
    for (const ingredient of ingredients) {
      if (
        ingredient.kind !== "food" ||
        ingredient.note !== null ||
        ingredient.foodProvenance.kind !== "public" ||
        keys.has(ingredient.clientKey)
      )
        return false;
      const quantity =
        ingredient.portion.kind === "grams" ? ingredient.portion.grams : ingredient.portion.amount;
      if (!isRecipePositiveDecimal(quantity)) return false;
      keys.add(ingredient.clientKey);
    }
    invalidateReview();
    replaceBuilder({ ...current, ingredients: [...current.ingredients, ...ingredients] });
    setMessage(
      `${ingredients.length} reviewed ingredients added. Review the final yield before creating the recipe.`,
    );
    return true;
  }
  function startNewRecipe() {
    if (
      !scopeIsCurrent(renderEpoch) ||
      reviewGeneration.current !== renderReview ||
      !readyRef.current ||
      busyRef.current === "log"
    )
      return;
    builderRequest.current?.abort();
    builderRequest.current = null;
    invalidateReview();
    replaceBuilder(emptyBuilder());
    replaceSelected(null);
    setFoods([]);
    setQuery("");
    setBusy(null);
    setLogKind("grams");
    setLogAmount("1");
    setMessage("New recipe builder opened.");
  }
  function beginBuilderRequest(label: string, expectedReview = renderReview) {
    if (!canEdit(expectedReview)) return null;
    const controller = new AbortController();
    builderRequest.current = controller;
    const generation = builderGeneration.current;
    const current = () =>
      scopeIsCurrent(renderEpoch) &&
      builderGeneration.current === generation &&
      !controller.signal.aborted &&
      builderRequest.current === controller;
    setBusy(label);
    return { controller, current };
  }
  async function open(recipeId: string, successMessage?: string, expectedReview = renderReview) {
    const request = beginBuilderRequest(`open:${recipeId}`, expectedReview);
    if (!request) return;
    const { controller, current } = request;
    invalidateReview();
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/recipes/${recipeId}`).toString(), {
        headers: authenticatedHeaders(accessToken),
        signal: controller.signal,
      });
      if (!current()) return;
      if (response.status === 401) {
        closeSession();
        return;
      }
      const body = await jsonBody(response);
      if (!current()) return;
      if (!response.ok) throw new Error(responseError(body, "The recipe could not be loaded."));
      const recipe = parseRecipeResponse(body);
      if (!(await verifyOwner(controller, current)) || !current()) return;
      replaceSelected(recipe);
      setLogKind(recipeLogKindFor(recipe));
      setMessage(successMessage ?? `Recipe version ${recipe.versionNumber} loaded.`);
      setBusy(null);
      builderRequest.current = null;
      replaceBuilder(mobileBuilderFromRecipe(recipe));
    } catch (caught) {
      if (current())
        setMessage(caught instanceof Error ? caught.message : "The recipe could not be loaded.");
    } finally {
      if (current()) {
        setBusy(null);
        builderRequest.current = null;
      }
    }
  }
  async function search() {
    const request = beginBuilderRequest("search");
    if (!request) return;
    const { controller, current } = request;
    try {
      const response = await fetch(buildSearchUrl(apiBase, query, "all").toString(), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!current()) return;
      const body = await jsonBody(response);
      if (!current()) return;
      if (!response.ok) throw new Error("Food search is unavailable.");
      const page = parseSearchPage(body);
      if (!(await verifyOwner(controller, current)) || !current()) return;
      setFoods(page.data);
    } catch (caught) {
      if (current()) {
        setFoods([]);
        setMessage(caught instanceof Error ? caught.message : "Food search is unavailable.");
      }
    } finally {
      if (current()) {
        setBusy(null);
        builderRequest.current = null;
      }
    }
  }
  function addFood(food: FoodSearchHit, mode: "grams" | "serving") {
    if (!canEdit()) return;
    const current = builderRef.current;
    if (current.ingredients.length >= 50) {
      setMessage("A recipe supports at most 50 ingredients.");
      return;
    }
    try {
      replaceBuilder({
        ...current,
        ingredients: [...current.ingredients, mobileFoodIngredient(food, mode)],
      });
      setMessage(`${food.name} added.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The food could not be added.");
    }
  }
  function addNested(recipe: RecipeSummaryView) {
    if (!canEdit()) return;
    const current = builderRef.current;
    if (recipe.id === current.recipeId) {
      setMessage("A recipe cannot contain itself.");
      return;
    }
    if (current.ingredients.length >= 50) return;
    replaceBuilder({
      ...current,
      ingredients: [
        ...current.ingredients,
        {
          kind: "recipe",
          clientKey: newOperationId(),
          recipeId: recipe.id,
          recipeVersionId: recipe.versionId,
          name: recipe.name,
          grams: "100",
          note: null,
        },
      ],
    });
  }
  function updateQuantity(clientKey: string, quantity: string) {
    updateBuilder((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient) =>
        ingredient.clientKey !== clientKey
          ? ingredient
          : ingredient.kind === "recipe"
            ? { ...ingredient, grams: quantity }
            : {
                ...ingredient,
                portion:
                  ingredient.portion.kind === "serving"
                    ? { ...ingredient.portion, amount: quantity }
                    : { ...ingredient.portion, grams: quantity },
              },
      ),
    }));
  }
  function updateNote(clientKey: string, note: string) {
    updateBuilder((current) => ({
      ...current,
      ingredients: current.ingredients.map((ingredient) =>
        ingredient.clientKey === clientKey ? { ...ingredient, note: note || null } : ingredient,
      ),
    }));
  }
  async function save() {
    if (!canEdit()) return;
    const snapshot = builderRef.current;
    let body: ReturnType<typeof requestBody>;
    try {
      body = requestBody(snapshot);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the recipe.");
      return;
    }
    const key = `${snapshot.recipeId ?? "create"}:${snapshot.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(pending.current, key, () => body, newOperationId);
    pending.current.set(key, operation);
    const request = beginBuilderRequest("save");
    if (!request) return;
    const { controller, current } = request;
    invalidateReview();
    try {
      if (!(await verifyOwner(controller, current)) || !current()) return;
      const path = snapshot.recipeId ? `/v1/recipes/${snapshot.recipeId}/revisions` : "/v1/recipes";
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        method: "POST",
        signal: controller.signal,
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(snapshot.revision ? { "if-match": `"${snapshot.revision}"` } : {}),
        }),
        body: JSON.stringify(operation.body),
      });
      if (!current()) return;
      if (response.status === 401) {
        closeSession();
        return;
      }
      const responseBody = await jsonBody(response);
      if (!current()) return;
      if (response.status === 412) {
        pending.current.delete(key);
        setBusy(null);
        builderRequest.current = null;
        if (snapshot.recipeId)
          await open(
            snapshot.recipeId,
            "The recipe changed elsewhere. Fresh values were loaded.",
            reviewGeneration.current,
          );
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The recipe could not be saved."));
      const mutation = parseRecipeMutation(responseBody);
      if (!(await verifyOwner(controller, current)) || !current()) return;
      pending.current.delete(key);
      replaceSelected(mutation.recipe);
      setLogKind(recipeLogKindFor(mutation.recipe));
      setLogAmount("1");
      setBusy(null);
      builderRequest.current = null;
      replaceBuilder(mobileBuilderFromRecipe(mutation.recipe));
      const installedGeneration = builderGeneration.current;
      await loadRecipes();
      if (scopeIsCurrent(renderEpoch) && builderGeneration.current === installedGeneration)
        setMessage(
          mutation.replayed
            ? "The earlier save was confirmed safely."
            : `Recipe version ${mutation.recipe.versionNumber} published.`,
        );
    } catch (caught) {
      if (current())
        setMessage(
          `${caught instanceof Error ? caught.message : "The recipe could not be saved."} Press Save again to retry safely.`,
        );
    } finally {
      if (current()) {
        setBusy(null);
        builderRequest.current = null;
      }
    }
  }

  async function log() {
    if (!canEdit()) return;
    const epoch = lifecycle.current;
    const canRegisterReceipt = () =>
      mounted.current &&
      !privateClosed.current &&
      scopeRef.current === scope &&
      installedScope.current === scope;
    if (!selected || !isLocalDate(date) || !isRecipePositiveDecimal(logAmount)) {
      setMessage("Choose a real local date and positive amount.");
      return;
    }
    if (recipeLogEnqueueInFlight.current) {
      setMessage("Wait for the current recipe log to be secured on this device.");
      return;
    }
    const currentQueue = quickAddOutboxController.getState();
    if (currentQueue.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS) {
      setMessage(
        `The secure diary queue is full at ${MAX_QUICK_ADD_OUTBOX_ITEMS} items. Review queued logs before adding another.`,
      );
      return;
    }
    if (
      currentQueue.status === "closed" ||
      currentQueue.status === "owner_mismatch" ||
      (currentQueue.status === "unavailable" &&
        (currentQueue.reason === "storage" || currentQueue.reason === "credential"))
    ) {
      setMessage("Diary logging is unavailable until secure storage and authentication recover.");
      return;
    }
    const effectiveLogKind = selected.servingCount === null ? "grams" : logKind;
    let occurredAt: string;
    try {
      occurredAt = quickAddOccurredAt(date, profileTimeZone, new Date());
    } catch {
      setMessage("That local date is not valid in your diary time zone.");
      return;
    }
    recipeLogEnqueueInFlight.current = true;
    setBusy("log");
    try {
      const item = await quickAddOutboxController.enqueueOperation({
        operationKind: "recipe",
        recipeName: selected.name,
        recipeId: selected.id,
        recipeVersionId: selected.versionId,
        portion:
          effectiveLogKind === "grams"
            ? { kind: "grams", grams: logAmount }
            : {
                kind: "serving",
                amount: logAmount,
                servingLabel: selected.servingLabel ?? "serving",
              },
        mealSlot: meal,
        localDate: date,
        occurredAt,
      });
      if (canRegisterReceipt()) ownedRecipeLogOperations.current.add(item.operationId);
      if (scopeIsCurrent(epoch)) {
        setMessage(
          `${selected.name} is queued securely for ${diaryGroupLabel(diaryGroups, meal)} on ${date}. It is not included in diary totals until the server confirms it.`,
        );
      }
      // Release this operation's registration hold even when its screen has closed.
      // The captured controller owns foreground, credential and owner drain fences.
      void quickAddOutboxController.requestDrain(item.operationId);
    } catch (caught) {
      if (caught instanceof QuickAddEnqueueAmbiguousError) {
        if (canRegisterReceipt()) ownedRecipeLogOperations.current.add(caught.operationId);
        if (scopeIsCurrent(epoch)) {
          setMessage(
            "Secure storage could not confirm whether the recipe was queued. Do not press Log again until the queue status recovers.",
          );
        }
        void quickAddOutboxController.requestDrain(caught.operationId);
      } else if (scopeIsCurrent(epoch)) {
        setMessage(
          "The recipe was not queued. Refresh this screen and try again after the diary session is current.",
        );
      }
    } finally {
      recipeLogEnqueueInFlight.current = false;
      if (scopeIsCurrent(epoch)) setBusy(null);
    }
  }

  const scopeVisible = installedScope.current === scope && !closed;
  const builderDisabled = busy !== null || !ready || !scopeVisible;
  const recipeLogUnavailable =
    builderDisabled ||
    quickAddOutboxState.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS ||
    quickAddOutboxState.status === "closed" ||
    quickAddOutboxState.status === "owner_mismatch" ||
    (quickAddOutboxState.status === "unavailable" &&
      (quickAddOutboxState.reason === "storage" || quickAddOutboxState.reason === "credential"));

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.nav}>
          <Pressable accessibilityRole="button" onPress={onGoals}>
            <Text style={styles.navText}>Goals →</Text>
          </Pressable>
        </View>
        <Text style={styles.kicker}>VERSIONED RECIPE WORKSPACE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Recipes
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {scopeVisible ? message : "Loading your private recipes…"}
        </Text>
        {loading ? <ActivityIndicator color={palette.forest} /> : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            disabled={!ready || !scopeVisible || busy === "log"}
            onPress={startNewRecipe}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>New recipe</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={loading || !scopeVisible}
            onPress={() => void loadRecipes()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Refresh</Text>
          </Pressable>
        </View>
        {scopeVisible
          ? recipes.map((recipe) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: selected?.id === recipe.id }}
                key={recipe.id}
                disabled={builderDisabled}
                onPress={() => void open(recipe.id)}
                style={styles.recipeCard}
              >
                <Text style={styles.cardTitle}>{recipe.name}</Text>
                <Text style={styles.meta}>
                  v{recipe.versionNumber} · {recipe.finalYieldGrams} g · {recipe.warningCount}{" "}
                  warnings
                </Text>
              </Pressable>
            ))
          : null}
        {scopeVisible && nextCursor ? (
          <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={() => void loadRecipes(nextCursor)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{loading ? "Loading…" : "Load more recipes"}</Text>
          </Pressable>
        ) : null}
        {scopeVisible ? (
          <View style={styles.panel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {builder.recipeId ? `Revise ${builder.name}` : "Recipe builder"}
            </Text>
            <Field
              disabled={builderDisabled}
              label="Recipe name"
              maxLength={200}
              value={builder.name}
              onChange={(name) => updateBuilder((current) => ({ ...current, name }))}
            />
            <Field
              disabled={builderDisabled}
              label="Final yield grams"
              maxLength={19}
              value={builder.yieldGrams}
              onChange={(yieldGrams) => updateBuilder((current) => ({ ...current, yieldGrams }))}
              numeric
            />
            <View style={styles.row}>
              <Chip
                disabled={builderDisabled}
                active={builder.yieldSource === "measured"}
                label="Measured yield"
                onPress={() =>
                  updateBuilder((current) => ({ ...current, yieldSource: "measured" }))
                }
              />
              <Chip
                disabled={builderDisabled}
                active={builder.yieldSource === "estimated"}
                label="Estimated yield"
                onPress={() =>
                  updateBuilder((current) => ({ ...current, yieldSource: "estimated" }))
                }
              />
            </View>
            <Field
              disabled={builderDisabled}
              label="Serving count (optional)"
              maxLength={19}
              value={builder.servingCount}
              onChange={(servingCount) =>
                updateBuilder((current) => ({ ...current, servingCount }))
              }
              numeric
            />
            <Field
              disabled={builderDisabled}
              label="Serving label"
              maxLength={100}
              value={builder.servingLabel}
              onChange={(servingLabel) =>
                updateBuilder((current) => ({ ...current, servingLabel }))
              }
            />
            <Field
              disabled={builderDisabled}
              label="Description"
              maxLength={2_000}
              value={builder.description}
              onChange={(description) => updateBuilder((current) => ({ ...current, description }))}
              multiline
            />
            <Field
              disabled={builderDisabled}
              label="Instructions"
              maxLength={10_000}
              value={builder.instructions}
              onChange={(instructions) =>
                updateBuilder((current) => ({ ...current, instructions }))
              }
              multiline
            />
            <Text style={styles.sectionTitle}>Ingredients ({builder.ingredients.length}/50)</Text>
            {builder.ingredients.map((ingredient) => {
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
                <View key={ingredient.clientKey} style={styles.ingredient}>
                  <Text
                    accessibilityLabel={`${ingredient.name}, ${quantity} ${unit}. ${ingredient.kind === "recipe" ? `Pinned recipe revision ${ingredient.recipeVersionId}` : foodIngredientAttribution(ingredient)}.`}
                    style={styles.cardTitle}
                  >
                    {ingredient.name}
                  </Text>
                  <Text style={styles.meta}>
                    {ingredient.kind === "recipe"
                      ? `Pinned revision ${ingredient.recipeVersionId}`
                      : foodIngredientAttribution(ingredient)}
                  </Text>
                  <Field
                    disabled={builderDisabled}
                    label={`Quantity in ${unit}`}
                    maxLength={19}
                    value={quantity}
                    onChange={(value) => updateQuantity(ingredient.clientKey, value)}
                    numeric
                  />
                  <Field
                    disabled={builderDisabled}
                    label={`${ingredient.name} note (optional)`}
                    maxLength={500}
                    value={ingredient.note ?? ""}
                    onChange={(value) => updateNote(ingredient.clientKey, value)}
                  />
                  <Pressable
                    disabled={builderDisabled}
                    accessibilityLabel={`Remove ${ingredient.name}`}
                    accessibilityRole="button"
                    onPress={() =>
                      updateBuilder((current) => ({
                        ...current,
                        ingredients: current.ingredients.filter(
                          (candidate) => candidate.clientKey !== ingredient.clientKey,
                        ),
                      }))
                    }
                  >
                    <Text style={styles.danger}>Remove</Text>
                  </Pressable>
                </View>
              );
            })}
            {builder.recipeId === null && !closed ? (
              <PastedIngredientReview
                key={reviewKey}
                apiBase={apiBase}
                accessToken={accessToken}
                ownerUserId={ownerUserId}
                disabled={builderDisabled}
                remainingCapacity={50 - builder.ingredients.length}
                onConfirm={confirmReviewedIngredients}
                onSessionClosed={() => {
                  if (scopeIsCurrent(renderEpoch) && reviewGeneration.current === renderReview)
                    closeSession();
                }}
              />
            ) : null}
            <Field
              label="Search foods"
              disabled={builderDisabled}
              maxLength={128}
              value={query}
              onChange={(value) => {
                if (canEdit()) setQuery(value);
              }}
            />
            <Pressable
              accessibilityRole="button"
              disabled={builderDisabled}
              onPress={() => void search()}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>
                {busy === "search" ? "Searching…" : "Search foods"}
              </Text>
            </Pressable>
            {foods.map((food) => (
              <View key={food.foodVersionId} style={styles.ingredient}>
                <Text style={styles.cardTitle}>{food.name}</Text>
                <Text style={styles.meta}>
                  {food.source.attributionText} · {food.source.licenseExpression}
                </Text>
                <View style={styles.row}>
                  {food.defaultServing?.gramWeight ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={builderDisabled}
                      onPress={() => addFood(food, "serving")}
                      style={styles.secondary}
                    >
                      <Text style={styles.secondaryText}>Add {food.defaultServing.label}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={builderDisabled}
                    onPress={() => addFood(food, "grams")}
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryText}>Add 100 g</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {recipes
              .filter((recipe) => recipe.id !== builder.recipeId)
              .map((recipe) => (
                <View key={`nested:${recipe.id}`} style={styles.ingredient}>
                  <Text style={styles.cardTitle}>
                    {recipe.name} v{recipe.versionNumber}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={builderDisabled}
                    onPress={() => addNested(recipe)}
                  >
                    <Text style={styles.link}>Pin 100 g nested revision</Text>
                  </Pressable>
                </View>
              ))}
            <Pressable
              accessibilityRole="button"
              disabled={builderDisabled}
              onPress={() => void save()}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>
                {busy === "save"
                  ? "Saving…"
                  : builder.recipeId
                    ? "Publish revision"
                    : "Create recipe"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {scopeVisible && selected ? (
          <View style={styles.panel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Assumptions & warnings
            </Text>
            <Text style={styles.warning}>{selected.retentionPolicy.assumption}</Text>
            {selected.warnings.map((warning) => (
              <Text key={warning.code} style={styles.warning}>
                {warning.message}
              </Text>
            ))}
            <Text style={styles.help}>
              No cooking-retention adjustment is claimed unless a named reviewed factor set is
              pinned.
            </Text>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Saved nutrition: {selected.name} · v{selected.versionNumber}
            </Text>
            <Text style={styles.help}>
              Values from saved version {selected.versionNumber}. Unsaved edits and diary log
              quantity do not change these values.
            </Text>
            <View accessibilityLabel="Saved nutrition basis" style={styles.nutritionBasis}>
              <Chip
                disabled={builderDisabled}
                active={nutritionBasis === "100g"}
                label="Per 100 g"
                onPress={() => selectNutritionBasis("100g")}
              />
              {selected.nutrientsPerServing !== null ? (
                <Chip
                  disabled={builderDisabled}
                  active={nutritionBasis === "serving"}
                  label={`Per serving (${selected.servingLabel ?? "serving"})`}
                  onPress={() => selectNutritionBasis("serving")}
                />
              ) : null}
            </View>
            {(nutritionBasis === "serving" && selected.nutrientsPerServing !== null
              ? selected.nutrientsPerServing
              : selected.nutrientsPer100Grams
            ).map((nutrient) => {
              const display = nutrientDisplay(nutrient);
              return (
                <View key={nutrient.nutrientId} style={styles.nutrient}>
                  <Text style={styles.cardTitle}>{nutrient.name}</Text>
                  <Text>{display.amount}</Text>
                  <Text style={styles.meta}>{display.qualification}</Text>
                </View>
              );
            })}
            <Text style={styles.sectionTitle}>Sources</Text>
            {recipeSourceLines(selected).map((line) => (
              <Text key={line} style={styles.meta}>
                {line}
              </Text>
            ))}
            <Text style={styles.sectionTitle}>Log exact v{selected.versionNumber}</Text>
            <View style={styles.row}>
              <Chip
                disabled={builderDisabled}
                active={logKind === "grams"}
                label="Grams"
                onPress={() => setLogKind("grams")}
              />
              {selected.servingCount ? (
                <Chip
                  disabled={builderDisabled}
                  active={logKind === "serving"}
                  label={selected.servingLabel ?? "Serving"}
                  onPress={() => setLogKind("serving")}
                />
              ) : null}
            </View>
            <Field
              disabled={builderDisabled}
              label="Amount"
              maxLength={19}
              value={logAmount}
              onChange={setLogAmount}
              numeric
            />
            <Field
              disabled={builderDisabled}
              label="Local date"
              maxLength={10}
              value={date}
              onChange={setDate}
            />
            <View style={styles.row}>
              {diaryGroups.map(({ mealSlot: slot, label }) => (
                <Chip
                  disabled={builderDisabled}
                  active={meal === slot}
                  key={slot}
                  label={label}
                  onPress={() => setMeal(slot)}
                />
              ))}
            </View>
            <Text style={styles.help}>
              Interpreted in {profileTimeZone}; the exact recipe revision is pinned.
            </Text>
            {quickAddOutboxState.pendingCount > 0 ? (
              <Text accessibilityLiveRegion="polite" style={styles.help}>
                {quickAddOutboxState.pendingCount} diary{" "}
                {quickAddOutboxState.pendingCount === 1 ? "log is" : "logs are"} waiting securely on
                this device.
              </Text>
            ) : null}
            <Pressable
              accessibilityHint="Stores the exact recipe log on this device before sending"
              accessibilityRole="button"
              accessibilityState={{ disabled: recipeLogUnavailable }}
              disabled={recipeLogUnavailable}
              onPress={() => void log()}
              style={[styles.primary, recipeLogUnavailable && styles.disabled]}
            >
              <Text style={styles.primaryText}>
                {busy === "log"
                  ? "Securing…"
                  : quickAddOutboxState.pendingCount >= MAX_QUICK_ADD_OUTBOX_ITEMS
                    ? `Queue full (${MAX_QUICK_ADD_OUTBOX_ITEMS})`
                    : "Secure & log recipe"}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChange,
  numeric = false,
  multiline = false,
  maxLength,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly numeric?: boolean;
  readonly multiline?: boolean;
  readonly maxLength: number;
  readonly disabled?: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!disabled}
        keyboardType={numeric ? "decimal-pad" : "default"}
        maxLength={maxLength}
        multiline={multiline}
        onChangeText={onChange}
        style={[styles.input, multiline && styles.multiline]}
        value={value}
      />
    </View>
  );
}

function Chip({
  active,
  label,
  onPress,
  disabled = false,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardTitle: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  chip: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: palette.forest },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: palette.white },
  content: { padding: 22, paddingBottom: 72 },
  danger: { color: "#8a3128", fontSize: 13, fontWeight: "800", marginTop: 8 },
  disabled: { opacity: 0.5 },
  help: { color: palette.muted, fontSize: 12, lineHeight: 18, marginVertical: 10 },
  ingredient: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 14, paddingTop: 14 },
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
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  label: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 6,
    marginTop: 13,
    textTransform: "uppercase",
  },
  link: {
    color: palette.forest,
    fontSize: 13,
    fontWeight: "800",
    marginTop: 7,
    textDecorationLine: "underline",
  },
  meta: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  multiline: { minHeight: 82, paddingTop: 12, textAlignVertical: "top" },
  nav: { alignItems: "flex-end", marginBottom: 16 },
  navText: { color: palette.forest, fontWeight: "800" },
  nutritionBasis: { gap: 8 },
  nutrient: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    paddingVertical: 10,
  },
  panel: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 24,
    padding: 18,
  },
  primary: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderRadius: 9,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  recipeCard: { borderBottomColor: palette.line, borderBottomWidth: 1, paddingVertical: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondary: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  secondaryText: { color: palette.forest, fontSize: 12, fontWeight: "800" },
  sectionTitle: {
    color: palette.ink,
    fontSize: 23,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginBottom: 8,
    marginTop: 18,
  },
  status: { color: palette.muted, fontSize: 14, lineHeight: 20, marginVertical: 16 },
  title: { color: palette.ink, fontSize: 42, fontWeight: "700", letterSpacing: -1.6, marginTop: 8 },
  warning: {
    backgroundColor: "#f7e6b0",
    borderRadius: 8,
    color: "#6b4c00",
    marginTop: 8,
    padding: 11,
  },
});
