"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TypeError("The server response was not JSON.");
  }
}

export function FoodSearchClient() {
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
          </article>
        ) : null}
      </section>
    </div>
  );
}
