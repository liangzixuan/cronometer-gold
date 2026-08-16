import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  defaultMealForTime,
  isLocalDate,
  localDateInTimeZone,
  type MealSlot,
  mealLabel,
  mealSlots,
  parseDiaryDay,
  parseDiaryMutation,
  parseSession,
} from "../diary/diary";
import { buildSearchUrl, type FoodSearchHit, parseSearchPage } from "../search/food-search";
import { palette } from "../theme";
import {
  authoritativeRecipeDate,
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
  recipeDraftIngredients,
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "./recipes-goals";

interface Props {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly onUnauthorized: () => Promise<void>;
  readonly onLogged: (date: string) => void;
  readonly onGoals: () => void;
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

export function RecipesScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  onUnauthorized,
  onLogged,
  onGoals,
}: Props) {
  const [recipes, setRecipes] = useState<readonly RecipeSummaryView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecipeView | null>(null);
  const [builder, setBuilder] = useState<Builder>(emptyBuilder);
  const [message, setMessage] = useState("Loading your private recipes…");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foods, setFoods] = useState<readonly FoodSearchHit[]>([]);
  const [date, setDate] = useState(() => localDateInTimeZone(new Date(), profileTimeZone));
  const [authoritativeTimeZone, setAuthoritativeTimeZone] = useState(profileTimeZone);
  const [meal, setMeal] = useState<MealSlot>(() => defaultMealForTime());
  const [logKind, setLogKind] = useState<"grams" | "serving">("serving");
  const [logAmount, setLogAmount] = useState("1");
  const pending = useRef(new Map<string, StableMutation<ReturnType<typeof requestBody>>>());
  const pendingLogs = useRef(new Map<string, StableMutation<RecipeLogBody>>());

  const loadRecipes = useCallback(
    async (cursor: string | null = null) => {
      setLoading(true);
      try {
        const url = apiUrl(apiBase, "/v1/recipes");
        url.searchParams.set("limit", "50");
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const response = await fetch(url.toString(), {
          headers: authenticatedHeaders(accessToken),
        });
        if (response.status === 401) return onUnauthorized();
        const body = await jsonBody(response);
        if (!response.ok) throw new Error(responseError(body, "Recipes could not be loaded."));
        const page = parseRecipeCollection(body);
        setRecipes((current) => {
          const merged = mergeRecipePage(current, page.data, cursor !== null);
          setMessage(
            merged.length
              ? `${merged.length} recipes loaded${page.nextCursor ? "; more available" : ""}.`
              : "No recipes yet.",
          );
          return merged;
        });
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setMessage(caught instanceof Error ? caught.message : "Recipes could not be loaded.");
      } finally {
        setLoading(false);
      }
    },
    [accessToken, apiBase, onUnauthorized],
  );

  useEffect(() => {
    void loadRecipes();
  }, [loadRecipes]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const sessionResponse = await fetch(apiUrl(apiBase, "/v1/auth/me").toString(), {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        });
        if (sessionResponse.status === 401) return onUnauthorized();
        const sessionBody = await jsonBody(sessionResponse);
        if (!sessionResponse.ok)
          throw new Error(
            responseError(sessionBody, "Your recipe session could not be refreshed."),
          );
        const session = parseSession(sessionBody);
        const currentDate = authoritativeRecipeDate(new Date(), session.profile.timeZone);
        let zone = session.profile.timeZone;
        const diaryUrl = apiUrl(apiBase, "/v1/diary");
        diaryUrl.searchParams.set("date", currentDate);
        try {
          const diaryResponse = await fetch(diaryUrl.toString(), {
            headers: authenticatedHeaders(accessToken),
            signal: controller.signal,
          });
          if (diaryResponse.status === 401) return onUnauthorized();
          if (diaryResponse.ok) zone = parseDiaryDay(await jsonBody(diaryResponse)).timeZone;
        } catch {
          // The freshly authenticated profile remains authoritative when a day snapshot is unavailable.
        }
        if (!controller.signal.aborted) {
          setAuthoritativeTimeZone(zone);
          setDate(authoritativeRecipeDate(new Date(), zone));
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setMessage(
            caught instanceof Error
              ? caught.message
              : "Your recipe session could not be refreshed.",
          );
      }
    })();
    return () => controller.abort();
  }, [accessToken, apiBase, onUnauthorized]);

  async function open(recipeId: string) {
    setBusy(`open:${recipeId}`);
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/recipes/${recipeId}`).toString(), {
        headers: authenticatedHeaders(accessToken),
      });
      if (response.status === 401) return onUnauthorized();
      const body = await jsonBody(response);
      if (!response.ok) throw new Error(responseError(body, "The recipe could not be loaded."));
      const recipe = parseRecipeResponse(body);
      setSelected(recipe);
      setBuilder(mobileBuilderFromRecipe(recipe));
      setLogKind(recipeLogKindFor(recipe));
      setMessage(`Recipe version ${recipe.versionNumber} loaded.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The recipe could not be loaded.");
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    setBusy("search");
    try {
      const response = await fetch(buildSearchUrl(apiBase, query, "all").toString(), {
        headers: { accept: "application/json" },
      });
      const body = await jsonBody(response);
      if (!response.ok) throw new Error("Food search is unavailable.");
      setFoods(parseSearchPage(body).data);
    } catch (caught) {
      setFoods([]);
      setMessage(caught instanceof Error ? caught.message : "Food search is unavailable.");
    } finally {
      setBusy(null);
    }
  }

  function addFood(food: FoodSearchHit, mode: "grams" | "serving") {
    if (builder.ingredients.length >= 50) {
      setMessage("A recipe supports at most 50 ingredients.");
      return;
    }
    try {
      setBuilder({
        ...builder,
        ingredients: [...builder.ingredients, mobileFoodIngredient(food, mode)],
      });
      setMessage(`${food.name} added.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The food could not be added.");
    }
  }

  function addNested(recipe: RecipeSummaryView) {
    if (recipe.id === builder.recipeId) {
      setMessage("A recipe cannot contain itself.");
      return;
    }
    if (builder.ingredients.length >= 50) return;
    setBuilder({
      ...builder,
      ingredients: [
        ...builder.ingredients,
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

  function updateQuantity(index: number, quantity: string) {
    setBuilder({
      ...builder,
      ingredients: builder.ingredients.map((ingredient, candidate) =>
        candidate !== index
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
    });
  }

  function updateNote(index: number, note: string) {
    setBuilder({
      ...builder,
      ingredients: builder.ingredients.map((ingredient, candidate) =>
        candidate === index ? { ...ingredient, note: note || null } : ingredient,
      ),
    });
  }

  async function save() {
    let body: ReturnType<typeof requestBody>;
    try {
      body = requestBody(builder);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the recipe.");
      return;
    }
    const key = `${builder.recipeId ?? "create"}:${builder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(pending.current, key, () => body, newOperationId);
    pending.current.set(key, operation);
    setBusy("save");
    try {
      const path = builder.recipeId ? `/v1/recipes/${builder.recipeId}/revisions` : "/v1/recipes";
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        method: "POST",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(builder.revision ? { "if-match": `"${builder.revision}"` } : {}),
        }),
        body: JSON.stringify(operation.body),
      });
      if (response.status === 401) return onUnauthorized();
      const responseBody = await jsonBody(response);
      if (response.status === 412) {
        pending.current.delete(key);
        if (builder.recipeId) await open(builder.recipeId);
        setMessage("The recipe changed elsewhere. Fresh values were loaded.");
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The recipe could not be saved."));
      const mutation = parseRecipeMutation(responseBody);
      pending.current.delete(key);
      setSelected(mutation.recipe);
      setBuilder(mobileBuilderFromRecipe(mutation.recipe));
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
        `${caught instanceof Error ? caught.message : "The recipe could not be saved."} Press Save again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function log() {
    if (!selected || !isLocalDate(date) || !isRecipePositiveDecimal(logAmount)) {
      setMessage("Choose a real local date and positive amount.");
      return;
    }
    setBusy("log");
    try {
      const effectiveLogKind = selected.servingCount === null ? "grams" : logKind;
      const operation = prepareRecipeLogOperation(
        pendingLogs.current,
        {
          recipeId: selected.id,
          recipeVersionId: selected.versionId,
          portion:
            effectiveLogKind === "grams"
              ? { kind: "grams", grams: logAmount }
              : { kind: "serving", amount: logAmount },
          mealSlot: meal,
          localDate: date,
          timeZone: authoritativeTimeZone,
        },
        new Date(),
        newOperationId,
      );
      pendingLogs.current.set(operation.intentKey, operation);
      const response = await fetch(apiUrl(apiBase, `/v1/recipes/${selected.id}/log`).toString(), {
        method: "POST",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
        }),
        body: JSON.stringify(operation.body),
      });
      if (response.status === 401) return onUnauthorized();
      const body = await jsonBody(response);
      if (!response.ok) throw new Error(responseError(body, "The recipe could not be logged."));
      const mutation = parseDiaryMutation(body);
      pendingLogs.current.delete(operation.intentKey);
      const loggedDate = mutation.entry?.localDate ?? date;
      setMessage(mutation.replayed ? "The earlier log was confirmed safely." : "Recipe logged.");
      onLogged(loggedDate);
    } catch (caught) {
      setMessage(
        `${caught instanceof Error ? caught.message : "The recipe could not be logged."} Press Log again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

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
          {message}
        </Text>
        {loading ? <ActivityIndicator color={palette.forest} /> : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSelected(null);
              setBuilder(emptyBuilder());
              setLogKind("grams");
              setLogAmount("1");
            }}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>New recipe</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadRecipes()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Refresh</Text>
          </Pressable>
        </View>
        {recipes.map((recipe) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selected?.id === recipe.id }}
            key={recipe.id}
            onPress={() => void open(recipe.id)}
            style={styles.recipeCard}
          >
            <Text style={styles.cardTitle}>{recipe.name}</Text>
            <Text style={styles.meta}>
              v{recipe.versionNumber} · {recipe.finalYieldGrams} g · {recipe.warningCount} warnings
            </Text>
          </Pressable>
        ))}
        {nextCursor ? (
          <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={() => void loadRecipes(nextCursor)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{loading ? "Loading…" : "Load more recipes"}</Text>
          </Pressable>
        ) : null}
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {builder.recipeId ? `Revise ${builder.name}` : "Recipe builder"}
          </Text>
          <Field
            label="Recipe name"
            maxLength={200}
            value={builder.name}
            onChange={(name) => setBuilder({ ...builder, name })}
          />
          <Field
            label="Final yield grams"
            maxLength={19}
            value={builder.yieldGrams}
            onChange={(yieldGrams) => setBuilder({ ...builder, yieldGrams })}
            numeric
          />
          <View style={styles.row}>
            <Chip
              active={builder.yieldSource === "measured"}
              label="Measured yield"
              onPress={() => setBuilder({ ...builder, yieldSource: "measured" })}
            />
            <Chip
              active={builder.yieldSource === "estimated"}
              label="Estimated yield"
              onPress={() => setBuilder({ ...builder, yieldSource: "estimated" })}
            />
          </View>
          <Field
            label="Serving count (optional)"
            maxLength={19}
            value={builder.servingCount}
            onChange={(servingCount) => setBuilder({ ...builder, servingCount })}
            numeric
          />
          <Field
            label="Serving label"
            maxLength={100}
            value={builder.servingLabel}
            onChange={(servingLabel) => setBuilder({ ...builder, servingLabel })}
          />
          <Field
            label="Description"
            maxLength={2_000}
            value={builder.description}
            onChange={(description) => setBuilder({ ...builder, description })}
            multiline
          />
          <Field
            label="Instructions"
            maxLength={10_000}
            value={builder.instructions}
            onChange={(instructions) => setBuilder({ ...builder, instructions })}
            multiline
          />
          <Text style={styles.sectionTitle}>Ingredients ({builder.ingredients.length}/50)</Text>
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
              <View key={ingredient.clientKey} style={styles.ingredient}>
                <Text
                  accessibilityLabel={`${ingredient.name}, ${quantity} ${unit}. ${ingredient.kind === "recipe" ? `Pinned recipe revision ${ingredient.recipeVersionId}` : `Source ${ingredient.source.attributionText}`}.`}
                  style={styles.cardTitle}
                >
                  {ingredient.name}
                </Text>
                <Text style={styles.meta}>
                  {ingredient.kind === "recipe"
                    ? `Pinned revision ${ingredient.recipeVersionId}`
                    : ingredient.source.attributionText}
                </Text>
                <Field
                  label={`Quantity in ${unit}`}
                  maxLength={19}
                  value={quantity}
                  onChange={(value) => updateQuantity(index, value)}
                  numeric
                />
                <Field
                  label={`${ingredient.name} note (optional)`}
                  maxLength={500}
                  value={ingredient.note ?? ""}
                  onChange={(value) => updateNote(index, value)}
                />
                <Pressable
                  accessibilityLabel={`Remove ${ingredient.name}`}
                  accessibilityRole="button"
                  onPress={() =>
                    setBuilder({
                      ...builder,
                      ingredients: builder.ingredients.filter(
                        (_, candidate) => candidate !== index,
                      ),
                    })
                  }
                >
                  <Text style={styles.danger}>Remove</Text>
                </Pressable>
              </View>
            );
          })}
          <Field label="Search foods" maxLength={128} value={query} onChange={setQuery} />
          <Pressable
            accessibilityRole="button"
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
                    onPress={() => addFood(food, "serving")}
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryText}>Add {food.defaultServing.label}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
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
                <Pressable accessibilityRole="button" onPress={() => addNested(recipe)}>
                  <Text style={styles.link}>Pin 100 g nested revision</Text>
                </Pressable>
              </View>
            ))}
          <Pressable
            accessibilityRole="button"
            disabled={busy === "save"}
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
        {selected ? (
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
            <Text style={styles.sectionTitle}>Nutrition</Text>
            {(selected.nutrientsPerServing ?? selected.nutrientsPer100Grams).map((nutrient) => (
              <View key={nutrient.nutrientId} style={styles.nutrient}>
                <Text>{nutrient.name}</Text>
                <Text>
                  {nutrient.isExact ? "" : "at least "}
                  {nutrient.knownAmount} {nutrient.unit}
                </Text>
              </View>
            ))}
            <Text style={styles.sectionTitle}>Sources</Text>
            {recipeSourceLines(selected).map((line) => (
              <Text key={line} style={styles.meta}>
                {line}
              </Text>
            ))}
            <Text style={styles.sectionTitle}>Log exact v{selected.versionNumber}</Text>
            <View style={styles.row}>
              <Chip
                active={logKind === "grams"}
                label="Grams"
                onPress={() => setLogKind("grams")}
              />
              {selected.servingCount ? (
                <Chip
                  active={logKind === "serving"}
                  label={selected.servingLabel ?? "Serving"}
                  onPress={() => setLogKind("serving")}
                />
              ) : null}
            </View>
            <Field
              label="Amount"
              maxLength={19}
              value={logAmount}
              onChange={setLogAmount}
              numeric
            />
            <Field label="Local date" maxLength={10} value={date} onChange={setDate} />
            <View style={styles.row}>
              {mealSlots.map((slot) => (
                <Chip
                  active={meal === slot}
                  key={slot}
                  label={mealLabel(slot)}
                  onPress={() => setMeal(slot)}
                />
              ))}
            </View>
            <Text style={styles.help}>
              Interpreted in {authoritativeTimeZone}; the exact recipe revision is pinned.
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void log()} style={styles.primary}>
              <Text style={styles.primaryText}>{busy === "log" ? "Logging…" : "Log recipe"}</Text>
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
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly numeric?: boolean;
  readonly multiline?: boolean;
  readonly maxLength: number;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
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
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
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
  nutrient: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
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
