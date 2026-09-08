"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createOperationId,
  currentLocalDate,
  type DiaryGroup,
  defaultDiaryGroups,
  defaultMealForHour,
  defaultMealForTime,
  diaryGroupLabel,
  isLocalDate,
  isPositiveDecimal,
  localDateInTimeZone,
  localTimeInTimeZone,
  type MealSlot,
  mealSlots,
  parseDiaryMutation,
  parseSession,
  prepareQuickAddOperation,
  type QuickAddOperation,
} from "../../lib/diary";

import {
  buildAutocompleteRequestPath,
  buildBarcodeRequestPath,
  buildSearchRequestPath,
  type FoodAutocompleteSuggestion,
  type FoodSearchHit,
  type FoodSearchIntent,
  type FoodSourceSummary,
  foodSearchIntents,
  isInvalidBarcodeResponse,
  isInvalidContinuationResponse,
  mergeFoodSearchResults,
  normalizeBarcodeInput,
  normalizeSearchText,
  parseFoodAutocompleteResponse,
  parseFoodBarcodeResponse,
  parseFoodSearchPage,
} from "../../lib/food-search";

type LoadState = "idle" | "loading" | "ready" | "error";
type BarcodeState = LoadState | "not-found";

const intentLabels: Readonly<Record<FoodSearchIntent, string>> = {
  all: "All foods",
  generic: "Generic",
  branded: "Branded",
};

function displayServing(food: FoodSearchHit): string {
  const serving = food.defaultServing;
  if (!serving) return "Serving information unavailable";
  const measurement = serving.gramWeight
    ? `${serving.gramWeight} g`
    : serving.milliliterVolume
      ? `${serving.milliliterVolume} mL`
      : null;
  return measurement ? `${serving.label} · ${measurement}` : serving.label;
}

function displaySource(source: FoodSourceSummary): string {
  return source.attributionRequired ? source.attributionText : source.displayName;
}

function hasGramResolvedServing(food: FoodSearchHit): boolean {
  const grams = food.defaultServing?.gramWeight;
  return (
    grams !== null &&
    grams !== undefined &&
    /^(?:0*[1-9][0-9]*)(?:\.[0-9]+)?$|^0*\.0*[1-9][0-9]*$/u.test(grams)
  );
}

type QuickAddPortionKind = "serving" | "grams";

interface QuickAddDraft {
  readonly kind: QuickAddPortionKind;
  readonly amount: string;
}

function defaultQuickAddDraft(food: FoodSearchHit): QuickAddDraft {
  return { kind: hasGramResolvedServing(food) ? "serving" : "grams", amount: "1" };
}

function quickAddDraft(
  drafts: Readonly<Record<string, QuickAddDraft>>,
  food: FoodSearchHit,
): QuickAddDraft {
  return drafts[food.foodVersionId] ?? defaultQuickAddDraft(food);
}

function quickAddAmountLabel(draft: QuickAddDraft): string {
  return draft.kind === "serving"
    ? `${draft.amount} default ${draft.amount === "1" ? "serving" : "servings"}`
    : `${draft.amount} g`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TypeError("The server response was not JSON.");
  }
}

/** A typed time-zone conflict proves no write occurred, so its stale retry must not survive. */
export function fenceQuickAddForTimeZoneChange(
  pendingByIntent: Map<string, QuickAddOperation>,
  operation: QuickAddOperation,
  status: number,
  body: unknown,
): boolean {
  const timeZoneChanged =
    status === 409 &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "code" in body &&
    body.code === "DIARY_TIME_ZONE_CHANGED";
  if (!timeZoneChanged) return false;
  if (pendingByIntent.get(operation.intentKey) === operation) {
    pendingByIntent.delete(operation.intentKey);
  }
  return true;
}

export function quickAddTimeZoneReviewMessage(
  localDate: string,
  currentTimeZone: string | null,
): string {
  return currentTimeZone
    ? `Your diary time zone changed to ${currentTimeZone}. This food was not added. Review ${localDate} as a local day in that zone, then confirm the day before adding again.`
    : "Your diary time zone changed. This food was not added, and its stale retry was cleared. Current account settings could not be reloaded; refresh this page, then review the local diary day before adding again.";
}

export function FoodSearchClient() {
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const requestedMeal = searchParams.get("meal");
  const [diaryDate, setDiaryDate] = useState(() =>
    requestedDate && isLocalDate(requestedDate) ? requestedDate : currentLocalDate(),
  );
  const [mealSlot, setMealSlot] = useState<MealSlot>(() =>
    mealSlots.some((meal) => meal === requestedMeal)
      ? (requestedMeal as MealSlot)
      : defaultMealForTime(),
  );
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [diaryGroups, setDiaryGroups] = useState<readonly DiaryGroup[]>(defaultDiaryGroups);
  const [addState, setAddState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [addingFoodVersion, setAddingFoodVersion] = useState<string | null>(null);
  const [addMessage, setAddMessage] = useState(
    "Sign in to choose a quantity and add it to your diary.",
  );
  const [quickAddDrafts, setQuickAddDrafts] = useState<Readonly<Record<string, QuickAddDraft>>>({});
  const pendingAdds = useRef(new Map<string, QuickAddOperation>());
  const activeAddOperation = useRef<string | null>(null);
  const [dateReviewRequired, setDateReviewRequired] = useState(false);
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState<FoodSearchIntent>("all");
  const [suggestions, setSuggestions] = useState<readonly FoodAutocompleteSuggestion[]>([]);
  const [suggestionState, setSuggestionState] = useState<LoadState>("idle");
  const [results, setResults] = useState<readonly FoodSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [searchMessage, setSearchMessage] = useState(
    "Search the public catalogue by a food or brand name.",
  );
  const [barcode, setBarcode] = useState("");
  const [barcodeResult, setBarcodeResult] = useState<FoodSearchHit | null>(null);
  const [barcodeState, setBarcodeState] = useState<BarcodeState>("idle");
  const [barcodeMessage, setBarcodeMessage] = useState(
    "Enter all digits printed beneath a UPC, EAN, or GTIN barcode.",
  );
  const autocompleteController = useRef<AbortController | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const barcodeController = useRef<AbortController | null>(null);
  const profileRefreshController = useRef<AbortController | null>(null);
  const suppressedAutocompleteValue = useRef<string | null>(null);

  useEffect(() => {
    const normalized = normalizeSearchText(query);
    autocompleteController.current?.abort();

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

    setSuggestions([]);
    setSuggestionState("idle");

    const controller = new AbortController();
    autocompleteController.current = controller;
    const timer = window.setTimeout(() => {
      setSuggestionState("loading");
      void (async () => {
        try {
          const response = await fetch(
            buildAutocompleteRequestPath({ query: normalized, intent }),
            {
              headers: { accept: "application/json" },
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new Error("autocomplete-unavailable");
          const payload = parseFoodAutocompleteResponse(await responseJson(response));
          if (!controller.signal.aborted) {
            setSuggestions(payload.data);
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
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, intent]);

  useEffect(
    () => () => {
      autocompleteController.current?.abort();
      searchController.current?.abort();
      barcodeController.current?.abort();
      profileRefreshController.current?.abort();
    },
    [],
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
        if (!response.ok) return;
        const session = parseSession(await responseJson(response));
        if (!controller.signal.aborted) {
          setTimeZone(session.profile.timeZone);
          setDiaryGroups(session.profile.diaryGroups);
          const now = new Date();
          if (!(requestedDate && isLocalDate(requestedDate))) {
            setDiaryDate(localDateInTimeZone(now, session.profile.timeZone));
          }
          if (!mealSlots.some((meal) => meal === requestedMeal)) {
            setMealSlot(
              defaultMealForHour(
                Number(localTimeInTimeZone(now, session.profile.timeZone).slice(0, 2)),
              ),
            );
          }
          setAddMessage("Choose a local day, meal, serving type, and positive quantity.");
        }
      } catch {
        // Catalogue search remains public if session discovery is unavailable.
      }
    })();
    return () => controller.abort();
  }, [requestedDate, requestedMeal]);

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

      searchController.current?.abort();
      if (cursor === undefined) {
        setResults([]);
        setNextCursor(null);
        setLastSearchQuery("");
      }
      const controller = new AbortController();
      searchController.current = controller;
      setSearchState("loading");
      setSearchMessage(cursor ? "Loading more matching foods…" : `Searching for “${normalized}”…`);

      try {
        const path = buildSearchRequestPath({
          query: normalized,
          intent,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const response = await fetch(path, {
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
        const payload = parseFoodSearchPage(await responseJson(response));
        if (controller.signal.aborted) return;

        const merged = mergeFoodSearchResults(results, payload.data, cursor !== undefined);
        setResults(merged);
        setNextCursor(payload.page.nextCursor);
        setLastSearchQuery(normalized);
        setSearchState("ready");
        setSearchMessage(
          merged.length === 0
            ? `No public foods matched “${normalized}”. Try fewer words or another food type.`
            : `${merged.length} ${merged.length === 1 ? "result" : "results"} shown for “${normalized}”.`,
        );
      } catch {
        if (!controller.signal.aborted) {
          setSearchState("error");
          setSearchMessage(
            "Food search is unavailable right now. Your query was not saved; please try again.",
          );
        }
      }
    },
    [intent, results],
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuggestions([]);
    void runSearch(query);
  }

  function chooseSuggestion(suggestion: FoodAutocompleteSuggestion) {
    suppressedAutocompleteValue.current = normalizeSearchText(suggestion.label);
    setQuery(suggestion.label);
    setSuggestions([]);
    setSuggestionState("idle");
    void runSearch(suggestion.label);
  }

  function chooseIntent(nextIntent: FoodSearchIntent) {
    searchController.current?.abort();
    setIntent(nextIntent);
    setResults([]);
    setNextCursor(null);
    setLastSearchQuery("");
    setSearchState("idle");
    setSearchMessage(`Search ${intentLabels[nextIntent].toLowerCase()} by food or brand name.`);
  }

  async function submitBarcode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    barcodeController.current?.abort();
    const controller = new AbortController();
    barcodeController.current = controller;
    setBarcodeResult(null);

    let path: string;
    try {
      path = buildBarcodeRequestPath(barcode);
    } catch {
      setBarcodeState("error");
      setBarcodeMessage("A barcode must contain exactly 8, 12, 13, or 14 digits.");
      return;
    }

    setBarcodeState("loading");
    setBarcodeMessage("Checking the exact public barcode…");
    try {
      const response = await fetch(path, {
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
      const payload = parseFoodBarcodeResponse(await responseJson(response));
      if (!controller.signal.aborted) {
        setBarcodeResult(payload.data);
        setBarcodeState("ready");
        setBarcodeMessage(`Found ${payload.data.name}.`);
      }
    } catch {
      if (!controller.signal.aborted) {
        setBarcodeState("error");
        setBarcodeMessage("Barcode lookup is unavailable right now. Please try again.");
      }
    }
  }

  async function refreshDiaryProfileAfterTimeZoneChange(): Promise<string | null> {
    profileRefreshController.current?.abort();
    const controller = new AbortController();
    profileRefreshController.current = controller;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const session = parseSession(await responseJson(response));
      if (controller.signal.aborted) return null;
      setTimeZone(session.profile.timeZone);
      setDiaryGroups(session.profile.diaryGroups);
      return session.profile.timeZone;
    } catch {
      return null;
    } finally {
      if (profileRefreshController.current === controller) {
        profileRefreshController.current = null;
      }
    }
  }

  async function addFood(food: FoodSearchHit, draft: QuickAddDraft) {
    if (activeAddOperation.current !== null) {
      setAddState("error");
      setAddMessage("Wait for the current diary addition to finish before adding another food.");
      return;
    }
    if (dateReviewRequired) {
      setAddState("error");
      setAddMessage("Review and confirm the local diary day before adding this food again.");
      return;
    }
    if (!isPositiveDecimal(draft.amount)) {
      setAddState("error");
      setAddMessage("Enter a positive quantity with at most 12 whole digits and 6 decimals.");
      return;
    }
    if (draft.kind === "serving" && (!food.defaultServing || !hasGramResolvedServing(food))) {
      setAddState("error");
      setAddMessage("This food has no gram-resolved default serving. Choose grams instead.");
      return;
    }
    if (!timeZone) {
      setAddState("error");
      setAddMessage("Sign in before adding food to a private diary.");
      return;
    }
    let operation: QuickAddOperation;
    try {
      operation = prepareQuickAddOperation(
        pendingAdds.current,
        {
          foodVersionId: food.foodVersionId,
          portion:
            draft.kind === "serving" && food.defaultServing
              ? {
                  kind: "serving",
                  servingId: food.defaultServing.servingId,
                  amount: draft.amount,
                }
              : { kind: "grams", grams: draft.amount },
          localDate: diaryDate,
          mealSlot,
          timeZone,
        },
        new Date(),
        createOperationId,
      );
    } catch {
      setAddState("error");
      setAddMessage("That local date or time is not valid in your diary time zone.");
      return;
    }
    pendingAdds.current.set(operation.intentKey, operation);
    activeAddOperation.current = operation.operationId;
    setAddingFoodVersion(food.foodVersionId);
    setAddState("loading");
    setAddMessage(`Adding ${quickAddAmountLabel(draft)} of ${food.name}…`);
    try {
      const response = await fetch(
        `/api/diary/entries?date=${encodeURIComponent(diaryDate)}&profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": operation.operationId,
            "x-expected-profile-time-zone": operation.expectedTimeZone,
          },
          body: JSON.stringify(operation.body),
          cache: "no-store",
        },
      );
      const body = await responseJson(response);
      if (!response.ok) {
        if (fenceQuickAddForTimeZoneChange(pendingAdds.current, operation, response.status, body)) {
          setDateReviewRequired(true);
          setTimeZone(null);
          const currentTimeZone = await refreshDiaryProfileAfterTimeZoneChange();
          setAddState("error");
          setAddMessage(quickAddTimeZoneReviewMessage(diaryDate, currentTimeZone));
          return;
        }
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "The food could not be added.";
        throw new Error(message);
      }
      const mutation = parseDiaryMutation(body);
      const loggedDate = mutation.affectedDays[0]?.localDate ?? diaryDate;
      if (pendingAdds.current.get(operation.intentKey) === operation) {
        pendingAdds.current.delete(operation.intentKey);
      }
      setAddState("ready");
      setAddMessage(
        `${quickAddAmountLabel(draft)} of ${food.name} was added to ${diaryGroupLabel(diaryGroups, mealSlot)} on ${loggedDate}.`,
      );
    } catch (error) {
      setAddState("error");
      setAddMessage(
        `${error instanceof Error ? error.message : "The food could not be added."} Choose Add again to retry safely.`,
      );
    } finally {
      if (activeAddOperation.current === operation.operationId) {
        activeAddOperation.current = null;
      }
      setAddingFoodVersion(null);
    }
  }

  function confirmDiaryDateReview() {
    if (!timeZone) {
      setAddState("error");
      setAddMessage(
        "Current account settings are unavailable. Refresh this page before confirming a local diary day.",
      );
      return;
    }
    setDateReviewRequired(false);
    setAddState("idle");
    setAddMessage(
      `${diaryDate} is confirmed as a local diary day in ${timeZone}. Choose Add when ready.`,
    );
  }

  function updateQuickAddDraft(food: FoodSearchHit, patch: Partial<QuickAddDraft>) {
    setQuickAddDrafts((current) => ({
      ...current,
      [food.foodVersionId]: { ...quickAddDraft(current, food), ...patch },
    }));
  }

  function quickAddControls(food: FoodSearchHit, instance: "barcode" | "search") {
    const draft = quickAddDraft(quickAddDrafts, food);
    const amountIsValid = isPositiveDecimal(draft.amount);
    const servingAvailable = hasGramResolvedServing(food);
    const controlId = `quick-add-${instance}-${food.foodVersionId}`;
    const busy = addingFoodVersion !== null;
    return (
      <fieldset className="quickAddControls">
        <legend className="srOnly">Add {food.name} to the diary</legend>
        <label htmlFor={`${controlId}-kind`}>
          Unit
          <select
            disabled={busy}
            id={`${controlId}-kind`}
            onChange={(event) =>
              updateQuickAddDraft(food, {
                kind: event.target.value as QuickAddPortionKind,
              })
            }
            value={draft.kind}
          >
            {servingAvailable && food.defaultServing ? (
              <option value="serving">Default serving: {food.defaultServing.label}</option>
            ) : null}
            <option value="grams">Grams</option>
          </select>
        </label>
        <label htmlFor={`${controlId}-amount`}>
          Amount
          <input
            aria-describedby={`${controlId}-amount-help`}
            aria-invalid={!amountIsValid}
            autoComplete="off"
            disabled={busy}
            id={`${controlId}-amount`}
            inputMode="decimal"
            maxLength={19}
            onChange={(event) => updateQuickAddDraft(food, { amount: event.target.value })}
            pattern="(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?"
            value={draft.amount}
          />
        </label>
        <small id={`${controlId}-amount-help`}>
          {amountIsValid
            ? draft.kind === "serving"
              ? "How many of the listed default serving."
              : "Exact grams to add."
            : "Enter a positive decimal, up to 12 whole digits and 6 decimal places."}
        </small>
        <button
          aria-label={`Add ${quickAddAmountLabel(draft)} of ${food.name}`}
          className="quickAddButton"
          disabled={busy || dateReviewRequired || !amountIsValid}
          onClick={() => void addFood(food, draft)}
          type="button"
        >
          {addingFoodVersion === food.foodVersionId
            ? "Adding…"
            : busy
              ? "Wait for current add"
              : dateReviewRequired
                ? "Review diary day first"
                : amountIsValid
                  ? `Add ${quickAddAmountLabel(draft)}`
                  : "Enter a valid amount"}
        </button>
      </fieldset>
    );
  }

  const showSuggestionPanel = normalizeSearchText(query).length >= 2 && suggestionState !== "idle";

  return (
    <div className="foodTools">
      <section className="foodSearchPanel" aria-labelledby="catalogue-search-title">
        <div className="foodPanelHeading">
          <div>
            <p className="kicker">Catalogue search</p>
            <h2 id="catalogue-search-title">Find a food</h2>
          </div>
          <p>Public catalogue results only. Personal foods arrive with diary accounts.</p>
        </div>

        <fieldset className="quickAddControls">
          <legend className="srOnly">Diary destination</legend>
          <label htmlFor="quick-add-date">
            Local day
            <input
              id="quick-add-date"
              onChange={(event) =>
                isLocalDate(event.target.value) && setDiaryDate(event.target.value)
              }
              type="date"
              value={diaryDate}
            />
          </label>
          <label htmlFor="quick-add-meal">
            Meal
            <select
              id="quick-add-meal"
              onChange={(event) => setMealSlot(event.target.value as MealSlot)}
              value={mealSlot}
            >
              {diaryGroups.map((group) => (
                <option key={group.mealSlot} value={group.mealSlot}>
                  {group.label}
                </option>
              ))}
            </select>
          </label>
          <Link href="/login">Account</Link>
          {dateReviewRequired ? (
            <button
              className="quickAddButton"
              disabled={!timeZone || addingFoodVersion !== null}
              onClick={confirmDiaryDateReview}
              type="button"
            >
              Confirm {diaryDate} as local day
            </button>
          ) : null}
        </fieldset>
        <p className={`addStatus addStatus--${addState}`} role="status" aria-live="polite">
          {addMessage}
        </p>

        <form aria-label="Food search" className="foodSearchForm" onSubmit={submitSearch}>
          <fieldset className="intentFieldset">
            <legend>Food type</legend>
            <div className="intentControls">
              {foodSearchIntents.map((option) => (
                <label
                  key={option}
                  className={intent === option ? "intentOption active" : "intentOption"}
                >
                  <input
                    checked={intent === option}
                    name="food-intent"
                    onChange={() => chooseIntent(option)}
                    type="radio"
                    value={option}
                  />
                  <span>{intentLabels[option]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="fieldLabel" htmlFor="food-query">
            Food or brand
          </label>
          <div className="searchInputRow">
            <div className="autocompleteField">
              <input
                aria-describedby={showSuggestionPanel ? "food-suggestion-status" : undefined}
                autoComplete="off"
                id="food-query"
                maxLength={128}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Try banana, lentils, or a brand"
                type="search"
                value={query}
              />
              {showSuggestionPanel ? (
                <div className="suggestionPanel" id="food-suggestion-status">
                  {suggestionState === "loading" ? <p role="status">Finding suggestions…</p> : null}
                  {suggestionState === "error" ? (
                    <p role="status">Suggestions are unavailable. You can still press Search.</p>
                  ) : null}
                  {suggestionState === "ready" && suggestions.length === 0 ? (
                    <p role="status">
                      No suggestions yet. Press Search to check the full catalogue.
                    </p>
                  ) : null}
                  {suggestions.length > 0 ? (
                    <ul aria-label="Food suggestions">
                      {suggestions.map((suggestion) => (
                        <li key={suggestion.foodVersionId}>
                          <button type="button" onClick={() => chooseSuggestion(suggestion)}>
                            <span>{suggestion.label}</span>
                            <small>
                              {suggestion.brandName ?? intentLabels[suggestion.kind]} ·{" "}
                              {suggestion.kind}
                            </small>
                            <small>
                              {displaySource(suggestion.source)} ·{" "}
                              {suggestion.source.licenseExpression}
                            </small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button className="searchButton" disabled={searchState === "loading"} type="submit">
              {searchState === "loading" ? "Searching…" : "Search"}
            </button>
          </div>
        </form>

        <p className={`searchStatus searchStatus--${searchState}`} role="status" aria-live="polite">
          {searchMessage}
        </p>

        {results.length > 0 ? (
          <ul
            className="foodResultList"
            aria-label="Food search results"
            aria-busy={searchState === "loading"}
          >
            {results.map((food) => (
              <li key={food.foodVersionId}>
                <article>
                  <div className="resultMain">
                    <span className={`foodKind foodKind--${food.kind}`}>{food.kind}</span>
                    <h3>{food.name}</h3>
                    {food.brandName ? <p className="foodBrand">{food.brandName}</p> : null}
                    <p className="servingCopy">{displayServing(food)}</p>
                  </div>
                  <div className="sourceCopy">
                    <span>{displaySource(food.source)}</span>
                    <small>
                      {food.source.licenseExpression} · {food.marketCode} · {food.languageTag}
                    </small>
                    {quickAddControls(food, "search")}
                  </div>
                </article>
              </li>
            ))}
          </ul>
        ) : null}

        {nextCursor && lastSearchQuery ? (
          <button
            className="loadMoreButton"
            disabled={searchState === "loading"}
            onClick={() => void runSearch(lastSearchQuery, nextCursor)}
            type="button"
          >
            {searchState === "loading" ? "Loading…" : "Load more results"}
          </button>
        ) : null}
      </section>

      <section className="barcodePanel" aria-labelledby="barcode-title">
        <div>
          <p className="kicker">Exact lookup</p>
          <h2 id="barcode-title">Have the barcode?</h2>
          <p>
            Type every digit. This does an exact catalogue lookup; it does not guess from a partial
            code.
          </p>
        </div>
        <form className="barcodeForm" onSubmit={submitBarcode}>
          <label className="fieldLabel" htmlFor="food-barcode">
            UPC, EAN, or GTIN digits
          </label>
          <div className="searchInputRow">
            <input
              autoComplete="off"
              id="food-barcode"
              inputMode="numeric"
              maxLength={64}
              onChange={(event) => setBarcode(normalizeBarcodeInput(event.target.value))}
              pattern="(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})"
              placeholder="012345678905"
              type="text"
              value={barcode}
            />
            <button className="barcodeButton" disabled={barcodeState === "loading"} type="submit">
              {barcodeState === "loading" ? "Checking…" : "Look up"}
            </button>
          </div>
        </form>
        <p
          className={`barcodeStatus barcodeStatus--${barcodeState}`}
          role="status"
          aria-live="polite"
        >
          {barcodeMessage}
        </p>
        {barcodeResult ? (
          <article className="barcodeResult">
            <span className={`foodKind foodKind--${barcodeResult.kind}`}>{barcodeResult.kind}</span>
            <h3>{barcodeResult.name}</h3>
            {barcodeResult.brandName ? <p>{barcodeResult.brandName}</p> : null}
            <small>
              {displayServing(barcodeResult)} · {displaySource(barcodeResult.source)} ·{" "}
              {barcodeResult.source.licenseExpression}
            </small>
            {quickAddControls(barcodeResult, "barcode")}
          </article>
        ) : null}
      </section>
    </div>
  );
}
