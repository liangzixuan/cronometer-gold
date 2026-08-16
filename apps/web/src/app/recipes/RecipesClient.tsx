"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createOperationId,
  defaultMealForTime,
  isLocalDate,
  localDateInTimeZone,
  type MealSlot,
  mealLabel,
  mealSlots,
  parseDiaryDay,
  parseDiaryMutation,
  parseSession,
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
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "../../lib/recipes-goals";

type LoadState = "loading" | "ready" | "error";

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
      if (!ingredient.foodVersionId || !ingredient.source) {
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
    note: null,
  };
}

export function RecipesClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const [date, setDate] = useState(
    requestedDate && isLocalDate(requestedDate) ? requestedDate : "",
  );
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<readonly RecipeSummaryView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecipeView | null>(null);
  const [builder, setBuilder] = useState<BuilderState>(emptyBuilder);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Loading your private recipes…");
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foodResults, setFoodResults] = useState<readonly FoodSearchHit[]>([]);
  const [searchState, setSearchState] = useState<"idle" | LoadState>("idle");
  const [mealSlot, setMealSlot] = useState<MealSlot>(() => defaultMealForTime());
  const [logKind, setLogKind] = useState<"grams" | "serving">("serving");
  const [logAmount, setLogAmount] = useState("1");
  const pendingSaves = useRef(
    new Map<string, StableMutation<ReturnType<typeof recipeBodyFromBuilder>>>(),
  );
  const pendingLogs = useRef(new Map<string, StableMutation<RecipeLogBody>>());

  const recipeBody = useCallback(() => recipeBodyFromBuilder(builder), [builder]);

  const signInAgain = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const loadRecipes = useCallback(
    async (cursor: string | null = null) => {
      setState("loading");
      try {
        const requestPath =
          cursor === null
            ? "/api/recipes?limit=50"
            : `/api/recipes?limit=50&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetch(requestPath, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (response.status === 401) return signInAgain();
        const body = await responseJson(response);
        if (!response.ok) throw new Error(responseMessage(body, "Recipes could not be loaded."));
        const page = parseRecipeCollection(body);
        setRecipes((current) => {
          const merged = mergeRecipePage(current, page.data, cursor !== null);
          setMessage(
            merged.length === 0
              ? "No recipes yet."
              : `${merged.length} recipes loaded${page.nextCursor ? "; more available" : ""}.`,
          );
          return merged;
        });
        setNextCursor(page.nextCursor);
        setState("ready");
      } catch (caught) {
        setState("error");
        setMessage(caught instanceof Error ? caught.message : "Recipes could not be loaded.");
      }
    },
    [signInAgain],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) return signInAgain();
        const session = parseSession(await responseJson(response));
        const localDate =
          requestedDate && isLocalDate(requestedDate)
            ? requestedDate
            : localDateInTimeZone(new Date(), session.profile.timeZone);
        let authoritativeZone = session.profile.timeZone;
        try {
          const diaryResponse = await fetch(`/api/diary?date=${encodeURIComponent(localDate)}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (diaryResponse.ok)
            authoritativeZone = parseDiaryDay(await responseJson(diaryResponse)).timeZone;
        } catch {
          // The authenticated profile zone remains authoritative when no diary exists yet.
        }
        if (!controller.signal.aborted) {
          setDate(localDate);
          setTimeZone(authoritativeZone);
          void loadRecipes();
        }
      } catch {
        if (!controller.signal.aborted) {
          setState("error");
          setMessage("Your private recipe session could not be verified.");
        }
      }
    })();
    return () => controller.abort();
  }, [loadRecipes, requestedDate, signInAgain]);

  async function openRecipe(recipeId: string) {
    setBusy(`open:${recipeId}`);
    setMessage("Loading the immutable recipe revision…");
    try {
      const response = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401) return signInAgain();
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, "The recipe could not be loaded."));
      const recipe = parseRecipeResponse(body);
      setSelected(recipe);
      setBuilder(draftFromRecipe(recipe));
      setLogKind(recipeLogKindFor(recipe));
      setLogAmount("1");
      setMessage(`Version ${recipe.versionNumber} loaded.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The recipe could not be loaded.");
    } finally {
      setBusy(null);
    }
  }

  async function searchFoods() {
    setSearchState("loading");
    try {
      const response = await fetch(buildSearchRequestPath({ query, intent: "all" }), {
        headers: { accept: "application/json" },
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, "Food search is unavailable."));
      const page = parseFoodSearchPage(body);
      setFoodResults(page.data);
      setSearchState("ready");
    } catch (caught) {
      setFoodResults([]);
      setSearchState("error");
      setMessage(caught instanceof Error ? caught.message : "Food search is unavailable.");
    }
  }

  function addFood(food: FoodSearchHit, mode: "grams" | "serving") {
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

  function updateIngredient(index: number, quantity: string) {
    setBuilder({
      ...builder,
      ingredients: builder.ingredients.map((ingredient, candidate) => {
        if (candidate !== index) return ingredient;
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

  function updateIngredientNote(index: number, note: string) {
    setBuilder({
      ...builder,
      ingredients: builder.ingredients.map((ingredient, candidate) =>
        candidate === index ? { ...ingredient, note: note || null } : ingredient,
      ),
    });
  }

  async function saveRecipe(event: FormEvent) {
    event.preventDefault();
    let body: ReturnType<typeof recipeBodyFromBuilder>;
    try {
      body = recipeBody();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the recipe fields.");
      return;
    }
    const intentKey = `${builder.recipeId ?? "create"}:${builder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(
      pendingSaves.current,
      intentKey,
      () => body,
      createOperationId,
    );
    pendingSaves.current.set(intentKey, operation);
    setBusy("save");
    setMessage(builder.recipeId ? "Publishing a new immutable revision…" : "Creating recipe…");
    try {
      const path = builder.recipeId
        ? `/api/recipes/${encodeURIComponent(builder.recipeId)}/revisions`
        : "/api/recipes";
      const response = await fetch(path, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(builder.revision ? { "if-match": `"${builder.revision}"` } : {}),
        },
        body: JSON.stringify(operation.body),
        cache: "no-store",
      });
      if (response.status === 401) return signInAgain();
      const responseBody = await responseJson(response);
      if (response.status === 412) {
        pendingSaves.current.delete(intentKey);
        if (builder.recipeId) await openRecipe(builder.recipeId);
        setMessage(
          "This recipe changed elsewhere. Fresh values were loaded; review before saving again.",
        );
        return;
      }
      if (!response.ok)
        throw new Error(responseMessage(responseBody, "The recipe could not be saved."));
      const mutation = parseRecipeMutation(responseBody);
      pendingSaves.current.delete(intentKey);
      setSelected(mutation.recipe);
      setBuilder(draftFromRecipe(mutation.recipe));
      setLogKind(recipeLogKindFor(mutation.recipe));
      setLogAmount("1");
      await loadRecipes();
      setMessage(
        mutation.replayed
          ? "The earlier save was confirmed safely."
          : `Recipe version ${mutation.recipe.versionNumber} published.`,
      );
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The recipe could not be saved."} Choose Save again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function logRecipe() {
    if (!isLocalDate(date)) {
      setMessage("Diary date must use YYYY-MM-DD and be a real local calendar day.");
      return;
    }
    if (!selected || !timeZone || !isRecipePositiveDecimal(logAmount)) {
      setMessage("Choose a positive recipe amount before logging.");
      return;
    }
    const effectiveLogKind = selected.servingCount === null ? "grams" : logKind;
    const portion =
      effectiveLogKind === "grams"
        ? ({ kind: "grams", grams: logAmount } as const)
        : ({ kind: "serving", amount: logAmount } as const);
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
        },
        new Date(),
        createOperationId,
      );
      pendingLogs.current.set(operation.intentKey, operation);
      const response = await fetch(`/api/recipes/${encodeURIComponent(selected.id)}/log`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
        },
        body: JSON.stringify(operation.body),
        cache: "no-store",
      });
      if (response.status === 401) return signInAgain();
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, "The recipe could not be logged."));
      const mutation = parseDiaryMutation(body);
      pendingLogs.current.delete(operation.intentKey);
      const loggedDate = mutation.entry?.localDate ?? date;
      setDate(loggedDate);
      setMessage(
        mutation.replayed
          ? "The earlier diary log was confirmed safely."
          : `Recipe logged to ${mealLabel(mealSlot)}.`,
      );
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The recipe could not be logged."} Choose Log again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
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
          <span aria-disabled="true">Trends · soon</span>
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
              onClick={() => {
                setSelected(null);
                setBuilder(emptyBuilder());
                setLogKind("grams");
                setLogAmount("1");
                setMessage("New recipe builder opened.");
              }}
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
            <ul className="recipeList">
              {recipes.map((recipe) => (
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
            {nextCursor ? (
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
            <form className="workspaceForm" onSubmit={(event) => void saveRecipe(event)}>
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
                    onChange={(event) => setBuilder({ ...builder, yieldGrams: event.target.value })}
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
                              : `${ingredient.source.attributionText} · ${ingredient.source.licenseExpression}`}
                          </p>
                          <label className="formField">
                            <span className="srOnly">{ingredient.name} note</span>
                            <input
                              aria-label={`${ingredient.name} note`}
                              maxLength={500}
                              onChange={(event) => updateIngredientNote(index, event.target.value)}
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
                            onChange={(event) => updateIngredient(index, event.target.value)}
                            value={quantity}
                          />
                        </label>
                        <button
                          className="buttonDanger"
                          onClick={() =>
                            setBuilder({
                              ...builder,
                              ingredients: builder.ingredients.filter(
                                (_, candidate) => candidate !== index,
                              ),
                            })
                          }
                          type="button"
                        >
                          Remove
                        </button>
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
                        onChange={(event) => setQuery(event.target.value)}
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
                {recipes.some((recipe) => recipe.id !== builder.recipeId) ? (
                  <div className="workspaceSection">
                    <h3>Or pin a nested recipe revision</h3>
                    <div className="ingredientSearchResults">
                      {recipes
                        .filter((recipe) => recipe.id !== builder.recipeId)
                        .map((recipe) => (
                          <article className="ingredientResult" key={recipe.id}>
                            <div>
                              <strong>{recipe.name}</strong>
                              <p className="sourceLine">
                                Version {recipe.versionNumber} · {recipe.finalYieldGrams} g yield
                              </p>
                            </div>
                            <button
                              className="buttonQuiet"
                              onClick={() => addNested(recipe)}
                              type="button"
                            >
                              Add 100 g
                            </button>
                          </article>
                        ))}
                    </div>
                  </div>
                ) : null}
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
                  <h3 id="nutrition-heading">
                    Nutrition per{" "}
                    {selected.servingCount ? (selected.servingLabel ?? "serving") : "100 g"}
                  </h3>
                  <table className="nutritionTable">
                    <thead>
                      <tr>
                        <th>Nutrient</th>
                        <th>Coverage</th>
                        <th>Known amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selected.nutrientsPerServing ?? selected.nutrientsPer100Grams).map(
                        (nutrient) => (
                          <tr key={nutrient.nutrientId}>
                            <td>{nutrient.name}</td>
                            <td>
                              {nutrient.completeness === "complete" && nutrient.isExact
                                ? "Complete quantified"
                                : nutrient.completeness === "unknown"
                                  ? "Unknown — not zero"
                                  : "Lower bound"}
                            </td>
                            <td>
                              {nutrient.completeness === "complete" && nutrient.isExact
                                ? ""
                                : "at least "}
                              {nutrient.knownAmount} {nutrient.unit}
                            </td>
                          </tr>
                        ),
                      )}
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
                        onChange={(event) => setLogKind(event.target.value as "grams" | "serving")}
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
                        onChange={(event) => setLogAmount(event.target.value)}
                        value={logAmount}
                      />
                    </label>
                    <label className="formField">
                      <span>Local diary date</span>
                      <input
                        maxLength={10}
                        onChange={(event) => setDate(event.target.value)}
                        value={date}
                      />
                    </label>
                    <label className="formField">
                      <span>Meal</span>
                      <select
                        onChange={(event) => setMealSlot(event.target.value as MealSlot)}
                        value={mealSlot}
                      >
                        {mealSlots.map((meal) => (
                          <option key={meal} value={meal}>
                            {mealLabel(meal)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="fieldHelp">
                    Interpreted in {timeZone ?? "your verified profile zone"}. The diary snapshot
                    pins recipe version {selected.versionNumber}.
                  </p>
                  <button
                    className="buttonPrimary"
                    disabled={busy === "log"}
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
