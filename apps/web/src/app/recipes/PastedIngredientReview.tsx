"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createOperationId, parseSession } from "../../lib/diary";
import {
  buildSearchRequestPath,
  type FoodSearchHit,
  parseFoodSearchPage,
} from "../../lib/food-search";
import {
  collectReviewedIngredients,
  hasReviewedGramServing,
  parsePastedIngredientLines,
  type ReviewedIngredientLine,
  reviewedFoodIngredient,
} from "../../lib/recipe-ingredient-review";
import type { RecipeIngredientDraft } from "../../lib/recipes-goals";
import styles from "./ingredient-review.module.css";

export interface PastedIngredientReviewProps {
  readonly ownerUserId: string;
  readonly disabled: boolean;
  readonly remainingCapacity: number;
  readonly onConfirm: (ingredients: readonly RecipeIngredientDraft[]) => boolean;
  readonly onSessionClosed: () => void;
}

interface ReviewModel {
  readonly owner: string;
  readonly paste: string;
  readonly lines: readonly ReviewedIngredientLine[] | null;
  readonly activeLine: number | null;
  readonly query: string;
  readonly results: readonly FoodSearchHit[];
  readonly food: FoodSearchHit | null;
  readonly quantityKind: "grams" | "serving";
  readonly quantity: string;
  readonly busy: "search" | "confirm" | null;
  readonly status: string;
}

function emptyModel(owner: string): ReviewModel {
  return {
    owner,
    paste: "",
    lines: null,
    activeLine: null,
    query: "",
    results: [],
    food: null,
    quantityKind: "grams",
    quantity: "",
    busy: null,
    status: "",
  };
}

interface RequestTicket {
  readonly controller: AbortController;
  readonly generation: number;
  readonly scope: number;
  readonly model: ReviewModel;
}

export function PastedIngredientReview(props: PastedIngredientReviewProps) {
  const [model, setModel] = useState<ReviewModel>(() => emptyModel(props.ownerUserId));
  const modelRef = useRef(model);
  const mounted = useRef(false);
  const closed = useRef(false);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const latest = useRef({ ...props, scope: 0 });
  const scope =
    latest.current.scope +
    Number(
      latest.current.ownerUserId !== props.ownerUserId ||
        latest.current.disabled !== props.disabled,
    );
  latest.current = { ...props, scope };

  const invalidate = useCallback(() => {
    generation.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const publish = useCallback((next: ReviewModel) => {
    modelRef.current = next;
    setModel(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    closed.current = false;
    publish(emptyModel(latest.current.ownerUserId));
    return () => {
      mounted.current = false;
      closed.current = true;
      invalidate();
      modelRef.current = emptyModel("");
    };
  }, [invalidate, publish]);

  useEffect(() => {
    invalidate();
    if (modelRef.current.owner !== props.ownerUserId) {
      closed.current = false;
      publish(emptyModel(props.ownerUserId));
    } else if (modelRef.current.busy !== null) {
      publish({
        ...modelRef.current,
        busy: null,
        results: [],
        status: props.disabled
          ? "Review paused. Try again when the recipe builder is ready."
          : "The recipe builder is ready. Try the interrupted review action again.",
      });
    }
  }, [props.ownerUserId, props.disabled, invalidate, publish]);

  function current(rendered: ReviewModel = model): boolean {
    return (
      mounted.current &&
      !closed.current &&
      !latest.current.disabled &&
      latest.current.scope === scope &&
      latest.current.ownerUserId === rendered.owner &&
      modelRef.current === rendered
    );
  }

  function editable(): boolean {
    return current() && model.busy === null;
  }

  function change(next: ReviewModel) {
    invalidate();
    publish(next);
  }

  function closeSession(ticket: RequestTicket) {
    if (!active(ticket)) return;
    closed.current = true;
    invalidate();
    publish(emptyModel(latest.current.ownerUserId));
    latest.current.onSessionClosed();
  }

  function begin(busy: "search" | "confirm"): RequestTicket {
    invalidate();
    const controller = new AbortController();
    controllerRef.current = controller;
    const next = {
      ...model,
      busy,
      status:
        busy === "search"
          ? "Searching foods and checking your account…"
          : "Checking your account before adding reviewed ingredients…",
    };
    publish(next);
    return { controller, generation: generation.current, scope, model: next };
  }

  function active(ticket: RequestTicket): boolean {
    return (
      mounted.current &&
      !closed.current &&
      !latest.current.disabled &&
      latest.current.ownerUserId === ticket.model.owner &&
      latest.current.scope === ticket.scope &&
      generation.current === ticket.generation &&
      modelRef.current === ticket.model &&
      !ticket.controller.signal.aborted
    );
  }

  async function verifyOwner(ticket: RequestTicket): Promise<boolean> {
    const response = await fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: ticket.controller.signal,
    });
    if (!active(ticket)) return false;
    if (response.status === 401) {
      closeSession(ticket);
      return false;
    }
    const body: unknown = await response.json();
    if (!active(ticket)) return false;
    if (!response.ok)
      throw new Error("Your account could not be checked. Your review is kept; try again.");
    const session = parseSession(body);
    if (session.user.id !== ticket.model.owner) {
      closeSession(ticket);
      return false;
    }
    return true;
  }

  function finish(ticket: RequestTicket) {
    if (controllerRef.current === ticket.controller) controllerRef.current = null;
  }

  async function searchFoods() {
    if (!editable() || model.activeLine === null) return;
    let path: string;
    try {
      path = buildSearchRequestPath({ query: model.query, intent: "all" });
    } catch {
      change({ ...model, status: "Enter a food-search query of 1 to 128 characters." });
      return;
    }
    const ticket = begin("search");
    try {
      const response = await fetch(path, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: ticket.controller.signal,
      });
      if (!active(ticket)) return;
      if (response.status === 401) {
        closeSession(ticket);
        return;
      }
      const body: unknown = await response.json();
      if (!active(ticket)) return;
      if (!response.ok) throw new Error("Food search is unavailable.");
      const page = parseFoodSearchPage(body);
      const verified = await verifyOwner(ticket);
      if (!active(ticket) || !verified) return;
      publish({
        ...ticket.model,
        results: page.data,
        food: null,
        quantity: "",
        busy: null,
        status: page.data.length
          ? "Select the exact food and version, then enter a quantity."
          : "No matching foods. Edit your search and try again.",
      });
    } catch {
      if (!active(ticket)) return;
      publish({
        ...ticket.model,
        results: [],
        busy: null,
        status:
          "Food search or account verification is unavailable. Your review is kept; try again.",
      });
    } finally {
      finish(ticket);
    }
  }

  function startReview() {
    if (!editable()) return;
    try {
      const parsed = parsePastedIngredientLines(model.paste);
      change({
        ...emptyModel(model.owner),
        paste: model.paste,
        lines: parsed.map((line) => ({ ...line, ingredient: null })),
        activeLine: parsed[0]?.lineNumber ?? null,
        status: "Review every original line. Search only sends the separate query you enter.",
      });
    } catch (error) {
      change({
        ...model,
        status: error instanceof Error ? error.message : "The pasted lines could not be reviewed.",
      });
    }
  }

  function openLine(lineNumber: number) {
    if (!editable() || !model.lines?.some((line) => line.lineNumber === lineNumber)) return;
    change({
      ...model,
      lines: model.lines.map((line) =>
        line.lineNumber === lineNumber ? { ...line, ingredient: null } : line,
      ),
      activeLine: lineNumber,
      query: "",
      results: [],
      food: null,
      quantityKind: "grams",
      quantity: "",
      status: "Enter a separate food-search query for this line.",
    });
  }

  function confirmLine() {
    if (!editable() || !model.food || !model.lines || model.activeLine === null) return;
    try {
      const ingredient = reviewedFoodIngredient(
        model.food,
        model.quantityKind,
        model.quantity,
        createOperationId(),
      );
      change({
        ...model,
        lines: model.lines.map((line) =>
          line.lineNumber === model.activeLine ? { ...line, ingredient } : line,
        ),
        activeLine: null,
        query: "",
        results: [],
        food: null,
        quantity: "",
        status: `Line ${model.activeLine} confirmed. Review the remaining lines before adding them.`,
      });
    } catch (error) {
      change({
        ...model,
        status:
          error instanceof Error
            ? error.message
            : "Enter an exact quantity before confirming this line.",
      });
    }
  }

  async function addReviewedIngredients() {
    if (!editable() || !model.lines) return;
    let ingredients: readonly RecipeIngredientDraft[];
    try {
      ingredients = collectReviewedIngredients(model.lines, latest.current.remainingCapacity);
    } catch (error) {
      change({
        ...model,
        status:
          error instanceof Error ? error.message : "Review every ingredient before adding it.",
      });
      return;
    }
    const ticket = begin("confirm");
    try {
      const verified = await verifyOwner(ticket);
      if (!active(ticket) || !verified) return;
      // Recheck capacity after authentication; the parent also validates its current builder.
      collectReviewedIngredients(ticket.model.lines ?? [], latest.current.remainingCapacity);
      // Consume this transaction before invoking the parent: retained callbacks cannot transfer twice.
      invalidate();
      const accepted = props.onConfirm(ingredients);
      if (
        !mounted.current ||
        closed.current ||
        latest.current.ownerUserId !== ticket.model.owner ||
        latest.current.scope !== ticket.scope
      )
        return;
      publish(
        accepted
          ? {
              ...emptyModel(ticket.model.owner),
              status: "Reviewed ingredients added to the recipe builder.",
            }
          : {
              ...ticket.model,
              busy: null,
              status:
                "The recipe builder changed or cannot accept these ingredients. Your review is kept; check the builder and try again.",
            },
      );
    } catch {
      if (!active(ticket)) return;
      publish({
        ...ticket.model,
        busy: null,
        status:
          "Your account or recipe capacity could not be confirmed. Your review is kept; try again.",
      });
    } finally {
      finish(ticket);
    }
  }

  function cancelReview() {
    if (!current()) return;
    change({ ...emptyModel(model.owner), status: "Ingredient review canceled." });
  }

  const visible = model.owner === props.ownerUserId && !closed.current;
  const working = props.disabled || model.busy !== null;
  const activeLine = model.lines?.find((line) => line.lineNumber === model.activeLine);
  const completed = model.lines?.filter((line) => line.ingredient !== null).length ?? 0;

  return (
    <section className="workspaceSection workspaceForm" aria-label="Review pasted ingredients">
      <h3>Review pasted ingredients</h3>
      <p className="fieldHelp">
        Paste ingredient lines, then choose a food and exact quantity for each. Pasted text stays in
        this review until you clear it; only confirmed food ingredients enter the recipe builder.
      </p>
      {visible && !model.lines ? (
        <div className="workspaceForm">
          <label className="formField">
            Pasted ingredient lines
            <textarea
              disabled={working}
              rows={6}
              value={model.paste}
              onChange={(event) => {
                if (!editable()) return;
                change({ ...model, paste: event.target.value, status: "" });
              }}
            />
          </label>
          <p className="sourceLine">
            Up to 50 nonblank lines, 500 characters per line, and 25,050 characters total.
            Ingredient amounts are never guessed.
          </p>
          <button className="buttonQuiet" disabled={working} onClick={startReview} type="button">
            Review pasted lines
          </button>
        </div>
      ) : null}
      {visible && model.lines ? (
        <div className="workspaceForm">
          <p className="sourceLine">
            {completed} of {model.lines.length} lines confirmed. The recipe has room for{" "}
            {props.remainingCapacity} more ingredients.
          </p>
          <ol className={`ingredientSearchResults ${styles.lines}`}>
            {model.lines.map((line) => (
              <li className={`ingredientResult ${styles.item}`} key={line.lineNumber}>
                <div>
                  <strong>Original line {line.lineNumber}</strong>
                  <p
                    className="sourceLine"
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {line.originalText}
                  </p>
                  {line.ingredient ? (
                    <p className="sourceLine">
                      Confirmed: {line.ingredient.name} · version {line.ingredient.foodVersionId} ·{" "}
                      {line.ingredient.portion.kind === "grams"
                        ? `${line.ingredient.portion.grams} g`
                        : `${line.ingredient.portion.amount} × ${line.ingredient.portion.servingLabel}`}{" "}
                      · {line.ingredient.source?.attributionText} ·{" "}
                      {line.ingredient.source?.licenseExpression}
                    </p>
                  ) : (
                    <p className="sourceLine">Needs your review</p>
                  )}
                </div>
                <button
                  className="buttonQuiet"
                  disabled={working}
                  onClick={() => openLine(line.lineNumber)}
                  type="button"
                >
                  Review line {line.lineNumber}
                </button>
              </li>
            ))}
          </ol>
          {activeLine ? (
            <fieldset disabled={working} className="workspaceSection">
              <legend>Resolve line {activeLine.lineNumber}</legend>
              <label className="formField">
                Food search for line {activeLine.lineNumber}
                <input
                  value={model.query}
                  onChange={(event) => {
                    if (!editable()) return;
                    change({
                      ...model,
                      query: event.target.value,
                      results: [],
                      food: null,
                      quantity: "",
                      status: "",
                    });
                  }}
                />
              </label>
              <button className="buttonQuiet" onClick={searchFoods} type="button">
                Search foods
              </button>
              <div className="ingredientSearchResults">
                {model.results.map((food) => (
                  <article className={`ingredientResult ${styles.item}`} key={food.foodVersionId}>
                    <div>
                      <strong>{food.name}</strong>
                      <p className="sourceLine">
                        {food.brandName ?? "Generic food"} · version {food.foodVersionId} ·{" "}
                        {food.source.displayName} ({food.source.code})
                      </p>
                      <p className="sourceLine">
                        {food.source.attributionText} · {food.source.licenseExpression}
                      </p>
                    </div>
                    <button
                      className="buttonQuiet"
                      onClick={() => {
                        if (!editable() || !model.results.includes(food)) return;
                        change({
                          ...model,
                          food,
                          quantityKind: "grams",
                          quantity: "",
                          status: "Enter the quantity you intend to use, then confirm this line.",
                        });
                      }}
                      type="button"
                    >
                      Select {food.name}
                    </button>
                  </article>
                ))}
              </div>
              {model.food ? (
                <div className="workspaceForm">
                  <p className="sourceLine">
                    Selected: {model.food.name} · version {model.food.foodVersionId} ·{" "}
                    {model.food.source.displayName} ({model.food.source.code}) ·{" "}
                    {model.food.source.attributionText} · {model.food.source.licenseExpression}
                  </p>
                  <label className="formField">
                    Quantity type for line {activeLine.lineNumber}
                    <select
                      value={model.quantityKind}
                      onChange={(event) => {
                        if (!editable() || !model.food) return;
                        const kind = event.target.value;
                        if (kind !== "grams" && kind !== "serving") return;
                        if (kind === "serving" && !hasReviewedGramServing(model.food)) return;
                        change({ ...model, quantityKind: kind, quantity: "", status: "" });
                      }}
                    >
                      <option value="grams">Grams</option>
                      <option value="serving" disabled={!hasReviewedGramServing(model.food)}>
                        Reviewed serving
                      </option>
                    </select>
                  </label>
                  {model.quantityKind === "serving" ? (
                    <p className="sourceLine">
                      One selected serving: {model.food.defaultServing?.label} ·{" "}
                      {model.food.defaultServing?.gramWeight} g
                    </p>
                  ) : null}
                  <label className="formField">
                    Quantity for line {activeLine.lineNumber}
                    <input
                      inputMode="decimal"
                      value={model.quantity}
                      onChange={(event) => {
                        if (!editable()) return;
                        change({ ...model, quantity: event.target.value, status: "" });
                      }}
                    />
                  </label>
                  <button className="buttonQuiet" onClick={confirmLine} type="button">
                    Confirm line {activeLine.lineNumber}
                  </button>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          <div>
            <button
              className="buttonPrimary"
              disabled={
                working ||
                completed !== model.lines.length ||
                model.lines.length > props.remainingCapacity
              }
              onClick={addReviewedIngredients}
              type="button"
            >
              Add reviewed ingredients
            </button>{" "}
            <button
              className="buttonQuiet"
              disabled={working}
              onClick={() => {
                if (!editable()) return;
                change({
                  ...emptyModel(model.owner),
                  paste: model.paste,
                  status: "Edit the original lines, then review each line again.",
                });
              }}
              type="button"
            >
              Edit pasted lines
            </button>
          </div>
        </div>
      ) : null}
      {visible && (model.paste || model.lines) ? (
        <button
          className="buttonQuiet"
          disabled={props.disabled}
          onClick={cancelReview}
          type="button"
        >
          Cancel ingredient review
        </button>
      ) : null}
      <p className="workspaceStatus" role="status" aria-live="polite">
        {visible ? model.status : ""}
      </p>
    </section>
  );
}
