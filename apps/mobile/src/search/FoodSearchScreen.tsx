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

import {
  apiUrl,
  authenticatedHeaders,
  jsonBody as privateJsonBody,
  responseError,
} from "../api/private-api";
import { newOperationId } from "../auth/operation-id";
import {
  isLocalDate,
  localDateInTimeZone,
  type MealSlot,
  mealLabel,
  mealSlots,
  parseDiaryMutation,
  prepareQuickAddOperation,
  type QuickAddOperation,
} from "../diary/diary";
import { palette } from "../theme";
import {
  buildAutocompleteUrl,
  buildBarcodeUrl,
  buildSearchUrl,
  type FoodSearchHit,
  type FoodSearchIntent,
  type FoodSourceSummary,
  type FoodSuggestion,
  foodSearchIntents,
  isExactBarcode,
  isInvalidBarcodeResponse,
  isInvalidContinuationResponse,
  mergeSearchResults,
  normalizeBarcodeInput,
  normalizeSearchText,
  parseBarcodeResult,
  parseSearchPage,
  parseSuggestions,
} from "./food-search";

type LoadState = "idle" | "loading" | "ready" | "error";
type BarcodeState = LoadState | "not-found";

const intentLabels: Readonly<Record<FoodSearchIntent, string>> = {
  all: "All",
  generic: "Generic",
  branded: "Branded",
};

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TypeError("The response was not JSON.");
  }
}

function servingText(food: FoodSearchHit): string {
  const serving = food.defaultServing;
  if (!serving) return "Serving information unavailable";
  if (serving.gramWeight) return `${serving.label} · ${serving.gramWeight} g`;
  if (serving.milliliterVolume) return `${serving.label} · ${serving.milliliterVolume} mL`;
  return serving.label;
}

function sourceText(source: FoodSourceSummary): string {
  return source.attributionRequired ? source.attributionText : source.displayName;
}

function foodAccessibilityLabel(food: FoodSearchHit): string {
  return `${food.name}. ${servingText(food)}. Source: ${sourceText(food.source)}. License: ${food.source.licenseExpression}.`;
}

interface FoodSearchScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly diaryDate: string;
  readonly mealSlot: MealSlot;
  readonly onAdded: (date: string) => void;
  readonly onUnauthorized: () => Promise<void>;
}

function hasGramServing(food: FoodSearchHit): boolean {
  return (
    food.defaultServing?.gramWeight !== null &&
    food.defaultServing?.gramWeight !== undefined &&
    /^(?:0*[1-9][0-9]*)(?:\.[0-9]+)?$|^0*\.0*[1-9][0-9]*$/u.test(food.defaultServing.gramWeight)
  );
}

export function FoodSearchScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  diaryDate: initialDate,
  mealSlot: initialMeal,
  onAdded,
  onUnauthorized,
}: FoodSearchScreenProps) {
  const [diaryDate, setDiaryDate] = useState(() =>
    isLocalDate(initialDate) ? initialDate : localDateInTimeZone(new Date(), profileTimeZone),
  );
  const [mealSlot, setMealSlot] = useState<MealSlot>(initialMeal);
  const [addingVersion, setAddingVersion] = useState<string | null>(null);
  const [addState, setAddState] = useState<LoadState>("idle");
  const [addMessage, setAddMessage] = useState(
    "Choose a local day and meal, then add one reviewed gram-resolved serving.",
  );
  const pendingAdds = useRef(new Map<string, QuickAddOperation>());
  const activeAddOperation = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState<FoodSearchIntent>("all");
  const [suggestions, setSuggestions] = useState<readonly FoodSuggestion[]>([]);
  const [suggestionState, setSuggestionState] = useState<LoadState>("idle");
  const [results, setResults] = useState<readonly FoodSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [searchMessage, setSearchMessage] = useState(
    "Search the promoted public catalogue by food or brand name.",
  );
  const [barcode, setBarcode] = useState("");
  const [barcodeState, setBarcodeState] = useState<BarcodeState>("idle");
  const [barcodeMessage, setBarcodeMessage] = useState(
    "Enter every digit printed beneath a UPC, EAN, or GTIN.",
  );
  const [barcodeResult, setBarcodeResult] = useState<FoodSearchHit | null>(null);
  const autocompleteController = useRef<AbortController | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const barcodeController = useRef<AbortController | null>(null);
  const suppressedAutocompleteValue = useRef<string | null>(null);

  useEffect(() => {
    autocompleteController.current?.abort();
    const normalized = normalizeSearchText(query);
    if (suppressedAutocompleteValue.current !== null) {
      const isSuppressedValue = suppressedAutocompleteValue.current === normalized;
      suppressedAutocompleteValue.current = null;
      if (isSuppressedValue) return;
    }
    if (normalized.length < 2) {
      setSuggestions([]);
      setSuggestionState("idle");
      return;
    }
    if (!apiBase) {
      setSuggestions([]);
      setSuggestionState("error");
      return;
    }
    setSuggestions([]);
    setSuggestionState("idle");

    const controller = new AbortController();
    autocompleteController.current = controller;
    const timer = setTimeout(() => {
      setSuggestionState("loading");
      void (async () => {
        try {
          const response = await fetch(
            buildAutocompleteUrl(apiBase, normalized, intent).toString(),
            {
              headers: { accept: "application/json" },
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new Error("autocomplete-unavailable");
          const data = parseSuggestions(await jsonBody(response));
          if (!controller.signal.aborted) {
            setSuggestions(data);
            setSuggestionState("ready");
          }
        } catch {
          if (!controller.signal.aborted) {
            setSuggestions([]);
            setSuggestionState("error");
          }
        }
      })();
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBase, intent, query]);

  useEffect(
    () => () => {
      autocompleteController.current?.abort();
      searchController.current?.abort();
      barcodeController.current?.abort();
    },
    [],
  );

  const runSearch = useCallback(
    async (requestedQuery: string, cursor?: string) => {
      const normalized = normalizeSearchText(requestedQuery);
      if (!normalized) {
        setResults([]);
        setNextCursor(null);
        setSearchState("error");
        setSearchMessage("Enter a food or brand name before searching.");
        return;
      }
      if (!apiBase) {
        setResults([]);
        setNextCursor(null);
        setSearchState("error");
        setSearchMessage(
          "Food search is unavailable because the API address is not configured safely.",
        );
        return;
      }

      searchController.current?.abort();
      if (cursor === undefined) {
        setResults([]);
        setNextCursor(null);
        setLastQuery("");
      }
      const controller = new AbortController();
      searchController.current = controller;
      setSearchState("loading");
      setSearchMessage(cursor ? "Loading more foods…" : `Searching for “${normalized}”…`);

      try {
        const url = buildSearchUrl(apiBase, normalized, intent, cursor);
        const response = await fetch(url.toString(), {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (isInvalidContinuationResponse(response.status, cursor)) {
          setNextCursor(null);
          setSearchState("error");
          setSearchMessage(
            "These results changed while you were browsing. Search again for a fresh result set.",
          );
          return;
        }
        if (!response.ok) throw new Error("search-unavailable");
        const page = parseSearchPage(await jsonBody(response));
        if (controller.signal.aborted) return;
        const merged = mergeSearchResults(results, page.data, cursor !== undefined);
        setResults(merged);
        setNextCursor(page.page.nextCursor);
        setLastQuery(normalized);
        setSearchState("ready");
        setSearchMessage(
          merged.length === 0
            ? `No public foods matched “${normalized}”. Try fewer words or another food type.`
            : `${merged.length} ${merged.length === 1 ? "result" : "results"} shown for “${normalized}”.`,
        );
      } catch {
        if (!controller.signal.aborted) {
          setSearchState("error");
          setSearchMessage("Food search is unavailable right now. Your query was not saved.");
        }
      }
    },
    [apiBase, intent, results],
  );

  function selectIntent(nextIntent: FoodSearchIntent) {
    searchController.current?.abort();
    setIntent(nextIntent);
    setResults([]);
    setNextCursor(null);
    setLastQuery("");
    setSearchState("idle");
    setSearchMessage(`Search ${intentLabels[nextIntent].toLowerCase()} foods by name or brand.`);
  }

  function chooseSuggestion(suggestion: FoodSuggestion) {
    suppressedAutocompleteValue.current = normalizeSearchText(suggestion.label);
    setQuery(suggestion.label);
    setSuggestions([]);
    setSuggestionState("idle");
    void runSearch(suggestion.label);
  }

  async function lookupBarcode() {
    barcodeController.current?.abort();
    setBarcodeResult(null);
    if (!isExactBarcode(barcode)) {
      setBarcodeState("error");
      setBarcodeMessage("A barcode must contain exactly 8, 12, 13, or 14 digits.");
      return;
    }
    if (!apiBase) {
      setBarcodeState("error");
      setBarcodeMessage("Barcode lookup is unavailable because the API address is invalid.");
      return;
    }

    const controller = new AbortController();
    barcodeController.current = controller;
    setBarcodeState("loading");
    setBarcodeMessage("Checking the exact public barcode…");
    try {
      const response = await fetch(buildBarcodeUrl(apiBase, barcode).toString(), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        setBarcodeState("not-found");
        setBarcodeMessage("No current public food matches that exact barcode.");
        return;
      }
      if (isInvalidBarcodeResponse(response.status)) {
        setBarcodeState("error");
        setBarcodeMessage("That barcode has an invalid length or check digit.");
        return;
      }
      if (!response.ok) throw new Error("barcode-unavailable");
      const food = parseBarcodeResult(await jsonBody(response));
      if (!controller.signal.aborted) {
        setBarcodeResult(food);
        setBarcodeState("ready");
        setBarcodeMessage(`Found ${food.name}.`);
      }
    } catch {
      if (!controller.signal.aborted) {
        setBarcodeState("error");
        setBarcodeMessage("Barcode lookup is unavailable right now. Please try again.");
      }
    }
  }

  async function addFood(food: FoodSearchHit) {
    if (activeAddOperation.current !== null) {
      setAddState("error");
      setAddMessage("Wait for the current diary addition to finish before adding another food.");
      return;
    }
    if (!food.defaultServing || !hasGramServing(food)) {
      setAddState("error");
      setAddMessage("This food needs a gram-resolved serving before it can be added.");
      return;
    }
    let operation: QuickAddOperation;
    try {
      operation = prepareQuickAddOperation(
        pendingAdds.current,
        {
          foodVersionId: food.foodVersionId,
          servingId: food.defaultServing.servingId,
          localDate: diaryDate,
          mealSlot,
          timeZone: profileTimeZone,
        },
        new Date(),
        newOperationId,
      );
    } catch {
      setAddState("error");
      setAddMessage("That local date is not valid in your diary time zone.");
      return;
    }
    pendingAdds.current.set(operation.intentKey, operation);
    activeAddOperation.current = operation.operationId;
    setAddingVersion(food.foodVersionId);
    setAddState("loading");
    setAddMessage(`Adding ${food.name}…`);
    try {
      const response = await fetch(apiUrl(apiBase, "/v1/diary/entries").toString(), {
        method: "POST",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
        }),
        body: JSON.stringify(operation.body),
      });
      if (response.status === 401) return onUnauthorized();
      const responseBody = await privateJsonBody(response);
      if (!response.ok)
        throw new Error(responseError(responseBody, "The food could not be added."));
      const mutation = parseDiaryMutation(responseBody);
      const loggedDate = mutation.affectedDays[0]?.localDate ?? diaryDate;
      if (pendingAdds.current.get(operation.intentKey) === operation) {
        pendingAdds.current.delete(operation.intentKey);
      }
      setAddState("ready");
      setAddMessage(`${food.name} was added to ${mealLabel(mealSlot)} on ${loggedDate}.`);
      onAdded(loggedDate);
    } catch (caught) {
      setAddState("error");
      setAddMessage(
        `${caught instanceof Error ? caught.message : "The food could not be added."} Choose Add again to retry safely.`,
      );
    } finally {
      if (activeAddOperation.current === operation.operationId) {
        activeAddOperation.current = null;
      }
      setAddingVersion(null);
    }
  }

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.kicker}>PUBLIC CATALOGUE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Find a food without hiding the source.
        </Text>
        <Text style={styles.intro}>
          Search promoted generic and branded records. Missing portions stay visibly missing.
        </Text>

        <View style={styles.destination}>
          <Text style={styles.fieldLabel}>Diary destination</Text>
          <TextInput
            accessibilityLabel="Diary local date"
            maxLength={10}
            onChangeText={(value) => {
              setDiaryDate(value);
              if (!isLocalDate(value)) setAddMessage("Date must use YYYY-MM-DD.");
            }}
            style={styles.input}
            value={diaryDate}
          />
          <View accessibilityRole="radiogroup" style={styles.intentRow}>
            {mealSlots.map((meal) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: mealSlot === meal }}
                key={meal}
                onPress={() => setMealSlot(meal)}
                style={[styles.intentButton, mealSlot === meal && styles.intentButtonSelected]}
              >
                <Text style={[styles.intentLabel, mealSlot === meal && styles.intentLabelSelected]}>
                  {mealLabel(meal)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.statusCopy, addState === "error" && styles.errorCopy]}
          >
            {addMessage}
          </Text>
        </View>

        <Text style={styles.fieldLabel}>Food type</Text>
        <View accessibilityRole="radiogroup" style={styles.intentRow}>
          {foodSearchIntents.map((option) => {
            const selected = intent === option;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={option}
                onPress={() => selectIntent(option)}
                style={({ pressed }) => [
                  styles.intentButton,
                  selected && styles.intentButtonSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.intentLabel, selected && styles.intentLabelSelected]}>
                  {intentLabels[option]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Food or brand</Text>
        <TextInput
          accessibilityLabel="Food or brand"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={128}
          onChangeText={setQuery}
          onSubmitEditing={() => void runSearch(query)}
          placeholder="Try banana, lentils, or a brand"
          placeholderTextColor="#6f7b75"
          returnKeyType="search"
          style={styles.input}
          value={query}
        />

        {suggestionState !== "idle" ? (
          <View accessibilityLiveRegion="polite" style={styles.suggestionPanel}>
            {suggestionState === "loading" ? (
              <View style={styles.inlineStatus}>
                <ActivityIndicator color={palette.forest} />
                <Text style={styles.mutedCopy}>Finding suggestions…</Text>
              </View>
            ) : null}
            {suggestionState === "error" ? (
              <Text style={styles.mutedCopy}>Suggestions unavailable. Search still works.</Text>
            ) : null}
            {suggestionState === "ready" && suggestions.length === 0 ? (
              <Text style={styles.mutedCopy}>No suggestions. Search the full catalogue.</Text>
            ) : null}
            {suggestions.map((suggestion) => (
              <Pressable
                accessibilityLabel={`${suggestion.label}. ${suggestion.brandName ?? intentLabels[suggestion.kind]}. Source: ${sourceText(suggestion.source)}. License: ${suggestion.source.licenseExpression}.`}
                accessibilityHint="Searches for this suggestion"
                accessibilityRole="button"
                key={suggestion.foodVersionId}
                onPress={() => chooseSuggestion(suggestion)}
                style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
              >
                <Text style={styles.suggestionTitle}>{suggestion.label}</Text>
                <Text style={styles.suggestionMeta}>
                  {suggestion.brandName ?? intentLabels[suggestion.kind]} · {suggestion.kind}
                </Text>
                <Text style={styles.suggestionSource}>
                  {sourceText(suggestion.source)} · {suggestion.source.licenseExpression}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: searchState === "loading" }}
          disabled={searchState === "loading"}
          onPress={() => void runSearch(query)}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          {searchState === "loading" ? <ActivityIndicator color={palette.white} /> : null}
          <Text style={styles.primaryButtonLabel}>
            {searchState === "loading" ? "Searching…" : "Search foods"}
          </Text>
        </Pressable>

        <Text
          accessibilityLiveRegion="polite"
          style={[styles.statusCopy, searchState === "error" && styles.errorCopy]}
        >
          {searchMessage}
        </Text>

        {results.map((food) => (
          <View
            accessibilityLabel={foodAccessibilityLabel(food)}
            key={food.foodVersionId}
            style={styles.resultCard}
          >
            <Text
              style={[
                styles.kind,
                food.kind === "branded" ? styles.kindBranded : styles.kindGeneric,
              ]}
            >
              {food.kind}
            </Text>
            <Text style={styles.resultTitle}>{food.name}</Text>
            {food.brandName ? <Text style={styles.resultBrand}>{food.brandName}</Text> : null}
            <Text style={styles.resultServing}>{servingText(food)}</Text>
            <Text style={styles.resultSource}>{sourceText(food.source)}</Text>
            <Text style={styles.resultLicense}>
              {food.source.licenseExpression} · {food.marketCode}
            </Text>
            <Pressable
              accessibilityHint="Adds one reviewed default serving to the selected diary day"
              accessibilityLabel={
                hasGramServing(food)
                  ? `Add ${food.name}`
                  : `${food.name} needs a gram-resolved serving`
              }
              accessibilityRole="button"
              accessibilityState={{
                disabled: !hasGramServing(food) || addingVersion !== null,
              }}
              disabled={!hasGramServing(food) || addingVersion !== null}
              onPress={() => void addFood(food)}
              style={({ pressed }) => [
                styles.addButton,
                !hasGramServing(food) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.addButtonText}>
                {addingVersion === food.foodVersionId
                  ? "Adding…"
                  : hasGramServing(food)
                    ? "Add default serving"
                    : "Needs a gram-resolved serving"}
              </Text>
            </Pressable>
          </View>
        ))}

        {nextCursor && lastQuery ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: searchState === "loading" }}
            disabled={searchState === "loading"}
            onPress={() => void runSearch(lastQuery, nextCursor)}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryButtonLabel}>Load more results</Text>
          </Pressable>
        ) : null}

        <View style={styles.rule} />
        <Text style={styles.kicker}>EXACT LOOKUP</Text>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Have the barcode?
        </Text>
        <Text style={styles.intro}>
          Type every digit. Partial codes are never guessed or sent to search.
        </Text>
        <TextInput
          accessibilityLabel="UPC, EAN, or GTIN digits"
          keyboardType="number-pad"
          maxLength={64}
          onChangeText={(value) => setBarcode(normalizeBarcodeInput(value))}
          onSubmitEditing={() => void lookupBarcode()}
          placeholder="012345678905"
          placeholderTextColor="#6f7b75"
          returnKeyType="done"
          style={styles.input}
          value={barcode}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: barcodeState === "loading" }}
          disabled={barcodeState === "loading"}
          onPress={() => void lookupBarcode()}
          style={({ pressed }) => [styles.barcodeButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonLabel}>
            {barcodeState === "loading" ? "Checking…" : "Look up barcode"}
          </Text>
        </Pressable>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.statusCopy, barcodeState === "error" && styles.errorCopy]}
        >
          {barcodeMessage}
        </Text>

        {barcodeResult ? (
          <View
            accessibilityLabel={foodAccessibilityLabel(barcodeResult)}
            style={[styles.resultCard, styles.barcodeResult]}
          >
            <Text style={styles.resultTitle}>{barcodeResult.name}</Text>
            {barcodeResult.brandName ? (
              <Text style={styles.resultBrand}>{barcodeResult.brandName}</Text>
            ) : null}
            <Text style={styles.resultServing}>{servingText(barcodeResult)}</Text>
            <Text style={styles.resultSource}>{sourceText(barcodeResult.source)}</Text>
            <Text style={styles.resultLicense}>{barcodeResult.source.licenseExpression}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                disabled: !hasGramServing(barcodeResult) || addingVersion !== null,
              }}
              disabled={!hasGramServing(barcodeResult) || addingVersion !== null}
              onPress={() => void addFood(barcodeResult)}
              style={[styles.addButton, !hasGramServing(barcodeResult) && styles.disabled]}
            >
              <Text style={styles.addButtonText}>
                {addingVersion === barcodeResult.foodVersionId
                  ? "Adding…"
                  : hasGramServing(barcodeResult)
                    ? "Add default serving"
                    : "Needs a gram-resolved serving"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={styles.disclaimer}>Wellness information only—not medical advice.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  addButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 9,
    justifyContent: "center",
    marginTop: 14,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  addButtonText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  barcodeButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 10,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 50,
    paddingHorizontal: 18,
  },
  barcodeResult: { marginTop: 8 },
  content: { padding: 24, paddingBottom: 64 },
  disclaimer: { color: palette.muted, fontSize: 12, marginTop: 36 },
  destination: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 24,
    padding: 16,
  },
  disabled: { opacity: 0.5 },
  errorCopy: { color: "#8a332b" },
  fieldLabel: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 28,
    textTransform: "uppercase",
  },
  inlineStatus: { alignItems: "center", flexDirection: "row", gap: 10 },
  input: {
    backgroundColor: palette.white,
    borderColor: "rgba(23, 33, 29, 0.3)",
    borderRadius: 10,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  intentButton: {
    alignItems: "center",
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  intentButtonSelected: { backgroundColor: palette.forest, borderColor: palette.forest },
  intentLabel: { color: palette.muted, fontSize: 13, fontWeight: "700" },
  intentLabelSelected: { color: palette.white },
  intentRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  intro: { color: palette.muted, fontSize: 16, lineHeight: 23, marginTop: 14 },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.6 },
  kind: {
    alignSelf: "flex-start",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 9,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 5,
    textTransform: "uppercase",
  },
  kindBranded: { backgroundColor: "#f7e6b0", color: "#6b4c00" },
  kindGeneric: { backgroundColor: "#dcefd8", color: "#245a3a" },
  mutedCopy: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  pressed: { opacity: 0.72 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 10,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 52,
    paddingHorizontal: 18,
  },
  primaryButtonLabel: { color: palette.white, fontSize: 14, fontWeight: "800" },
  resultBrand: { color: palette.muted, fontSize: 14, marginTop: 3 },
  resultCard: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
    padding: 18,
  },
  resultServing: { color: palette.ink, fontSize: 13, marginTop: 11 },
  resultSource: { color: palette.muted, fontSize: 12, marginTop: 7 },
  resultLicense: { color: palette.muted, fontSize: 11, marginTop: 4 },
  resultTitle: { color: palette.ink, fontSize: 19, fontWeight: "700", letterSpacing: -0.3 },
  rule: { backgroundColor: palette.line, height: 1, marginVertical: 44 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondaryButton: {
    alignItems: "center",
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    marginTop: 18,
    minHeight: 50,
    paddingHorizontal: 18,
  },
  secondaryButtonLabel: { color: palette.forest, fontSize: 14, fontWeight: "800" },
  sectionTitle: {
    color: palette.ink,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -1,
    marginTop: 8,
  },
  statusCopy: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 14 },
  suggestion: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    minHeight: 54,
    paddingVertical: 11,
  },
  suggestionMeta: { color: palette.muted, fontSize: 12, marginTop: 3 },
  suggestionSource: { color: palette.muted, fontSize: 11, marginTop: 3 },
  suggestionPanel: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  suggestionTitle: { color: palette.ink, fontSize: 15, fontWeight: "700" },
  title: {
    color: palette.ink,
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: -1.7,
    lineHeight: 43,
    marginTop: 10,
  },
});
