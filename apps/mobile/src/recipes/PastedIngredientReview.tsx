import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { apiUrl, authenticatedHeaders, jsonBody } from "../api/private-api";
import { newOperationId } from "../auth/operation-id";
import { parseSession } from "../diary/diary";
import { buildSearchUrl, type FoodSearchHit, parseSearchPage } from "../search/food-search";
import { palette } from "../theme";
import {
  collectReviewedIngredients,
  hasReviewedGramServing,
  parsePastedIngredientLines,
  type ReviewedIngredientLine,
  reviewedFoodIngredient,
} from "./recipe-ingredient-review";
import type { RecipeIngredientDraft } from "./recipes-goals";

export interface PastedIngredientReviewProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly ownerUserId: string;
  readonly disabled: boolean;
  readonly remainingCapacity: number;
  readonly onConfirm: (ingredients: readonly RecipeIngredientDraft[]) => boolean;
  readonly onSessionClosed: () => void;
}

interface ReviewModel {
  readonly owner: string;
  readonly identity: number;
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

function emptyModel(owner: string, identity: number): ReviewModel {
  return {
    owner,
    identity,
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
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly controller: AbortController;
  readonly generation: number;
  readonly scope: number;
  readonly model: ReviewModel;
}

export function PastedIngredientReview(props: PastedIngredientReviewProps) {
  const [model, setModel] = useState<ReviewModel>(() => emptyModel(props.ownerUserId, 0));
  const modelRef = useRef(model);
  const mounted = useRef(false);
  const closed = useRef(false);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const foreground = useRef(AppState.currentState === "active");
  const latest = useRef({ ...props, destination: props.apiBase.href, identity: 0, scope: 0 });
  const identity =
    latest.current.identity +
    Number(
      latest.current.ownerUserId !== props.ownerUserId ||
        latest.current.accessToken !== props.accessToken ||
        latest.current.destination !== props.apiBase.href,
    );
  const scope =
    latest.current.scope +
    Number(latest.current.identity !== identity || latest.current.disabled !== props.disabled);
  latest.current = { ...props, destination: props.apiBase.href, identity, scope };

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
    publish(emptyModel(latest.current.ownerUserId, latest.current.identity));
    return () => {
      mounted.current = false;
      closed.current = true;
      invalidate();
      modelRef.current = emptyModel("", -1);
    };
  }, [invalidate, publish]);

  useEffect(() => {
    invalidate();
    if (modelRef.current.identity !== identity) {
      closed.current = false;
      publish(emptyModel(props.ownerUserId, identity));
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
  }, [identity, props.ownerUserId, props.disabled, invalidate, publish]);

  useEffect(() => {
    foreground.current = AppState.currentState === "active";
    const subscription = AppState.addEventListener("change", (state) => {
      if (!mounted.current) return;
      if (foreground.current === (state === "active")) return;
      foreground.current = state === "active";
      invalidate();
      publish({
        ...emptyModel(latest.current.ownerUserId, latest.current.identity),
        status:
          state === "active"
            ? "Ingredient review is ready. Paste your lines to begin again."
            : "Ingredient review cleared when the app left the foreground.",
      });
    });
    return () => subscription.remove();
  }, [invalidate, publish]);

  function current(rendered: ReviewModel = model): boolean {
    return (
      mounted.current &&
      foreground.current &&
      !closed.current &&
      !latest.current.disabled &&
      latest.current.scope === scope &&
      latest.current.ownerUserId === rendered.owner &&
      latest.current.identity === rendered.identity &&
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
    publish(emptyModel(latest.current.ownerUserId, latest.current.identity));
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
    return {
      apiBase: new URL(latest.current.destination),
      accessToken: latest.current.accessToken,
      controller,
      generation: generation.current,
      scope,
      model: next,
    };
  }

  function active(ticket: RequestTicket): boolean {
    return (
      mounted.current &&
      foreground.current &&
      !closed.current &&
      !latest.current.disabled &&
      latest.current.ownerUserId === ticket.model.owner &&
      latest.current.identity === ticket.model.identity &&
      latest.current.scope === ticket.scope &&
      generation.current === ticket.generation &&
      modelRef.current === ticket.model &&
      !ticket.controller.signal.aborted
    );
  }

  async function verifyOwner(ticket: RequestTicket): Promise<boolean> {
    const response = await fetch(apiUrl(ticket.apiBase, "/v1/auth/me").toString(), {
      headers: authenticatedHeaders(ticket.accessToken),
      redirect: "error",
      signal: ticket.controller.signal,
    });
    if (!active(ticket)) return false;
    if (response.status === 401) {
      closeSession(ticket);
      return false;
    }
    const body: unknown = await jsonBody(response);
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
      path = buildSearchUrl(new URL(latest.current.destination), model.query, "all").toString();
    } catch {
      change({ ...model, status: "Enter a food-search query of 1 to 128 characters." });
      return;
    }
    const ticket = begin("search");
    try {
      const response = await fetch(path, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: ticket.controller.signal,
      });
      if (!active(ticket)) return;
      if (response.status === 401) {
        closeSession(ticket);
        return;
      }
      const body: unknown = await jsonBody(response);
      if (!active(ticket)) return;
      if (!response.ok) throw new Error("Food search is unavailable.");
      const page = parseSearchPage(body);
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
        ...emptyModel(model.owner, model.identity),
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
        newOperationId(),
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
      const accepted = latest.current.onConfirm(ingredients);
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
              ...emptyModel(ticket.model.owner, ticket.model.identity),
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
    change({ ...emptyModel(model.owner, model.identity), status: "Ingredient review canceled." });
  }

  const visible =
    model.owner === props.ownerUserId && model.identity === identity && !closed.current;
  const working = props.disabled || !foreground.current || model.busy !== null;
  const activeLine = model.lines?.find((line) => line.lineNumber === model.activeLine);
  const completed = model.lines?.filter((line) => line.ingredient !== null).length ?? 0;

  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        Review pasted ingredients
      </Text>
      <Text style={styles.help}>
        Paste ingredient lines, then choose a food and exact quantity for each. Only confirmed food
        ingredients enter the recipe builder. This review clears when you leave the app.
      </Text>
      {visible && !model.lines ? (
        <View style={styles.section}>
          <Text style={styles.label}>Pasted ingredient lines</Text>
          <TextInput
            accessibilityLabel="Pasted ingredient lines"
            accessibilityState={{ disabled: working }}
            autoComplete="off"
            autoCorrect={false}
            editable={!working}
            multiline
            onChangeText={(paste) => {
              if (!editable()) return;
              change({ ...model, paste, status: "" });
            }}
            style={[styles.input, styles.multiline]}
            value={model.paste}
          />
          <Text style={styles.help}>
            Up to 50 nonblank lines, 500 characters per line, and 25,050 characters total.
            Ingredient amounts are never guessed.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            disabled={working}
            onPress={startReview}
            style={[styles.secondary, working && styles.disabled]}
          >
            <Text style={styles.secondaryText}>Review pasted lines</Text>
          </Pressable>
        </View>
      ) : null}
      {visible && model.lines ? (
        <View style={styles.section}>
          <Text style={styles.help}>
            {completed} of {model.lines.length} lines confirmed. The recipe has room for{" "}
            {props.remainingCapacity} more ingredients.
          </Text>
          {model.lines.map((line) => (
            <View key={line.lineNumber} style={styles.item}>
              <Text accessibilityRole="header" style={styles.itemTitle}>
                Original line {line.lineNumber}
              </Text>
              <Text style={styles.original}>{line.originalText}</Text>
              {line.ingredient ? (
                <Text style={styles.help}>
                  Confirmed: {line.ingredient.name} · version {line.ingredient.foodVersionId} ·{" "}
                  {line.ingredient.portion.kind === "grams"
                    ? `${line.ingredient.portion.grams} g`
                    : `${line.ingredient.portion.amount} × ${line.ingredient.portion.servingLabel}`}{" "}
                  · {line.ingredient.source?.attributionText} ·{" "}
                  {line.ingredient.source?.licenseExpression}
                </Text>
              ) : (
                <Text style={styles.help}>Needs your review</Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: working }}
                disabled={working}
                onPress={() => openLine(line.lineNumber)}
                style={[styles.secondary, working && styles.disabled]}
              >
                <Text style={styles.secondaryText}>Review line {line.lineNumber}</Text>
              </Pressable>
            </View>
          ))}
          {activeLine ? (
            <View style={styles.item}>
              <Text accessibilityRole="header" style={styles.itemTitle}>
                Resolve line {activeLine.lineNumber}
              </Text>
              <Text style={styles.label}>Food search for line {activeLine.lineNumber}</Text>
              <TextInput
                accessibilityLabel={`Food search for line ${activeLine.lineNumber}`}
                accessibilityState={{ disabled: working }}
                autoComplete="off"
                editable={!working}
                onChangeText={(query) => {
                  if (!editable()) return;
                  change({ ...model, query, results: [], food: null, quantity: "", status: "" });
                }}
                style={styles.input}
                value={model.query}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: working }}
                disabled={working}
                onPress={searchFoods}
                style={[styles.secondary, working && styles.disabled]}
              >
                <Text style={styles.secondaryText}>Search foods</Text>
              </Pressable>
              {model.results.map((food) => (
                <View key={food.foodVersionId} style={styles.item}>
                  <Text style={styles.itemTitle}>{food.name}</Text>
                  <Text style={styles.help}>
                    {food.brandName ?? "Generic food"} · version {food.foodVersionId} ·{" "}
                    {food.source.displayName} ({food.source.code})
                  </Text>
                  <Text style={styles.help}>
                    {food.source.attributionText} · {food.source.licenseExpression}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: working }}
                    disabled={working}
                    onPress={() => {
                      if (!editable() || !model.results.includes(food)) return;
                      change({
                        ...model,
                        food,
                        quantityKind: "grams",
                        quantity: "",
                        status: "Enter the quantity you intend to use, then confirm this line.",
                      });
                    }}
                    style={[styles.secondary, working && styles.disabled]}
                  >
                    <Text style={styles.secondaryText}>Select {food.name}</Text>
                  </Pressable>
                </View>
              ))}
              {model.food ? (
                <View style={styles.section}>
                  <Text style={styles.help}>
                    Selected: {model.food.name} · version {model.food.foodVersionId} ·{" "}
                    {model.food.source.displayName} ({model.food.source.code}) ·{" "}
                    {model.food.source.attributionText} · {model.food.source.licenseExpression}
                  </Text>
                  <Text style={styles.label}>Quantity type for line {activeLine.lineNumber}</Text>
                  <Pressable
                    accessibilityLabel="Grams"
                    accessibilityRole="radio"
                    accessibilityState={{
                      checked: model.quantityKind === "grams",
                      disabled: working,
                    }}
                    disabled={working}
                    onPress={() => {
                      if (!editable()) return;
                      change({ ...model, quantityKind: "grams", quantity: "", status: "" });
                    }}
                    style={[
                      styles.secondary,
                      model.quantityKind === "grams" && styles.selected,
                      working && styles.disabled,
                    ]}
                  >
                    <Text style={styles.secondaryText}>Grams</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Reviewed serving"
                    accessibilityRole="radio"
                    accessibilityState={{
                      checked: model.quantityKind === "serving",
                      disabled: working || !hasReviewedGramServing(model.food),
                    }}
                    disabled={working || !hasReviewedGramServing(model.food)}
                    onPress={() => {
                      if (!editable() || !model.food || !hasReviewedGramServing(model.food)) return;
                      change({ ...model, quantityKind: "serving", quantity: "", status: "" });
                    }}
                    style={[
                      styles.secondary,
                      model.quantityKind === "serving" && styles.selected,
                      (working || !hasReviewedGramServing(model.food)) && styles.disabled,
                    ]}
                  >
                    <Text style={styles.secondaryText}>Reviewed serving</Text>
                  </Pressable>
                  {model.quantityKind === "serving" ? (
                    <Text style={styles.help}>
                      One selected serving: {model.food.defaultServing?.label} ·{" "}
                      {model.food.defaultServing?.gramWeight} g
                    </Text>
                  ) : null}
                  {!hasReviewedGramServing(model.food) ? (
                    <Text style={styles.help}>
                      This food has no positive gram-resolved serving. Enter explicit grams.
                    </Text>
                  ) : null}
                  <Text style={styles.label}>Quantity for line {activeLine.lineNumber}</Text>
                  <TextInput
                    accessibilityLabel={`Quantity for line ${activeLine.lineNumber}`}
                    accessibilityState={{ disabled: working }}
                    editable={!working}
                    keyboardType="decimal-pad"
                    onChangeText={(quantity) => {
                      if (!editable()) return;
                      change({ ...model, quantity, status: "" });
                    }}
                    style={styles.input}
                    value={model.quantity}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: working }}
                    disabled={working}
                    onPress={confirmLine}
                    style={[styles.secondary, working && styles.disabled]}
                  >
                    <Text style={styles.secondaryText}>Confirm line {activeLine.lineNumber}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              disabled:
                working ||
                completed !== model.lines.length ||
                model.lines.length > props.remainingCapacity,
            }}
            disabled={
              working ||
              completed !== model.lines.length ||
              model.lines.length > props.remainingCapacity
            }
            onPress={addReviewedIngredients}
            style={[
              styles.primary,
              (working ||
                completed !== model.lines.length ||
                model.lines.length > props.remainingCapacity) &&
                styles.disabled,
            ]}
          >
            <Text style={styles.primaryText}>Add reviewed ingredients</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            disabled={working}
            onPress={() => {
              if (!editable()) return;
              change({
                ...emptyModel(model.owner, model.identity),
                paste: model.paste,
                status: "Edit the original lines, then review each line again.",
              });
            }}
            style={[styles.secondary, working && styles.disabled]}
          >
            <Text style={styles.secondaryText}>Edit pasted lines</Text>
          </Pressable>
        </View>
      ) : null}
      {visible && (model.paste || model.lines) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled || !foreground.current }}
          disabled={props.disabled || !foreground.current}
          onPress={cancelReview}
          style={[styles.secondary, (props.disabled || !foreground.current) && styles.disabled]}
        >
          <Text style={styles.secondaryText}>Cancel ingredient review</Text>
        </Pressable>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={styles.status}>
        {visible ? model.status : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 18,
    padding: 14,
  },
  title: { color: palette.ink, fontSize: 20, fontWeight: "700" },
  section: { gap: 8, minWidth: 0 },
  item: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 12,
    gap: 8,
    minWidth: 0,
  },
  itemTitle: { color: palette.ink, fontSize: 15, fontWeight: "700" },
  original: { color: palette.ink, fontSize: 15, lineHeight: 22, flexShrink: 1 },
  help: { color: palette.muted, fontSize: 13, lineHeight: 19, marginVertical: 6, flexShrink: 1 },
  label: { color: palette.muted, fontSize: 13, fontWeight: "700", marginTop: 12 },
  input: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  multiline: { minHeight: 144, paddingVertical: 12, textAlignVertical: "top" },
  primary: {
    backgroundColor: palette.forest,
    borderRadius: 9,
    minHeight: 48,
    justifyContent: "center",
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryText: { color: palette.white, fontSize: 14, fontWeight: "700" },
  secondary: {
    borderColor: palette.forest,
    borderRadius: 9,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: "center",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryText: { color: palette.forest, fontSize: 14, fontWeight: "700" },
  selected: { backgroundColor: palette.lime },
  disabled: { opacity: 0.5 },
  status: { color: palette.muted, fontSize: 14, lineHeight: 20, marginTop: 14 },
});
