"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isLocalDate, parseSession } from "../../lib/diary";
import { formatExactAmount } from "../../lib/nutrition-display";
import { installPrivateDataForOwner, PrivateOwnerFenceError } from "../../lib/private-owner";
import { type CustomFood, parseCustomFoodList } from "../../lib/retention";

export interface MyFoodIngredientPickerProps {
  readonly ownerUserId: string;
  readonly date?: string;
  readonly disabled: boolean;
  readonly remainingCapacity: number;
  readonly onAdd: (food: CustomFood, mode: "grams" | "serving") => boolean;
  readonly onSessionClosed: () => void;
}

interface FoodList {
  readonly owner: string;
  readonly foods: readonly CustomFood[];
  readonly filter: string;
  readonly cursor: string | null;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly verified: boolean;
  readonly message: string;
  readonly retry: "refresh" | "more" | null;
}

function emptyList(owner: string): FoodList {
  return {
    owner,
    foods: [],
    filter: "",
    cursor: null,
    status: "idle",
    verified: false,
    message: "",
    retry: null,
  };
}

function problem(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return fallback;
  return typeof body.error === "string" && body.error.length <= 500 ? body.error : fallback;
}

export function MyFoodIngredientPicker(props: MyFoodIngredientPickerProps) {
  const [model, setModel] = useState<FoodList>(() => emptyList(props.ownerUserId));
  const modelRef = useRef(model);
  const mounted = useRef(false);
  const closed = useRef(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef({ ...props, scope: 0 });
  const scope =
    latest.current.scope +
    Number(
      latest.current.ownerUserId !== props.ownerUserId ||
        latest.current.disabled !== props.disabled,
    );
  latest.current = { ...props, scope };

  const install = useCallback((next: FoodList) => {
    modelRef.current = next;
    setModel(next);
  }, []);
  const invalidate = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    closed.current = false;
    install(emptyList(latest.current.ownerUserId));
    return () => {
      mounted.current = false;
      closed.current = true;
      invalidate();
      modelRef.current = emptyList("");
    };
  }, [install, invalidate]);

  useEffect(() => {
    const current = modelRef.current;
    if (!props.disabled && current.owner === props.ownerUserId && current.status !== "loading")
      return;
    invalidate();
    if (current.owner !== props.ownerUserId) install(emptyList(props.ownerUserId));
    else if (current.status === "loading") {
      install({
        ...current,
        status: current.verified ? "ready" : "idle",
        message: "",
        retry: null,
      });
    }
  }, [props.ownerUserId, props.disabled, install, invalidate]);

  function canUse() {
    return (
      mounted.current &&
      !closed.current &&
      !props.disabled &&
      !latest.current.disabled &&
      latest.current.scope === scope &&
      latest.current.ownerUserId === props.ownerUserId &&
      modelRef.current === model &&
      model.owner === props.ownerUserId
    );
  }

  async function load(append = false) {
    if (
      !canUse() ||
      request.current !== null ||
      (append && (!model.verified || model.cursor === null))
    )
      return;
    const previous = model;
    const controller = new AbortController();
    const ticket = ++generation.current;
    request.current = controller;
    const current = () =>
      mounted.current &&
      !closed.current &&
      !controller.signal.aborted &&
      request.current === controller &&
      generation.current === ticket &&
      latest.current.scope === scope &&
      latest.current.ownerUserId === props.ownerUserId &&
      !latest.current.disabled;
    install({
      ...previous,
      status: "loading",
      message: append ? "Loading more personal foods…" : "Loading your personal foods…",
      retry: null,
    });
    let invalidCursor = false;
    try {
      await installPrivateDataForOwner({
        expectedOwnerUserId: props.ownerUserId,
        signal: controller.signal,
        loadPrivateData: async () => {
          const cursor = append ? `&cursor=${encodeURIComponent(previous.cursor ?? "")}` : "";
          const response = await fetch(`/api/retention/custom-foods?limit=50${cursor}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (!current())
            throw new DOMException("The food request is no longer current.", "AbortError");
          if (response.status === 401) throw new PrivateOwnerFenceError();
          invalidCursor = append && (response.status === 400 || response.status === 409);
          const body: unknown = await response.json().catch(() => null);
          if (!response.ok)
            throw new Error(problem(body, "Your personal foods could not be loaded."));
          return parseCustomFoodList(body);
        },
        revalidateSession: async () => {
          if (!current())
            throw new DOMException("The food request is no longer current.", "AbortError");
          const response = await fetch("/api/auth/me", {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 401) throw new PrivateOwnerFenceError();
          if (!response.ok) throw new Error("Your personal-food session could not be verified.");
          return parseSession(await response.json().catch(() => null));
        },
        install: (page) => {
          if (!current()) return;
          const foods = new Map((append ? previous.foods : []).map((food) => [food.id, food]));
          for (const food of page.items) {
            if (food.status !== "active") foods.delete(food.id);
            else if (
              (foods.get(food.id)?.currentVersion.versionNumber ?? 0) <=
              food.currentVersion.versionNumber
            )
              foods.set(food.id, food);
          }
          install({
            ...previous,
            foods: [...foods.values()],
            cursor: page.nextCursor,
            status: "ready",
            verified: true,
            message: "",
            retry: null,
          });
        },
      });
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof PrivateOwnerFenceError) {
        closed.current = true;
        invalidate();
        install(emptyList(props.ownerUserId));
        props.onSessionClosed();
        return;
      }
      install({
        ...previous,
        cursor: invalidCursor ? null : previous.cursor,
        status: "error",
        message: invalidCursor
          ? "These food choices changed. Refresh your personal foods to continue."
          : caught instanceof Error
            ? caught.message
            : "Your personal foods could not be loaded.",
        retry: append && !invalidCursor ? "more" : "refresh",
      });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const normalizedFilter = model.filter.trim().toLowerCase();
  const visible = model.owner === props.ownerUserId && !closed.current;
  const foods = visible
    ? model.foods.filter((food) =>
        food.currentVersion.name.toLowerCase().includes(normalizedFilter),
      )
    : [];
  const manageHref = `/foods/custom${props.date && isLocalDate(props.date) ? `?date=${encodeURIComponent(props.date)}` : ""}`;
  const controlsDisabled = !canUse() || model.status === "loading";
  const choicesDisabled =
    controlsDisabled || !model.verified || model.status !== "ready" || props.remainingCapacity <= 0;

  function changeFilter(value: string) {
    if (!canUse() || request.current !== null || !model.verified) return;
    install({ ...model, filter: value.slice(0, 200) });
  }

  function add(food: CustomFood, mode: "grams" | "serving") {
    if (
      !canUse() ||
      request.current !== null ||
      !model.verified ||
      model.status !== "ready" ||
      props.remainingCapacity <= 0 ||
      latest.current.remainingCapacity <= 0 ||
      !model.foods.includes(food) ||
      !food.currentVersion.name.toLowerCase().includes(normalizedFilter) ||
      food.status !== "active" ||
      (mode === "serving" && !food.currentVersion.serving)
    )
      return;
    props.onAdd(food, mode);
  }

  return (
    <section className="workspaceSection" aria-labelledby="my-food-ingredients-heading">
      <h3 id="my-food-ingredients-heading">My foods</h3>
      <p className="fieldHelp">
        Add a personal food using its saved nutrition. Revising it later won’t change this
        ingredient. An archived food cannot be used when saving a new or revised recipe; recipes
        already saved can still be logged.
      </p>
      <div className="myFoodPickerActions">
        <button
          className="buttonSecondary"
          type="button"
          disabled={controlsDisabled}
          onClick={() => void load()}
        >
          {visible && model.verified
            ? "Refresh my foods"
            : visible && model.status === "error"
              ? "Retry my foods"
              : "Load my foods"}
        </button>
        <Link className="buttonQuiet" href={manageHref}>
          Manage my foods
        </Link>
      </div>
      {visible && model.verified ? (
        <>
          <label className="formField" htmlFor="my-food-ingredient-filter">
            <span>Filter loaded personal foods by name</span>
            <input
              id="my-food-ingredient-filter"
              type="search"
              maxLength={200}
              disabled={controlsDisabled}
              value={model.filter}
              onChange={(event) => changeFilter(event.target.value)}
              aria-describedby="my-food-ingredients-status"
            />
          </label>
          <button
            className="buttonQuiet"
            type="button"
            disabled={controlsDisabled || model.filter === ""}
            onClick={() => changeFilter("")}
          >
            Clear my foods filter
          </button>
        </>
      ) : null}
      <p className="fieldHelp" role="status" aria-live="polite" id="my-food-ingredients-status">
        {visible && model.verified
          ? `${foods.length} of ${model.foods.length} loaded personal foods match. ${model.status === "ready" ? (model.cursor ? "More foods may be available." : "All personal foods are loaded.") : ""}`
          : "Load your personal foods when you want to add one."}
        {visible && model.message ? ` ${model.message}` : ""}
      </p>
      {visible && model.verified && model.status === "error" ? (
        <button
          className="buttonSecondary"
          type="button"
          disabled={controlsDisabled}
          onClick={() => void load(model.retry === "more")}
        >
          Retry my foods
        </button>
      ) : null}
      {visible && model.status === "ready" && foods.length === 0 ? (
        <p className="fieldHelp">
          {model.foods.length === 0
            ? "No active personal foods are available."
            : "No loaded personal foods match this name."}
        </p>
      ) : null}
      <div className="ingredientSearchResults">
        {foods.map((food) => (
          <article className="ingredientResult" key={food.id}>
            <div>
              <strong>{food.currentVersion.name}</strong>
              {food.currentVersion.brandName ? (
                <p className="sourceLine">{food.currentVersion.brandName}</p>
              ) : null}
              <p className="sourceLine">
                Personal food · saved version {food.currentVersion.versionNumber}
              </p>
              <p className="sourceLine">
                {food.currentVersion.serving
                  ? `${food.currentVersion.serving.label} · ${formatExactAmount(food.currentVersion.serving.grams, "g")}`
                  : "No saved serving; use grams."}
              </p>
            </div>
            <div>
              {food.currentVersion.serving ? (
                <button
                  className="buttonQuiet"
                  type="button"
                  disabled={choicesDisabled}
                  aria-label={`Add one ${food.currentVersion.serving.label} of ${food.currentVersion.name} version ${food.currentVersion.versionNumber}`}
                  onClick={() => add(food, "serving")}
                >
                  Add serving
                </button>
              ) : null}{" "}
              <button
                className="buttonQuiet"
                type="button"
                disabled={choicesDisabled}
                aria-label={`Add 100 g of ${food.currentVersion.name} version ${food.currentVersion.versionNumber}`}
                onClick={() => add(food, "grams")}
              >
                Add 100 g
              </button>
            </div>
          </article>
        ))}
      </div>
      {visible && model.cursor !== null ? (
        <button
          className="buttonSecondary"
          type="button"
          disabled={controlsDisabled || model.status !== "ready"}
          onClick={() => void load(true)}
        >
          Load more personal foods
        </button>
      ) : null}
    </section>
  );
}
