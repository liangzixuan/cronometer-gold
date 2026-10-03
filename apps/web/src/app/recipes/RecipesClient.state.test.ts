import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the actual component and its effects with deterministic synchronous hooks.
// This observes request/state transitions; browser layout and concurrent React are
// separate acceptance evidence, not claims made by this harness.
const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    effect?: (() => undefined | (() => void)) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let closed = false;
  let afterClose = 0;
  let effects: Array<() => void> = [];
  let component: () => unknown;
  let tree: unknown;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((item, index) => Object.is(item, b[index]));
  const render = (runEffects = true) => {
    cursor = 0;
    dirty = false;
    tree = component();
    if (!runEffects) return;
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
  };
  return {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const slot = slots[index] as Slot;
      return [
        slot.value as T,
        (change: T | ((current: T) => T)) => {
          if (closed) afterClose += 1;
          const next =
            typeof change === "function" ? (change as (current: T) => T)(slot.value as T) : change;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return old.value as T;
      const value = factory();
      slots[index] = { value, deps };
      return value;
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return;
      const slot: Slot = { ...(deps ? { deps } : {}), effect };
      slots[index] = slot;
      effects.push(() => {
        old?.cleanup?.();
        slot.cleanup = effect();
      });
    },
    replayEffects() {
      const mountedEffects = slots.filter((slot) => slot.effect);
      for (const slot of mountedEffects) slot.cleanup?.();
      for (const slot of mountedEffects) slot.cleanup = slot.effect?.();
    },
    mount(next: () => unknown) {
      slots = [];
      effects = [];
      closed = false;
      afterClose = 0;
      component = next;
      render();
    },
    render,
    renderWithoutEffects: () => render(false),
    async settle() {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty && !closed) render();
      }
    },
    tree: () => tree,
    afterClose: () => afterClose,
    unmount() {
      if (closed) return;
      closed = true;
      for (const slot of slots) slot.cleanup?.();
    },
  };
});

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const navigation = vi.hoisted(() => ({ query: "date=2026-09-09" }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

import { type DiaryNutrient, defaultDiaryGroups, localDateInTimeZone } from "../../lib/diary";
import type { FoodSearchHit } from "../../lib/food-search";
import { parseRecipeResponse, type RecipeIngredientDraft } from "../../lib/recipes-goals";
import type { CustomFood } from "../../lib/retention";
import { MyFoodIngredientPicker, type MyFoodIngredientPickerProps } from "./MyFoodIngredientPicker";
import { PastedIngredientReview } from "./PastedIngredientReview";
import { RecipesClient } from "./RecipesClient";
import { SavedRecipeInspection } from "./SavedRecipeInspection";

interface ElementNode {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function elements(value: unknown = hooks.tree()): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item ?? null));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ElementNode;
  if (node.type === SavedRecipeInspection)
    return elements(
      SavedRecipeInspection(node.props as unknown as Parameters<typeof SavedRecipeInspection>[0]),
    );
  return [node, ...elements(node.props.children ?? null)];
}
function text(value: unknown = hooks.tree()): string {
  if (Array.isArray(value)) return value.map((item) => text(item ?? null)).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  const node = value as ElementNode;
  if (node.type === SavedRecipeInspection)
    return text(
      SavedRecipeInspection(node.props as unknown as Parameters<typeof SavedRecipeInspection>[0]),
    );
  return text(node.props.children ?? null);
}
function button(label: string): ElementNode {
  const found = elements().find((node) => node.type === "button" && text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function field(label: string): ElementNode {
  const direct = elements().find((node) => node.props["aria-label"] === label);
  if (direct) return direct;
  const wrapper = elements().find(
    (node) =>
      node.type === "label" &&
      (text(node).trim().startsWith(label) ||
        elements(node.props.children).some(
          (child) => child.type === "span" && text(child) === label,
        )),
  );
  const found =
    wrapper &&
    (wrapper.props.htmlFor
      ? elements().find((node) => node.props.id === wrapper.props.htmlFor)
      : elements(wrapper.props.children).find((node) =>
          ["input", "select", "textarea"].includes(String(node.type)),
        ));
  if (!found) throw new Error(`Missing field: ${label}`);
  return found;
}
function invoke(node: ElementNode, action: string, ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node, "onClick");
  await hooks.settle();
}
async function change(label: string, value: string) {
  invoke(field(label), "onChange", { target: { value } });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture or observed call is missing.");
  return value;
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
function session(id = owner) {
  return Response.json({
    data: {
      user: { id, email: "owner@example.test", emailVerified: true },
      profile: {
        displayName: "Owner",
        birthDate: null,
        sexAtBirth: "not_specified",
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone: "America/Chicago",
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "4",
      },
    },
  });
}
const food = {
  foodId: "101",
  foodVersionId: "202",
  kind: "generic",
  name: "Rolled oats",
  brandName: null,
  marketCode: "US",
  languageTag: "en-US",
  source: {
    code: "USDA_FDC",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  defaultServing: {
    servingId: "303",
    label: "scoop",
    quantity: "1",
    unit: "scoop",
    gramWeight: "40.125",
    milliliterVolume: null,
  },
} satisfies FoodSearchHit;
function searchResponse() {
  return Response.json({ data: [food], page: { nextCursor: null } });
}

const recipeId = "ce126b7f-dfe5-4ee4-a75c-6b0f50c1963e";
const versionId = "db2ed69e-29d1-4330-a210-0a804f9ff2b3";
const timestamp = "2026-09-09T12:00:00.000Z";
function recipeWire(name = "Saved recipe") {
  const source = { ...food.source, releaseId: "eb8a4152-001f-4722-8bf1-8728ef8c14f8" };
  return {
    id: recipeId,
    status: "active",
    revision: "1",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentVersion: {
      id: versionId,
      versionNumber: 1,
      name,
      description: null,
      instructions: "Simmer.",
      ingredients: [
        {
          kind: "food",
          position: 0,
          foodVersionId: food.foodVersionId,
          name: food.name,
          brandName: null,
          portion: { kind: "grams", grams: "120" },
          resolvedGrams: "120",
          note: null,
          source,
          foodProvenance: { kind: "public", source },
        },
      ],
      finalYield: { grams: "120", source: "measured", ratioToInputMass: "1" },
      inputMassGrams: "120",
      servingCount: null,
      servingLabel: null,
      nutrition: { totals: [], per100Grams: [], perServing: null },
      sources: [source],
      retentionPolicy: {
        code: "identity-retention-default",
        version: "1",
        assumption: "No named retention factor set is applied.",
      },
      calculationVersion: "recipe-calculation-v1",
      warnings: [],
      createdAt: timestamp,
    },
  };
}
function collection() {
  const value = recipeWire();
  const version = value.currentVersion;
  return Response.json({
    data: [
      {
        ...value,
        currentVersion: {
          id: version.id,
          versionNumber: version.versionNumber,
          name: version.name,
          description: version.description,
          finalYield: { grams: "120", source: "measured" },
          inputMassGrams: "120",
          servingCount: null,
          servingLabel: null,
          warnings: [],
          createdAt: timestamp,
        },
      },
    ],
    page: { nextCursor: null },
  });
}
function detail(name?: string) {
  return Response.json({ data: { recipe: recipeWire(name) } });
}
function mutation(name?: string) {
  return Response.json({ data: { replayed: false, recipe: recipeWire(name) } });
}
function ingredient(clientKey: string, grams = "0.000001"): RecipeIngredientDraft {
  const source = {
    displayName: food.source.displayName,
    licenseExpression: food.source.licenseExpression,
    attributionText: food.source.attributionText,
  };
  return {
    kind: "food",
    clientKey,
    foodVersionId: food.foodVersionId,
    name: food.name,
    brandName: null,
    portion: { kind: "grams", grams },
    source,
    foodProvenance: { kind: "public", source },
    note: null,
  };
}
function review() {
  const found = elements().find((node) => node.type === PastedIngredientReview);
  if (!found) throw new Error("Missing pasted-ingredient child.");
  return found.props as unknown as Parameters<typeof PastedIngredientReview>[0];
}
function reviewPresent() {
  return elements().some((node) => node.type === PastedIngredientReview);
}
function openSaved() {
  const found = elements().find(
    (node) => node.type === "button" && text(node).startsWith("Saved recipe"),
  );
  if (!found) throw new Error("Missing saved recipe opener.");
  void invoke(found, "onClick");
}
function save() {
  const form = elements().find((node) => node.type === "form");
  if (!form) throw new Error("Missing recipe builder form.");
  void invoke(form, "onSubmit", { preventDefault() {} });
}
function readyFetcher() {
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/auth/me") return session();
    if (url.startsWith("/api/recipes?")) return collection();
    if (url.startsWith("/api/foods/search?")) return searchResponse();
    if (init?.method === "POST") return mutation();
    if (url === `/api/recipes/${recipeId}`) return detail();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function mountReady() {
  hooks.mount(RecipesClient);
  await hooks.settle();
  expect(review().ownerUserId).toBe(owner);
  expect(review().disabled).toBe(false);
}
beforeEach(() => {
  navigation.query = "date=2026-09-09";
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("actual recipe builder pasted-review integration", () => {
  it("uses real recipe parsers and mounts review only after owner verification", async () => {
    expect(parseRecipeResponse({ data: { recipe: recipeWire() } }).name).toBe("Saved recipe");
    readyFetcher();
    hooks.mount(RecipesClient);
    expect(reviewPresent()).toBe(false);
    await hooks.settle();
    expect(review().ownerUserId).toBe(owner);
    openSaved();
    await hooks.settle();
    expect(reviewPresent()).toBe(false);
    await click("New recipe");
    expect(reviewPresent()).toBe(true);
  });

  it("appends to the latest draft without replacing metadata, exact yield or existing ingredients", async () => {
    readyFetcher();
    await mountReady();
    expect(review().onConfirm([ingredient("existing", "2.500000")])).toBe(true);
    await hooks.settle();
    const retained = review().onConfirm;
    await change("Name", "Breakfast draft");
    await change("Description", "Keep my description.");
    await change("Instructions (optional)", "Keep my instructions.");
    await change("Final yield grams", "999999999999.999999");
    await change("Yield source", "estimated");
    await change("Serving count (optional)", "2.000001");
    await change("Serving label", "bowl");
    expect(retained([ingredient("reviewed")])).toBe(true);
    await hooks.settle();
    expect(field("Name").props.value).toBe("Breakfast draft");
    expect(field("Description").props.value).toBe("Keep my description.");
    expect(field("Instructions (optional)").props.value).toBe("Keep my instructions.");
    expect(field("Final yield grams").props.value).toBe("999999999999.999999");
    expect(field("Yield source").props.value).toBe("estimated");
    expect(field("Serving count (optional)").props.value).toBe("2.000001");
    expect(field("Serving label").props.value).toBe("bowl");
    expect(text()).toContain("Ingredients (2/50)");
    expect(
      elements()
        .filter((node) => node.props["aria-label"] === "Rolled oats quantity in grams")
        .map((node) => node.props.value),
    ).toEqual(["2.500000", "0.000001"]);
  });

  it("rechecks combined capacity and duplicate keys before an atomic append", async () => {
    readyFetcher();
    await mountReady();
    expect(review().onConfirm([ingredient("duplicate"), ingredient("duplicate")])).toBe(false);
    const first = Array.from({ length: 49 }, (_, index) => ingredient(`existing-${index}`));
    expect(review().onConfirm(first)).toBe(true);
    await hooks.settle();
    expect(review().remainingCapacity).toBe(1);
    expect(review().onConfirm([ingredient("extra-1"), ingredient("extra-2")])).toBe(false);
    expect(review().onConfirm([ingredient("existing-0")])).toBe(false);
    expect(review().onConfirm([ingredient("last")])).toBe(true);
    expect(review().onConfirm([ingredient("overflow")])).toBe(false);
    await hooks.settle();
    expect(text()).toContain("Ingredients (50/50)");
  });

  it.each(["new", "open", "closed", "unmounted"] as const)(
    "rejects a retained transfer callback after %s",
    async (transition) => {
      readyFetcher();
      await mountReady();
      const retained = review().onConfirm;
      if (transition === "new") await click("New recipe");
      if (transition === "open") {
        openSaved();
        await hooks.settle();
      }
      if (transition === "closed") {
        review().onSessionClosed();
        await hooks.settle();
      }
      if (transition === "unmounted") hooks.unmount();
      const updatesBefore = hooks.afterClose();
      expect(retained([ingredient("late")])).toBe(false);
      await hooks.settle();
      expect(hooks.afterClose()).toBe(updatesBefore);
      if (transition === "closed") expect(router.replace).toHaveBeenCalledWith("/login");
    },
  );

  it("sends only reviewed ingredient fields with exact quantity and required yield", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    const transfer = {
      ...ingredient("reviewed", "999999999999.999999"),
      rawText: "SECRET pasted original line",
      reviewedLineId: "private-line",
    };
    expect(review().onConfirm([transfer])).toBe(true);
    await hooks.settle();
    await change("Name", "Breakfast");
    await change("Final yield grams", "0.000001");
    await change("Instructions (optional)", "Only these intended instructions.");
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const [url, init] = required(posts[0]);
    expect(url).toBe("/api/recipes");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Breakfast",
      description: null,
      instructions: "Only these intended instructions.",
      ingredients: [
        {
          kind: "food",
          foodVersionId: "202",
          portion: { kind: "grams", grams: "999999999999.999999" },
          position: 0,
          note: null,
        },
      ],
      finalYield: { grams: "0.000001", source: "measured" },
      servingCount: null,
      servingLabel: null,
    });
    expect(String(init?.body)).not.toContain("SECRET");
    expect(String(init?.body)).not.toContain("reviewedLineId");
  });

  it.each(["fetch", "json"] as const)(
    "cannot install a delayed recipe open after New at the %s boundary",
    async (boundary) => {
      const pendingFetch = deferred<Response>();
      const pendingJson = deferred<unknown>();
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (url === `/api/recipes/${recipeId}`) {
          if (boundary === "fetch") return pendingFetch.promise;
          const response = detail();
          response.json = () => pendingJson.promise;
          return response;
        }
        return original(url, init);
      });
      await mountReady();
      openSaved();
      await hooks.settle();
      // Invoke the retained control even if the current DOM is disabled: callbacks must fence too.
      invoke(button("New recipe"), "onClick");
      await hooks.settle();
      await change("Name", "New draft survives");
      if (boundary === "fetch") pendingFetch.resolve(detail("Stale recipe"));
      else pendingJson.resolve(await detail("Stale recipe").json());
      await hooks.settle();
      expect(field("Name").props.value).toBe("New draft survives");
      expect(reviewPresent()).toBe(true);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("keeps a pending save in its current workspace when a retained New callback is invoked", async () => {
    const pendingJson = deferred<unknown>();
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        const response = mutation();
        response.json = () => pendingJson.promise;
        return response;
      }
      return original(url, init);
    });
    await mountReady();
    review().onConfirm([ingredient("saved")]);
    await hooks.settle();
    await change("Name", "First draft");
    await change("Final yield grams", "10");
    save();
    await hooks.settle();
    invoke(button("New recipe"), "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe("First draft");
    expect(button("New recipe").props.disabled).toBe(true);
    pendingJson.resolve(await mutation("Accepted current save").json());
    await hooks.settle();
    expect(field("Name").props.value).toBe("Accepted current save");
    expect(reviewPresent()).toBe(false);
  });

  it.each(["closed", "unmounted"] as const)(
    "cannot install a pending save receipt after the workspace is %s",
    async (transition) => {
      const pending = deferred<unknown>();
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "POST") {
          const response = mutation();
          response.json = () => pending.promise;
          return response;
        }
        return original(url, init);
      });
      await mountReady();
      review().onConfirm([ingredient("saved")]);
      await hooks.settle();
      await change("Name", "Private draft");
      await change("Final yield grams", "10");
      const close = review().onSessionClosed;
      save();
      await hooks.settle();
      if (transition === "closed") {
        close();
        await hooks.settle();
      } else hooks.unmount();
      const updatesBefore = hooks.afterClose();
      pending.resolve(await mutation("Stale private receipt").json());
      await hooks.settle();
      expect(hooks.afterClose()).toBe(updatesBefore);
      expect(text()).not.toContain("Stale private receipt");
      if (transition === "closed") {
        expect(reviewPresent()).toBe(false);
        expect(field("Name").props.value).toBe("");
      }
    },
  );

  it("keeps the draft and sends no POST when pre-save session verification returns 503", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    review().onConfirm([ingredient("saved", "12.000001")]);
    await hooks.settle();
    await change("Name", "Retryable draft");
    await change("Final yield grams", "10.000001");
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      url === "/api/auth/me"
        ? Response.json({ error: "Temporary authentication outage" }, { status: 503 })
        : original(url, init),
    );
    save();
    await hooks.settle();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    expect(field("Name").props.value).toBe("Retryable draft");
    expect(field("Final yield grams").props.value).toBe("10.000001");
    expect(text()).toContain("Ingredients (1/50)");
    expect(button("Create recipe").props.disabled).toBe(false);
  });

  it("retains the exact operation after accepted POST plus session 503 and confirms its replay", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    review().onConfirm([ingredient("saved", "12.000001")]);
    await hooks.settle();
    await change("Name", "Retryable accepted draft");
    await change("Final yield grams", "10.000001");
    const original = required(fetcher.getMockImplementation());
    let posts = 0;
    let failAfterWrite = true;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return Response.json({ data: { recipe: recipeWire(), replayed: posts > 1 } });
      }
      if (url === "/api/auth/me" && posts > 0 && failAfterWrite) {
        failAfterWrite = false;
        return Response.json(
          { error: "Temporary post-write authentication outage" },
          { status: 503 },
        );
      }
      return original(url, init);
    });
    save();
    await hooks.settle();
    expect(posts).toBe(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(field("Name").props.value).toBe("Retryable accepted draft");
    expect(field("Final yield grams").props.value).toBe("10.000001");
    expect(reviewPresent()).toBe(true);
    save();
    await hooks.settle();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    const first = required(writes[0]);
    const retry = required(writes[1]);
    expect(retry[0]).toBe(first[0]);
    expect(retry[1]?.body).toBe(first[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(first[1]?.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(text()).toContain("The earlier save was confirmed safely.");
    expect(reviewPresent()).toBe(false);
  });

  it("ignores aborted first-generation auth 401 after StrictMode replay verified the owner", async () => {
    const first = deferred<Response>();
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    let authCalls = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (url === "/api/auth/me" && ++authCalls === 1) return first.promise;
      return original(url, init);
    });
    hooks.mount(RecipesClient);
    hooks.replayEffects();
    await hooks.settle();
    await change("Name", "Active owner draft");
    first.resolve(Response.json({ error: "Expired old request" }, { status: 401 }));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(field("Name").props.value).toBe("Active owner draft");
    expect(review().ownerUserId).toBe(owner);
  });
});

function nutritionRecipe({
  id = recipeId,
  version = 1,
  serving = true,
  name = "Saved recipe",
} = {}) {
  const recipe = recipeWire(name);
  const nutrients = (knownAmount: string): DiaryNutrient[] => {
    const quantified = {
      nutrientId: "zero",
      code: "ZERO",
      name: "Measured zero",
      unit: "g",
      knownAmount: "0",
      completeness: "complete" as const,
      isExact: true,
      contributorCount: 1,
      quantifiedCount: 1,
      traceCount: 0,
      unknownCount: 0,
      unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
    };
    return [
      quantified,
      {
        ...quantified,
        nutrientId: "unknown",
        code: "UNKNOWN",
        name: "Unknown nutrient",
        completeness: "unknown",
        isExact: false,
        quantifiedCount: 0,
        unknownCount: 1,
        unknownReasonCounts: { ...quantified.unknownReasonCounts, not_reported: 1 },
      },
      {
        ...quantified,
        nutrientId: "partial",
        code: "PARTIAL",
        name: "Partial nutrient",
        knownAmount,
        completeness: "partial",
        isExact: false,
        contributorCount: 2,
        unknownCount: 1,
        unknownReasonCounts: { ...quantified.unknownReasonCounts, not_analyzed: 1 },
      },
      {
        ...quantified,
        nutrientId: "trace",
        code: "TRACE",
        name: "Trace nutrient",
        isExact: false,
        quantifiedCount: 0,
        traceCount: 1,
      },
    ];
  };
  return {
    ...recipe,
    id,
    revision: String(version),
    currentVersion: {
      ...recipe.currentVersion,
      id: version === 1 ? versionId : "b2a81dce-a424-49d6-865c-3f28545a73ec",
      versionNumber: version,
      servingCount: serving ? "2" : null,
      servingLabel: serving ? "bowl" : null,
      nutrition: {
        totals: nutrients("148.1481468"),
        per100Grams: nutrients("123.456789"),
        perServing: serving ? nutrients("74.0740734") : null,
      },
    },
  };
}
function nutritionCollection(values: readonly ReturnType<typeof nutritionRecipe>[]) {
  return Response.json({
    data: values.map((recipe) => ({
      ...recipe,
      currentVersion: {
        id: recipe.currentVersion.id,
        versionNumber: recipe.currentVersion.versionNumber,
        name: recipe.currentVersion.name,
        description: recipe.currentVersion.description,
        finalYield: { grams: "120", source: "measured" },
        inputMassGrams: "120",
        servingCount: recipe.currentVersion.servingCount,
        servingLabel: recipe.currentVersion.servingLabel,
        warnings: [],
        createdAt: timestamp,
      },
    })),
    page: { nextCursor: null },
  });
}
function nutritionFetcher(recipes = [nutritionRecipe()]) {
  const fetcher = readyFetcher();
  const original = required(fetcher.getMockImplementation());
  fetcher.mockImplementation(async (url, init) => {
    if (url.startsWith("/api/recipes?")) return nutritionCollection(recipes);
    const selected = recipes.find((recipe) => url === `/api/recipes/${recipe.id}`);
    if (selected) return Response.json({ data: { recipe: selected } });
    return original(url, init);
  });
  return fetcher;
}
function nutritionRows() {
  const table = required(elements().find((node) => node.props.className === "nutritionTable"));
  return elements(table)
    .filter((node) => node.type === "tr")
    .slice(1)
    .map((row) =>
      elements(row)
        .filter((node) => node.type === "td")
        .map((cell) => text(cell)),
    );
}
function openNamedRecipe(name: string) {
  const opener = required(
    elements().find((node) => node.type === "button" && text(node).startsWith(name)),
  );
  void invoke(opener, "onClick");
}

describe("actual saved recipe nutrition inspection", () => {
  it("defaults to the saved serving vector and distinguishes measured zero, unknown, partial and trace", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    expect(button("Per 100 g").props["aria-pressed"]).toBe(false);
    expect(text()).toContain("Saved recipe · Saved version 1.");
    expect(text()).toContain(
      "Unsaved recipe edits and the diary logging amount do not change these values.",
    );
    expect(nutritionRows()).toEqual([
      ["Measured zero", "Complete coverage · quantified", "0 g"],
      ["Unknown nutrient", "0/1 contributions quantified", "Unknown"],
      ["Partial nutrient", "Partial · 1/2 contributions quantified", "≥ 74 g"],
      ["Trace nutrient", "Complete coverage · includes trace values", "≥ 0 g"],
    ]);
    const calls = fetcher.mock.calls.length;
    await click("Per 100 g");
    expect(button("Per 100 g").props["aria-pressed"]).toBe(true);
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(false);
    expect(nutritionRows()[2]).toEqual([
      "Partial nutrient",
      "Partial · 1/2 contributions quantified",
      "≥ 123.4 g",
    ]);
    await click("Per serving (bowl)");
    expect(nutritionRows()[2]?.[2]).toBe("≥ 74 g");
    expect(fetcher.mock.calls).toHaveLength(calls);
  });

  it("shows only per 100 g when the saved version has no servings, including after draft serving edits", async () => {
    nutritionFetcher([nutritionRecipe({ serving: false })]);
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(button("Per 100 g").props["aria-pressed"]).toBe(true);
    expect(
      elements().some((node) => node.type === "button" && text(node).startsWith("Per serving")),
    ).toBe(false);
    expect(nutritionRows()[2]?.[2]).toBe("≥ 123.4 g");
    await change("Serving count (optional)", "3");
    await change("Serving label", "plate");
    expect(
      elements().some((node) => node.type === "button" && text(node).startsWith("Per serving")),
    ).toBe(false);
    expect(nutritionRows()[2]?.[2]).toBe("≥ 123.4 g");
  });

  it("keeps the saved name, amounts and serving definition independent of unsaved edits and diary quantity", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const before = nutritionRows();
    const calls = fetcher.mock.calls.length;
    await change("Name", "Unsaved name");
    await change("Final yield grams", "999.000001");
    await change("Rolled oats quantity in grams", "234.000001");
    await change("Serving count (optional)", "");
    await change("Serving label", "plate");
    await change("Portion", "grams");
    await change("Amount", "45.000001");
    expect(nutritionRows()).toEqual(before);
    expect(text()).toContain("Saved recipe · Saved version 1.");
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    await click("Per 100 g");
    expect(field("Name").props.value).toBe("Unsaved name");
    expect(field("Final yield grams").props.value).toBe("999.000001");
    expect(field("Rolled oats quantity in grams").props.value).toBe("234.000001");
    expect(field("Serving count (optional)").props.value).toBe("");
    expect(field("Portion").props.value).toBe("grams");
    expect(field("Amount").props.value).toBe("45.000001");
    expect(fetcher.mock.calls).toHaveLength(calls);
  });

  it("resets on recipe changes and rejects a retained control after returning to the original recipe", async () => {
    nutritionFetcher([
      nutritionRecipe(),
      nutritionRecipe({
        id: "3373a039-2f65-4876-b932-24cffc6b832f",
        name: "Second recipe",
        serving: false,
      }),
    ]);
    await mountReady();
    openSaved();
    await hooks.settle();
    const retained = button("Per 100 g");
    await click("Per 100 g");
    openNamedRecipe("Second recipe");
    await hooks.settle();
    expect(button("Per 100 g").props["aria-pressed"]).toBe(true);
    expect(
      elements().some((node) => node.type === "button" && text(node).startsWith("Per serving")),
    ).toBe(false);
    openSaved();
    await hooks.settle();
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    invoke(retained, "onClick");
    await hooks.settle();
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
  });

  it("resets on a newly opened version and rejects controls retained from its predecessor", async () => {
    const recipes = [nutritionRecipe()];
    nutritionFetcher(recipes);
    await mountReady();
    openSaved();
    await hooks.settle();
    const retained = button("Per 100 g");
    await click("Per 100 g");
    recipes[0] = nutritionRecipe({ version: 2 });
    openSaved();
    await hooks.settle();
    expect(text()).toContain("Saved recipe · Saved version 2.");
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    invoke(retained, "onClick");
    await hooks.settle();
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
  });

  it("preserves the exact pending save across basis changes and resets after publishing a version", async () => {
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    let writes = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        writes += 1;
        return writes === 1
          ? Response.json({ error: "Temporary outage" }, { status: 503 })
          : Response.json({ data: { replayed: true, recipe: nutritionRecipe({ version: 2 }) } });
      }
      return original(url, init);
    });
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Edited recipe");
    await change("Final yield grams", "100.000001");
    save();
    await hooks.settle();
    await click("Per 100 g");
    const retained = button("Per 100 g");
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    const first = required(posts[0]);
    const second = required(posts[1]);
    expect(first[0]).toBe(`/api/recipes/${recipeId}/revisions`);
    expect(second[1]?.body).toBe(first[1]?.body);
    expect(new Headers(second[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(first[1]?.headers).get("if-match")).toBe('"1"');
    expect(JSON.parse(String(first[1]?.body))).toMatchObject({
      name: "Edited recipe",
      finalYield: { grams: "100.000001", source: "measured" },
      servingCount: "2",
      servingLabel: "bowl",
    });
    expect(Object.keys(JSON.parse(String(first[1]?.body)))).toEqual([
      "name",
      "description",
      "instructions",
      "ingredients",
      "finalYield",
      "servingCount",
      "servingLabel",
    ]);
    expect(text()).toContain("Saved recipe · Saved version 2.");
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    invoke(retained, "onClick");
    await hooks.settle();
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
  });

  it("preserves the exact saved-version log payload and retry key across display changes", async () => {
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST"
        ? Response.json({ error: "Temporary outage" }, { status: 503 })
        : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Amount", "2.000001");
    await click("Per 100 g");
    await click("Log recipe");
    await click("Per serving (bowl)");
    await click("Log recipe");
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    const first = required(posts[0]);
    const second = required(posts[1]);
    expect(first[0]).toBe(`/api/recipes/${recipeId}/log?profileTimeZonePrecondition=v1`);
    expect(second[1]?.body).toBe(first[1]?.body);
    expect(new Headers(second[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(first[1]?.headers).get("x-expected-profile-time-zone")).toBe(
      "America/Chicago",
    );
    expect(JSON.parse(String(first[1]?.body))).toMatchObject({
      recipeVersionId: versionId,
      portion: { kind: "serving", amount: "2.000001" },
    });
    const body = JSON.parse(String(first[1]?.body));
    expect(Object.keys(body)).toEqual(["recipeVersionId", "portion", "mealSlot", "occurredAt"]);
    expect(localDateInTimeZone(new Date(body.occurredAt), "America/Chicago")).toBe("2026-09-09");
  });

  it.each(["new", "owner-change", "unmounted"] as const)(
    "rejects retained nutrition controls after %s",
    async (transition) => {
      const fetcher = nutritionFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      const retained = button("Per 100 g");
      if (transition === "new") {
        await click("New recipe");
        openSaved();
        await hooks.settle();
      } else if (transition === "owner-change") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation(async (url, init) =>
          url === "/api/auth/me"
            ? session("a3fd8855-90c8-42df-8f21-2f5a4060fa08")
            : original(url, init),
        );
        openSaved();
        await hooks.settle();
        expect(router.replace).toHaveBeenCalledWith("/login");
        expect(text()).not.toContain("Saved recipe nutrition");
        expect(text()).not.toContain("Measured zero");
      } else hooks.unmount();
      const updates = hooks.afterClose();
      const calls = fetcher.mock.calls.length;
      invoke(retained, "onClick");
      await hooks.settle();
      expect(hooks.afterClose()).toBe(updates);
      expect(fetcher.mock.calls).toHaveLength(calls);
      if (transition === "new")
        expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(true);
    },
  );
});

function copyRecipeFixture() {
  const recipe = nutritionRecipe();
  const publicIngredient = required(recipe.currentVersion.ingredients[0]);
  return {
    ...recipe,
    currentVersion: {
      ...recipe.currentVersion,
      description: "Saved description.",
      instructions: "Keep the saved instructions.",
      finalYield: { grams: "321.000001", source: "estimated", ratioToInputMass: "1" },
      servingCount: "2.000001",
      servingLabel: "small bowl",
      ingredients: [
        {
          ...publicIngredient,
          portion: { kind: "serving", servingId: "303", servingLabel: "scoop", amount: "1.000001" },
          resolvedGrams: "40.125040125",
          note: "Public food note.",
        },
        {
          ...publicIngredient,
          position: 1,
          foodVersionId: "404",
          name: "Private sauce",
          portion: { kind: "grams", grams: "0.000001" },
          resolvedGrams: "0.000001",
          note: "Private food note.",
          source: null,
          foodProvenance: {
            kind: "private_custom",
            customFoodId: "35a0c0cf-e184-40af-811d-ad98ab386f89",
            customFoodVersionNumber: 7,
          },
        },
        {
          kind: "recipe",
          position: 2,
          recipeId: "5f016b07-23ce-4a7f-92b1-bfbfa1cff5e4",
          recipeVersionId: "b23dfba7-218d-449d-bafe-6955e03836b6",
          versionNumber: 3,
          name: "Nested base",
          grams: "10.000001",
          resolvedGrams: "10.000001",
          note: "Nested recipe note.",
        },
      ],
    },
  };
}
function copyFetcher() {
  const source = copyRecipeFixture();
  const fetcher = nutritionFetcher();
  const original = required(fetcher.getMockImplementation());
  fetcher.mockImplementation(async (url, init) => {
    if (url === `/api/recipes/${recipeId}`) return Response.json({ data: { recipe: source } });
    return original(url, init);
  });
  return { fetcher, source };
}
function editorValues() {
  const form = required(elements().find((node) => node.type === "form"));
  return elements(form)
    .filter(
      (node) =>
        ["input", "select", "textarea"].includes(String(node.type)) &&
        node.props.id !== "nested-recipe-filter",
    )
    .map((node) => node.props.value);
}
function hasButton(label: string) {
  return elements().some((node) => node.type === "button" && text(node) === label);
}
const confirmCopyLabel = "Discard edits and copy saved version";

describe("actual saved recipe copy to a new draft", () => {
  it("copies clean saved fields and exact public/private/nested pins without a request, then creates a distinct recipe", async () => {
    const { fetcher, source } = copyFetcher();
    const immutableSource = JSON.stringify(source);
    expect(parseRecipeResponse({ data: { recipe: source } }).ingredients).toHaveLength(3);
    await mountReady();
    openSaved();
    await hooks.settle();
    const savedFields = editorValues();
    const requests = fetcher.mock.calls.length;
    expect(text()).toContain("Copy Saved recipe saved version 1");
    await click("Copy to new draft");
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(editorValues()).toEqual(savedFields);
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(hasButton("Publish new revision")).toBe(false);
    expect(hasButton("Create recipe")).toBe(true);
    expect(hasButton("Log recipe")).toBe(false);
    expect(text()).not.toContain("Saved recipe nutrition");
    expect(review().ownerUserId).toBe(owner);
    expect(text()).toContain("Owner-entered private custom food · pinned version 7");
    await change("Name", "My separate variation");
    const original = required(fetcher.getMockImplementation());
    const newId = "edc36aaf-ad1e-449f-98b3-4c47df1a7bd7";
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST"
        ? Response.json({
            data: {
              replayed: false,
              recipe: {
                ...source,
                id: newId,
                currentVersion: {
                  ...source.currentVersion,
                  name: "My separate variation",
                  id: "b4d5373d-18e2-42d4-87e6-6939980056c7",
                },
              },
            },
          })
        : original(url, init),
    );
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const [url, init] = required(posts[0]);
    expect(url).toBe("/api/recipes");
    expect(new Headers(init?.headers).has("if-match")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "My separate variation",
      description: "Saved description.",
      instructions: "Keep the saved instructions.",
      ingredients: [
        {
          kind: "food",
          foodVersionId: "202",
          portion: { kind: "serving", servingId: "303", amount: "1.000001" },
          position: 0,
          note: "Public food note.",
        },
        {
          kind: "food",
          foodVersionId: "404",
          portion: { kind: "grams", grams: "0.000001" },
          position: 1,
          note: "Private food note.",
        },
        {
          kind: "recipe",
          recipeVersionId: "b23dfba7-218d-449d-bafe-6955e03836b6",
          grams: "10.000001",
          position: 2,
          note: "Nested recipe note.",
        },
      ],
      finalYield: { grams: "321.000001", source: "estimated" },
      servingCount: "2.000001",
      servingLabel: "small bowl",
    });
    expect(JSON.stringify(source)).toBe(immutableSource);
    expect(text()).toContain("My separate variation · Saved version 1.");
  });

  it("keeps every unsaved field on cancellation and explicitly discards to saved values on confirmation", async () => {
    const { fetcher } = copyFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const saved = editorValues();
    await change("Name", " Unsaved name ");
    await change("Description", "Unsaved description.");
    await change("Instructions (optional)", "Unsaved instructions.");
    await change("Final yield grams", "999.000001");
    await change("Yield source", "measured");
    await change("Serving count (optional)", "4.000001");
    await change("Serving label", "plate");
    await change("Private sauce quantity in grams", "7.000001");
    await change("Private sauce note", "Unsaved note.");
    const dirty = editorValues();
    const requests = fetcher.mock.calls.length;
    await click("Copy to new draft");
    expect(hasButton(confirmCopyLabel)).toBe(true);
    expect(editorValues()).toEqual(dirty);
    await click("Keep editing");
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(editorValues()).toEqual(dirty);
    await click("Copy to new draft");
    await click(confirmCopyLabel);
    expect(editorValues()).toEqual(saved);
    expect(hasButton("Create recipe")).toBe(true);
    expect(hasButton("Log recipe")).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("copies immediately when re-adding an identical pinned ingredient restores every editable field", async () => {
    nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await click("Remove");
    await change("Find a reviewed food", "oats");
    await click("Search");
    await click("Add 100 g");
    await change("Rolled oats quantity in grams", "120");
    await click("Copy to new draft");
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(hasButton("Create recipe")).toBe(true);
    expect(field("Rolled oats quantity in grams").props.value).toBe("120");
  });

  it("requires the discard choice even for whitespace-only unsaved edits", async () => {
    nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Saved recipe ");
    await click("Copy to new draft");
    expect(hasButton(confirmCopyLabel)).toBe(true);
    expect(field("Name").props.value).toBe("Saved recipe ");
  });

  it("cancels confirmation on further edits and ignores retained confirm and cancel controls for a later prompt", async () => {
    nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "First edit");
    await click("Copy to new draft");
    const oldConfirm = button(confirmCopyLabel);
    const oldCancel = button("Keep editing");
    invoke(field("Name"), "onChange", { target: { value: "Later edit" } });
    invoke(oldConfirm, "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe("Later edit");
    expect(hasButton("Publish new revision")).toBe(true);
    expect(hasButton(confirmCopyLabel)).toBe(false);
    await click("Copy to new draft");
    invoke(oldCancel, "onClick");
    invoke(oldConfirm, "onClick");
    await hooks.settle();
    expect(hasButton(confirmCopyLabel)).toBe(true);
    expect(field("Name").props.value).toBe("Later edit");
    await click(confirmCopyLabel);
    expect(field("Name").props.value).toBe("Saved recipe");
  });

  it("rejects retained original editor, submit, log, copy, New and open controls after copying", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const name = field("Name");
    const quantity = field("Rolled oats quantity in grams");
    const form = required(elements().find((node) => node.type === "form"));
    const log = button("Log recipe");
    const copy = button("Copy to new draft");
    const newRecipe = button("New recipe");
    const open = required(
      elements().find((node) => node.type === "button" && text(node).startsWith("Saved recipe")),
    );
    const remove = button("Remove");
    const requests = fetcher.mock.calls.length;
    await click("Copy to new draft");
    const copied = editorValues();
    invoke(name, "onChange", { target: { value: "Stale original" } });
    invoke(quantity, "onChange", { target: { value: "999" } });
    invoke(remove, "onClick");
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(log, "onClick");
    invoke(copy, "onClick");
    invoke(newRecipe, "onClick");
    invoke(open, "onClick");
    await hooks.settle();
    expect(editorValues()).toEqual(copied);
    expect(hasButton("Create recipe")).toBe(true);
    expect(hasButton("Log recipe")).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("rejects original logging field callbacks after copying and reopening a saved selection", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const portion = field("Portion");
    const amount = field("Amount");
    const date = field("Local diary date");
    const meal = field("Meal");
    const originalMeal = meal.props.value;
    const differentMeal = originalMeal === "meal_1" ? "meal_2" : "meal_1";
    await click("Copy to new draft");
    const requests = fetcher.mock.calls.length;
    const retainedChanges = () => {
      invoke(portion, "onChange", { target: { value: "grams" } });
      invoke(amount, "onChange", { target: { value: "999.000001" } });
      invoke(date, "onChange", { target: { value: "2026-09-01" } });
      invoke(meal, "onChange", { target: { value: differentMeal } });
    };
    retainedChanges();
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(requests);
    openSaved();
    await hooks.settle();
    await click(confirmOpenLabel);
    retainedChanges();
    await hooks.settle();
    expect(field("Portion").props.value).toBe("serving");
    expect(field("Amount").props.value).toBe("1");
    expect(field("Local diary date").props.value).toBe("2026-09-09");
    expect(field("Meal").props.value).toBe(originalMeal);
  });

  it("starts a different creation intent for each copied draft while retaining retries within one draft", async () => {
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST"
        ? Response.json({ error: "Ambiguous create outage" }, { status: 503 })
        : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await click("Copy to new draft");
    save();
    await hooks.settle();
    save();
    await hooks.settle();
    openSaved();
    await hooks.settle();
    await click(confirmOpenLabel);
    await click("Copy to new draft");
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(3);
    const first = required(posts[0]);
    const retry = required(posts[1]);
    const next = required(posts[2]);
    expect(first[0]).toBe("/api/recipes");
    expect(next[0]).toBe("/api/recipes");
    expect(first[1]?.body).toBe(retry[1]?.body);
    expect(first[1]?.body).toBe(next[1]?.body);
    const firstKey = new Headers(first[1]?.headers).get("idempotency-key");
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(firstKey);
    expect(new Headers(next[1]?.headers).get("idempotency-key")).not.toBe(firstKey);
    expect(new Headers(next[1]?.headers).has("if-match")).toBe(false);
  });

  it.each(["save", "log"] as const)("blocks copying during an active %s", async (action) => {
    const pending = deferred<Response>();
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST" ? pending.promise : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    const retained = button("Copy to new draft");
    if (action === "save") save();
    else invoke(button("Log recipe"), "onClick");
    await hooks.settle();
    expect(button("Copy to new draft").props.disabled).toBe(true);
    invoke(retained, "onClick");
    await hooks.settle();
    expect(hasButton("Create recipe")).toBe(false);
    expect(text()).toContain("Saved recipe nutrition");
    pending.resolve(Response.json({ error: "Retryable failure" }, { status: 503 }));
    await hooks.settle();
    expect(button("Copy to new draft").props.disabled).toBe(false);
  });

  it("invalidates an inline discard confirmation when saving starts, even after a failed save", async () => {
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST"
        ? Response.json({ error: "Outage" }, { status: 503 })
        : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Unsaved revision");
    await click("Copy to new draft");
    const retained = button(confirmCopyLabel);
    save();
    invoke(retained, "onClick");
    await hooks.settle();
    invoke(retained, "onClick");
    await hooks.settle();
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(hasButton("Publish new revision")).toBe(true);
    expect(field("Name").props.value).toBe("Unsaved revision");
  });

  it.each(["new", "open", "owner-change", "unmounted"] as const)(
    "invalidates dirty copy confirmation after %s",
    async (transition) => {
      const fetcher = nutritionFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Name", "Unsaved revision");
      await click("Copy to new draft");
      const retained = button(confirmCopyLabel);
      if (transition === "new") await click("New recipe");
      if (transition === "open") {
        openSaved();
        await hooks.settle();
      }
      if (transition === "owner-change") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation(async (url, init) =>
          url === "/api/auth/me"
            ? session("a3fd8855-90c8-42df-8f21-2f5a4060fa08")
            : original(url, init),
        );
        openSaved();
        await hooks.settle();
        await click(confirmOpenLabel);
        expect(router.replace).toHaveBeenCalledWith("/login");
      }
      if (transition === "unmounted") hooks.unmount();
      const updates = hooks.afterClose();
      const requests = fetcher.mock.calls.length;
      const before = editorValues();
      invoke(retained, "onClick");
      await hooks.settle();
      expect(editorValues()).toEqual(before);
      expect(hooks.afterClose()).toBe(updates);
      expect(fetcher.mock.calls).toHaveLength(requests);
      if (transition !== "unmounted") expect(hasButton(confirmCopyLabel)).toBe(false);
    },
  );

  it("clears search/review context and ignores an old search response after copying", async () => {
    const pending = deferred<Response>();
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      url.startsWith("/api/foods/search?") ? pending.promise : original(url, init),
    );
    await mountReady();
    const oldReview = review();
    openSaved();
    await hooks.settle();
    await change("Find a reviewed food", "Original search");
    invoke(button("Search"), "onClick");
    await hooks.settle();
    await click("Copy to new draft");
    expect(field("Find a reviewed food").props.value).toBe("");
    expect(review().onConfirm([ingredient("stale-review")])).toBe(true);
    await hooks.settle();
    expect(oldReview.onConfirm([ingredient("old-review")])).toBe(false);
    pending.resolve(searchResponse());
    await hooks.settle();
    expect(field("Find a reviewed food").props.value).toBe("");
    expect(hasButton("Search")).toBe(true);
    expect(
      elements()
        .filter((node) => node.props.className === "ingredientResult")
        .some((node) => text(node).includes("Rolled oats")),
    ).toBe(false);
  });

  it("blocks New, Open and Copy during a pending revision, then permits an explicit replacement after failure", async () => {
    const pending = deferred<Response>();
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST" ? pending.promise : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Original pending revision");
    const replace = [button("New recipe"), savedOpener(), button("Copy to new draft")];
    save();
    await hooks.settle();
    const requests = fetcher.mock.calls.length,
      before = editorValues();
    for (const control of replace) invoke(control, "onClick");
    await hooks.settle();
    expect(editorValues()).toEqual(before);
    expect(fetcher.mock.calls).toHaveLength(requests);
    pending.resolve(Response.json({ error: "Ambiguous original revision" }, { status: 503 }));
    await hooks.settle();
    expect(editorValues()).toEqual(before);
    await click("New recipe");
    await click(confirmNewLabel);
    openSaved();
    await hooks.settle();
    await click("Copy to new draft");
    await change("Name", "Independent copied draft");
    expect(field("Name").props.value).toBe("Independent copied draft");
    expect(hasButton("Create recipe")).toBe(true);
  });
});

function ingredientRows() {
  return elements().filter((node) => node.props.className === "ingredientRow");
}
function ingredientControl(index: number, action: "quantity" | "note" | "remove" | "up" | "down") {
  const row = required(ingredientRows()[index]);
  return required(
    elements(row).find((node) => {
      const label = String(node.props["aria-label"] ?? "");
      if (action === "quantity") return node.type === "input" && label.includes("quantity in");
      if (action === "note") return node.type === "input" && label.endsWith(" note");
      return (
        node.type === "button" && text(node) === (action === "remove" ? "Remove" : `Move ${action}`)
      );
    }),
  );
}
function ingredientValues() {
  return ingredientRows().map((row, index) => ({
    name: text(required(elements(row).find((node) => node.type === "strong"))),
    quantity: ingredientControl(index, "quantity").props.value,
    note: ingredientControl(index, "note").props.value,
  }));
}
async function moveRow(index: number, direction: "up" | "down") {
  const control = ingredientControl(index, direction);
  expect(control.props.disabled).toBe(false);
  invoke(control, "onClick");
  await hooks.settle();
}
async function changeIngredient(index: number, field: "quantity" | "note", value: string) {
  invoke(ingredientControl(index, field), "onChange", { target: { value } });
  await hooks.settle();
}

describe("actual recipe draft ingredient ordering", () => {
  it("has no moves for an empty draft and disables both boundaries for a single ingredient", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    expect(ingredientRows()).toHaveLength(0);
    review().onConfirm([ingredient("only", "0.000001")]);
    await hooks.settle();
    const before = ingredientValues();
    const requests = fetcher.mock.calls.length;
    expect(ingredientControl(0, "up").props.disabled).toBe(true);
    expect(ingredientControl(0, "down").props.disabled).toBe(true);
    expect(ingredientControl(0, "up").props["aria-label"]).toBe(
      "Move Rolled oats up from position 1 of 1",
    );
    invoke(ingredientControl(0, "up"), "onClick");
    invoke(ingredientControl(0, "down"), "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual(before);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("moves locally while preserving exact public/private/nested data, saved nutrition and all recipe fields", async () => {
    const { fetcher, source } = copyFetcher();
    const immutableSource = JSON.stringify(source);
    await mountReady();
    openSaved();
    await hooks.settle();
    const before = ingredientValues();
    const nutrition = nutritionRows();
    const requests = fetcher.mock.calls.length;
    expect(ingredientControl(0, "up").props.disabled).toBe(true);
    expect(ingredientControl(2, "down").props.disabled).toBe(true);
    invoke(ingredientControl(0, "up"), "onClick");
    invoke(ingredientControl(2, "down"), "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual(before);
    await moveRow(1, "up");
    expect(ingredientValues()).toEqual([before[1], before[0], before[2]]);
    expect(nutritionRows()).toEqual(nutrition);
    expect(field("Name").props.value).toBe("Saved recipe");
    expect(field("Description").props.value).toBe("Saved description.");
    expect(field("Instructions (optional)").props.value).toBe("Keep the saved instructions.");
    expect(field("Final yield grams").props.value).toBe("321.000001");
    expect(field("Yield source").props.value).toBe("estimated");
    expect(field("Serving count (optional)").props.value).toBe("2.000001");
    expect(field("Serving label").props.value).toBe("small bowl");
    expect(field("Portion").props.value).toBe("serving");
    expect(field("Amount").props.value).toBe("1");
    expect(text(ingredientRows()[0])).toContain(
      "Owner-entered private custom food · pinned version 7",
    );
    expect(text(ingredientRows()[1])).toContain("Data source: USDA FoodData Central · CC0-1.0");
    expect(text(ingredientRows()[2])).toContain("b23dfba7-218d-449d-bafe-6955e03836b6");
    expect(ingredientControl(0, "down").props["aria-label"]).toBe(
      "Move Private sauce down from position 1 of 3",
    );
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(source)).toBe(immutableSource);
  });

  it.each(["create", "revision"] as const)(
    "sends final contiguous positions with exact pins and quantities on explicit %s",
    async (kind) => {
      const { fetcher } = copyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        init?.method === "POST"
          ? Response.json({ error: "Inspect failed save" }, { status: 503 })
          : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      if (kind === "create") await click("Copy to new draft");
      const requests = fetcher.mock.calls.length;
      await moveRow(2, "up");
      await moveRow(1, "up");
      expect(fetcher.mock.calls).toHaveLength(requests);
      save();
      await hooks.settle();
      const [url, init] = required(
        fetcher.mock.calls.find(([, candidate]) => candidate?.method === "POST"),
      );
      expect(url).toBe(kind === "create" ? "/api/recipes" : `/api/recipes/${recipeId}/revisions`);
      expect(new Headers(init?.headers).get("if-match")).toBe(kind === "create" ? null : '"1"');
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Saved recipe",
        description: "Saved description.",
        instructions: "Keep the saved instructions.",
        ingredients: [
          {
            kind: "recipe",
            recipeVersionId: "b23dfba7-218d-449d-bafe-6955e03836b6",
            grams: "10.000001",
            position: 0,
            note: "Nested recipe note.",
          },
          {
            kind: "food",
            foodVersionId: "202",
            portion: { kind: "serving", servingId: "303", amount: "1.000001" },
            position: 1,
            note: "Public food note.",
          },
          {
            kind: "food",
            foodVersionId: "404",
            portion: { kind: "grams", grams: "0.000001" },
            position: 2,
            note: "Private food note.",
          },
        ],
        finalYield: { grams: "321.000001", source: "estimated" },
        servingCount: "2.000001",
        servingLabel: "small bowl",
      });
    },
  );

  it("keeps duplicate food/version rows distinct through movement, editing and removal", async () => {
    nutritionFetcher();
    await mountReady();
    review().onConfirm([
      ingredient("duplicate-a", "1.000001"),
      ingredient("duplicate-b", "2.000001"),
      ingredient("duplicate-c", "3.000001"),
    ]);
    await hooks.settle();
    await changeIngredient(0, "note", "First exact pin");
    await changeIngredient(1, "note", "Second exact pin");
    await changeIngredient(2, "note", "Third exact pin");
    await moveRow(1, "up");
    expect(ingredientValues().map((row) => [row.quantity, row.note])).toEqual([
      ["2.000001", "Second exact pin"],
      ["1.000001", "First exact pin"],
      ["3.000001", "Third exact pin"],
    ]);
    await changeIngredient(1, "quantity", "9.000001");
    await changeIngredient(1, "note", "Edited first exact pin");
    invoke(ingredientControl(0, "remove"), "onClick");
    await hooks.settle();
    expect(ingredientValues().map((row) => [row.quantity, row.note])).toEqual([
      ["9.000001", "Edited first exact pin"],
      ["3.000001", "Third exact pin"],
    ]);
  });

  it("rejects prior-order move, quantity, note, remove and general field callbacks even after restoring the original order", async () => {
    copyFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const oldMove = ingredientControl(0, "down");
    const oldQuantity = ingredientControl(0, "quantity");
    const oldNote = ingredientControl(0, "note");
    const oldRemove = ingredientControl(0, "remove");
    const oldName = field("Name");
    const invokeOld = () => {
      invoke(oldMove, "onClick");
      invoke(oldQuantity, "onChange", { target: { value: "999" } });
      invoke(oldNote, "onChange", { target: { value: "Stale note" } });
      invoke(oldRemove, "onClick");
      invoke(oldName, "onChange", { target: { value: "Stale name" } });
    };
    await moveRow(0, "down");
    const moved = ingredientValues();
    invokeOld();
    await hooks.settle();
    expect(ingredientValues()).toEqual(moved);
    expect(field("Name").props.value).toBe("Saved recipe");
    await moveRow(1, "up");
    const restored = ingredientValues();
    invokeOld();
    await hooks.settle();
    expect(ingredientValues()).toEqual(restored);
    expect(field("Name").props.value).toBe("Saved recipe");
  });

  it("rejects a retained move after a later quantity edit without losing that edit", async () => {
    copyFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    const retained = ingredientControl(0, "down");
    await changeIngredient(0, "quantity", "7.000001");
    invoke(retained, "onClick");
    await hooks.settle();
    expect(ingredientValues()[0]).toEqual({
      name: "Rolled oats",
      quantity: "7.000001",
      note: "Public food note.",
    });
  });

  it("marks reordered recipes dirty, invalidates an earlier discard choice, and is clean when the original order is restored", async () => {
    copyFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await moveRow(0, "down");
    await click("Copy to new draft");
    expect(hasButton(confirmCopyLabel)).toBe(true);
    const retained = button(confirmCopyLabel);
    await moveRow(1, "up");
    invoke(retained, "onClick");
    await hooks.settle();
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(hasButton("Publish new revision")).toBe(true);
    await click("Copy to new draft");
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(hasButton("Create recipe")).toBe(true);
    expect(ingredientValues().map((row) => row.name)).toEqual([
      "Rolled oats",
      "Private sauce",
      "Nested base",
    ]);
  });

  it.each(["create", "revision"] as const)(
    "uses a new intent for changed %s order and retains exact body/key retries of that order",
    async (kind) => {
      const { fetcher } = copyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        init?.method === "POST"
          ? Response.json({ error: "Retryable save failure" }, { status: 503 })
          : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      if (kind === "create") await click("Copy to new draft");
      await moveRow(0, "down");
      save();
      await hooks.settle();
      await moveRow(2, "up");
      save();
      await hooks.settle();
      save();
      await hooks.settle();
      const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(3);
      const first = required(posts[0]);
      const changed = required(posts[1]);
      const retry = required(posts[2]);
      expect(first[1]?.body).not.toBe(changed[1]?.body);
      expect(changed[1]?.body).toBe(retry[1]?.body);
      const changedKey = new Headers(changed[1]?.headers).get("idempotency-key");
      expect(new Headers(first[1]?.headers).get("idempotency-key")).not.toBe(changedKey);
      expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(changedKey);
      expect(new Headers(retry[1]?.headers).get("if-match")).toBe(kind === "create" ? null : '"1"');
      expect(
        JSON.parse(String(retry[1]?.body)).ingredients.map(
          (row: { position: number }) => row.position,
        ),
      ).toEqual([0, 1, 2]);
      expect(ingredientValues().map((row) => row.name)).toEqual([
        "Private sauce",
        "Nested base",
        "Rolled oats",
      ]);
    },
  );

  it.each(["save", "log"] as const)(
    "disables and rejects retained ingredient actions during active %s",
    async (action) => {
      const pending = deferred<Response>();
      const { fetcher } = copyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        init?.method === "POST" ? pending.promise : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      const retainedMove = ingredientControl(0, "down");
      const retainedQuantity = ingredientControl(0, "quantity");
      const retainedNote = ingredientControl(0, "note");
      const retainedRemove = ingredientControl(0, "remove");
      const before = ingredientValues();
      if (action === "save") save();
      else invoke(button("Log recipe"), "onClick");
      await hooks.settle();
      expect(ingredientControl(0, "down").props.disabled).toBe(true);
      expect(ingredientControl(0, "remove").props.disabled).toBe(true);
      invoke(retainedMove, "onClick");
      invoke(retainedQuantity, "onChange", { target: { value: "888" } });
      invoke(retainedNote, "onChange", { target: { value: "Busy note" } });
      invoke(retainedRemove, "onClick");
      await hooks.settle();
      expect(ingredientValues()).toEqual(before);
      pending.resolve(Response.json({ error: "Retryable failure" }, { status: 503 }));
      await hooks.settle();
      expect(ingredientControl(0, "down").props.disabled).toBe(false);
    },
  );

  it.each(["new", "open", "copy", "owner-change", "unmounted", "effect-replay"] as const)(
    "rejects retained ingredient actions after %s",
    async (transition) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      const retainedMove = ingredientControl(0, "down");
      const retainedQuantity = ingredientControl(0, "quantity");
      const retainedNote = ingredientControl(0, "note");
      const retainedRemove = ingredientControl(0, "remove");
      if (transition === "new") await click("New recipe");
      if (transition === "copy") await click("Copy to new draft");
      if (transition === "open") {
        openSaved();
        await hooks.settle();
      }
      if (transition === "owner-change") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation(async (url, init) =>
          url === "/api/auth/me"
            ? session("a3fd8855-90c8-42df-8f21-2f5a4060fa08")
            : original(url, init),
        );
        openSaved();
        await hooks.settle();
        expect(router.replace).toHaveBeenCalledWith("/login");
      }
      if (transition === "unmounted") hooks.unmount();
      if (transition === "effect-replay") {
        hooks.replayEffects();
        await hooks.settle();
      }
      const before = ingredientValues();
      const requests = fetcher.mock.calls.length;
      const updates = hooks.afterClose();
      invoke(retainedMove, "onClick");
      invoke(retainedQuantity, "onChange", { target: { value: "999" } });
      invoke(retainedNote, "onChange", { target: { value: "Stale note" } });
      invoke(retainedRemove, "onClick");
      await hooks.settle();
      expect(ingredientValues()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(requests);
      expect(hooks.afterClose()).toBe(updates);
    },
  );
});

const savedFilterLabel = "Filter loaded saved recipes by name";
function savedRecipeRows() {
  const list = required(elements().find((node) => node.props.className === "recipeList"));
  return elements(list).filter((node) => node.type === "button");
}
function savedRecipeNames() {
  return savedRecipeRows().map((row) =>
    text(required(elements(row).find((node) => node.type === "strong"))),
  );
}
function savedFilterStatus() {
  return text(required(elements().find((node) => node.props.id === "saved-recipe-filter-status")));
}
async function filterCollection(
  values: readonly ReturnType<typeof nutritionRecipe>[],
  nextCursor: string | null = null,
) {
  const payload = await nutritionCollection(values).json();
  return Response.json({ ...payload, page: { nextCursor } });
}
const secondRecipeId = "359c280c-5662-40b4-8a10-b70bb0c7a9d0";
const thirdRecipeId = "491a5573-0ae6-4c17-98b9-fbd28b84fcbe";

describe("actual loaded saved-recipe name filtering", () => {
  it("matches literal trimmed lowercase names, preserves duplicate IDs/order, and makes no search request", async () => {
    const recipes = [
      nutritionRecipe({ name: "Chili [HOT]" }),
      nutritionRecipe({ id: secondRecipeId, name: "Café Soup" }),
      nutritionRecipe({ id: thirdRecipeId, name: "Chili [HOT]" }),
    ];
    const fetcher = nutritionFetcher(recipes);
    await mountReady();
    const reads = fetcher.mock.calls.length;
    expect(savedRecipeNames()).toEqual(["Chili [HOT]", "Café Soup", "Chili [HOT]"]);
    expect(savedFilterStatus()).toContain("3 of 3 loaded recipes match.");
    await change(savedFilterLabel, "  cHiLi  ");
    expect(field(savedFilterLabel).props.value).toBe("  cHiLi  ");
    expect(savedRecipeNames()).toEqual(["Chili [HOT]", "Chili [HOT]"]);
    expect(savedFilterStatus()).toContain("2 of 3 loaded recipes match.");
    await change(savedFilterLabel, "[hOt]");
    expect(savedRecipeNames()).toEqual(["Chili [HOT]", "Chili [HOT]"]);
    await change(savedFilterLabel, ".*");
    expect(savedRecipeNames()).toEqual([]);
    await change(savedFilterLabel, "cafe");
    expect(savedRecipeNames()).toEqual([]);
    await change(savedFilterLabel, "CAFÉ");
    expect(savedRecipeNames()).toEqual(["Café Soup"]);
    await change(savedFilterLabel, " \t ");
    expect(savedRecipeNames()).toEqual(recipes.map((recipe) => recipe.currentVersion.name));
    await click("Clear filter");
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(button("Clear filter").props.type).toBe("button");
    expect(fetcher.mock.calls).toHaveLength(reads);
    invoke(required(savedRecipeRows()[2]), "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls.some(([url]) => url === `/api/recipes/${thirdRecipeId}`)).toBe(true);
    expect(savedFilterStatus()).toContain("3 of 3 loaded recipes match.");
    expect(text()).toContain("Version 1 loaded.");
  });

  it("bounds raw input and rejects stale field/Clear callbacks without stranding same-value actions", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    const calls = fetcher.mock.calls.length;
    expect(field(savedFilterLabel).props.maxLength).toBe(200);
    await change(savedFilterLabel, "x".repeat(230));
    expect(field(savedFilterLabel).props.value).toBe("x".repeat(200));
    await change(savedFilterLabel, "Saved");
    const staleField = field(savedFilterLabel),
      staleClear = button("Clear filter");
    invoke(staleField, "onChange", { target: { value: "No match" } });
    invoke(staleClear, "onClick");
    invoke(staleField, "onChange", { target: { value: "Older input" } });
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("No match");
    await click("Clear filter");
    const empty = button("Clear filter");
    invoke(empty, "onClick");
    invoke(empty, "onClick");
    await change(savedFilterLabel, "Saved");
    invoke(staleClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("Saved");
    const sameField = field(savedFilterLabel),
      currentClear = button("Clear filter");
    invoke(sameField, "onChange", { target: { value: "Saved" } });
    invoke(sameField, "onChange", { target: { value: "Saved" } });
    invoke(currentClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(savedRecipeNames()).toEqual(["Saved recipe"]);
    expect(fetcher.mock.calls).toHaveLength(calls);
  });

  it.each(["session", "list"] as const)(
    "does not claim an empty complete library before an initial %s failure",
    async (failure) => {
      const response = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/auth/me") return failure === "session" ? response.promise : session();
          return response.promise;
        }),
      );
      hooks.mount(RecipesClient);
      await hooks.settle();
      expect(savedRecipeNames()).toEqual([]);
      expect(savedFilterStatus()).toBe("Saved recipes have not been loaded yet.");
      expect(savedFilterStatus()).not.toContain("All saved recipes");
      response.resolve(Response.json({ error: "Unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(savedFilterStatus()).toBe("Saved recipes have not been loaded yet.");
      expect(hasButton("Load more recipes")).toBe(false);
      expect(hasButton(failure === "session" ? "Retry session" : "Retry recipes")).toBe(true);
    },
  );

  it.each([null, "next-page"])(
    "distinguishes a verified empty first page with cursor %s",
    async (cursor) => {
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        url.startsWith("/api/recipes?") ? filterCollection([], cursor) : original(url, init),
      );
      await mountReady();
      expect(savedFilterStatus()).toContain("0 of 0 loaded recipes match.");
      expect(savedFilterStatus()).toContain(
        cursor ? "More recipes may be available." : "All saved recipes are loaded.",
      );
      expect(hasButton("Load more recipes")).toBe(cursor !== null);
      if (cursor) {
        expect(text()).not.toContain("No recipes yet.");
        expect(text()).toContain("0 recipes loaded; more available.");
      } else expect(text()).toContain("No recipes yet.");
      await change(savedFilterLabel, "Soup");
      expect(savedFilterStatus()).toContain("No loaded recipes match this name.");
    },
  );

  it("keeps zero-match paging/recovery available, merges overlap in order and retains accumulated counts at the empty terminal page", async () => {
    const first = nutritionRecipe({ name: "First" });
    const updated = nutritionRecipe({ name: "First updated", version: 2 });
    const next = nutritionRecipe({ id: secondRecipeId, name: "Later soup" });
    const pendingPage = deferred<Response>();
    let secondCalls = 0;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(url);
        if (url === "/api/auth/me") return session();
        if (url.includes("cursor=page-two")) {
          secondCalls += 1;
          return secondCalls === 1
            ? pendingPage.promise
            : filterCollection([updated, next], "page-three");
        }
        if (url.includes("cursor=page-three")) return filterCollection([]);
        return filterCollection([first], "page-two");
      }),
    );
    await mountReady();
    await change(savedFilterLabel, "soup");
    expect(savedRecipeNames()).toEqual([]);
    expect(savedFilterStatus()).toContain("0 of 1 loaded recipes match.");
    await click("Load more recipes");
    expect(button("Loading…").props.disabled).toBe(true);
    const requestCount = requests.length;
    await change(savedFilterLabel, "  SOUP ");
    expect(requests).toHaveLength(requestCount);
    pendingPage.resolve(Response.json({ error: "Page unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(savedFilterStatus()).toContain("More recipes may be available.");
    expect(hasButton("Retry recipes")).toBe(true);
    expect(button("Load more recipes").props.disabled).toBe(false);
    await click("Load more recipes");
    expect(field(savedFilterLabel).props.value).toBe("  SOUP ");
    expect(savedRecipeNames()).toEqual(["Later soup"]);
    expect(savedFilterStatus()).toContain("1 of 2 loaded recipes match.");
    await click("Load more recipes");
    expect(savedRecipeNames()).toEqual(["Later soup"]);
    expect(savedFilterStatus()).toContain("1 of 2 loaded recipes match.");
    expect(savedFilterStatus()).toContain("All saved recipes are loaded.");
    expect(text()).not.toContain("No recipes yet.");
    expect(hasButton("Load more recipes")).toBe(false);
    await click("Clear filter");
    expect(savedRecipeNames()).toEqual(["First updated", "Later soup"]);
    expect(requests.filter((url) => url.includes("cursor=page-two"))).toHaveLength(2);
  });

  it("preserves the selected editor, copy decision, nutrition/log fields and nested choices when filtering out the selection", async () => {
    const { fetcher } = copyFetcher();
    const other = nutritionRecipe({ id: secondRecipeId, name: "Other nested choice" });
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url.startsWith("/api/recipes?")
        ? filterCollection([nutritionRecipe(), other])
        : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", " Unsaved draft ");
    await change("Description", "Keep my draft description.");
    await change("Final yield grams", "777.000001");
    await change("Private sauce note", "Keep this note.");
    await change("Find a reviewed food", "independent food search");
    await change("Portion", "grams");
    await change("Amount", "12.000001");
    await change("Local diary date", "2026-09-08");
    await change("Meal", "dinner");
    await click("Per 100 g");
    await click("Copy to new draft");
    const retainedDecision = button("Keep editing");
    const snapshot = editorValues(),
      nutrition = nutritionRows();
    const log = ["Portion", "Amount", "Local diary date", "Meal"].map(
      (label) => field(label).props.value,
    );
    const nested = elements()
      .filter((node) => node.props.className === "ingredientResult")
      .map((node) => text(node));
    const message = text(
      required(elements().find((node) => node.props.className === "workspaceStatus")),
    );
    const requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "no matching saved name");
    await change(nestedFilterLabel, "no matching nested name");
    expect(nestedRecipeNames()).toEqual([]);
    expect(savedRecipeNames()).toEqual([]);
    expect(editorValues()).toEqual(snapshot);
    expect(hasButton(confirmCopyLabel)).toBe(true);
    await click(clearNestedLabel);
    expect(editorValues()).toEqual(snapshot);
    expect(nutritionRows()).toEqual(nutrition);
    expect(button("Per 100 g").props["aria-pressed"]).toBe(true);
    expect(
      ["Portion", "Amount", "Local diary date", "Meal"].map((label) => field(label).props.value),
    ).toEqual(log);
    expect(
      elements()
        .filter((node) => node.props.className === "ingredientResult")
        .map((node) => text(node)),
    ).toEqual(nested);
    expect(nested.some((name) => name.includes("Other nested choice"))).toBe(true);
    expect(hasButton(confirmCopyLabel)).toBe(true);
    expect(
      text(required(elements().find((node) => node.props.className === "workspaceStatus"))),
    ).toBe(message);
    await click("Clear filter");
    expect(savedRecipeRows()[0]?.props["aria-current"]).toBe(true);
    invoke(retainedDecision, "onClick");
    await hooks.settle();
    expect(hasButton(confirmCopyLabel)).toBe(false);
    expect(editorValues()).toEqual(snapshot);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("preserves the pasted-review child identity and retained confirmation while filtering a new draft", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    await change("Name", "Reviewed draft");
    await change("Final yield grams", "250.000001");
    const child = required(
      elements().find((node) => node.type === PastedIngredientReview),
    ) as ElementNode & { key: unknown };
    const retained = review();
    const requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "not loaded");
    await change(nestedFilterLabel, "separate nested query");
    const currentChild = required(
      elements().find((node) => node.type === PastedIngredientReview),
    ) as ElementNode & { key: unknown };
    expect(currentChild.key).toBe(child.key);
    expect(review().ownerUserId).toBe(retained.ownerUserId);
    expect(review().remainingCapacity).toBe(retained.remainingCapacity);
    expect(retained.onConfirm([ingredient("review-before-filter", "0.000001")])).toBe(true);
    await hooks.settle();
    expect(field("Name").props.value).toBe("Reviewed draft");
    expect(field("Final yield grams").props.value).toBe("250.000001");
    expect(ingredientValues()[0]?.quantity).toBe("0.000001");
    expect(field(savedFilterLabel).props.value).toBe("not loaded");
    expect(fetcher.mock.calls).toHaveLength(requests);
    await click("New recipe");
    expect(field("Name").props.value).toBe("Reviewed draft");
    await click(confirmNewLabel);
    expect(field(savedFilterLabel).props.value).toBe("not loaded");
  });

  it.each(["save", "log"] as const)(
    "keeps exact %s retry identity through filtering during the request and after failure",
    async (action) => {
      const fetcher = nutritionFetcher();
      const original = required(fetcher.getMockImplementation());
      const pending = deferred<Response>();
      let posts = 0;
      fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "POST") {
          posts += 1;
          if (posts === 1) return pending.promise;
          return action === "save"
            ? Response.json({ data: { replayed: true, recipe: nutritionRecipe({ version: 2 }) } })
            : Response.json({ error: "Temporary outage" }, { status: 503 });
        }
        return original(url, init);
      });
      await mountReady();
      openSaved();
      await hooks.settle();
      if (action === "save") await change("Name", "Revised recipe");
      else {
        await change("Amount", "2.000001");
        await change("Meal", "lunch");
      }
      await change(nestedFilterLabel, "Independent nested query");
      const oldNestedField = field(nestedFilterLabel);
      if (action === "save") {
        save();
        await hooks.settle();
      } else await click("Log recipe");
      const count = fetcher.mock.calls.length;
      expect(field(nestedFilterLabel).props.disabled).toBe(true);
      expect(button(clearNestedLabel).props.disabled).toBe(true);
      invoke(oldNestedField, "onChange", { target: { value: "Busy replacement" } });
      expect(field(nestedFilterLabel).props.value).toBe("Independent nested query");
      await change(savedFilterLabel, "No match");
      await click("Clear filter");
      expect(fetcher.mock.calls).toHaveLength(count);
      pending.resolve(Response.json({ error: "Confirmation lost." }, { status: 503 }));
      await hooks.settle();
      await change(savedFilterLabel, "sAvEd");
      await change(nestedFilterLabel, "Saved");
      await click(clearNestedLabel);
      if (action === "save") {
        save();
        await hooks.settle();
      } else await click("Log recipe");
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.[0]).toBe(writes[0]?.[0]);
      expect(writes[1]?.[1]?.body).toBe(writes[0]?.[1]?.body);
      expect(writes[1]?.[1]?.headers).toEqual(writes[0]?.[1]?.headers);
      expect(field(savedFilterLabel).props.value).toBe("sAvEd");
      if (action === "save") expect(text()).toContain("The earlier save was confirmed safely.");
    },
  );

  it.each(["same", "time zone", "meal groups"] as const)(
    "refreshes a typed log conflict with %s profile without losing verified loaded evidence",
    async (profileChange) => {
      const changed = profileChange !== "same";
      const fetcher = nutritionFetcher();
      const original = required(fetcher.getMockImplementation());
      const refreshed = deferred<Response>();
      let posted = false,
        profileReads = 0,
        listReads = 0;
      fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "POST") {
          posted = true;
          return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
        }
        if (url === "/api/auth/me" && posted) {
          profileReads += 1;
          return refreshed.promise;
        }
        if (url.startsWith("/api/recipes?")) listReads += 1;
        return original(url, init);
      });
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Name", "Keep this unsaved name");
      await change("Amount", "2.000001");
      await click("Per 100 g");
      await change(savedFilterLabel, "Saved");
      await change(nestedFilterLabel, "Private nested query");
      const oldNestedField = field(nestedFilterLabel),
        oldNestedClear = button(clearNestedLabel);
      const oldField = field(savedFilterLabel),
        oldClear = button("Clear filter");
      const draft = editorValues(),
        nutrition = nutritionRows();
      await click("Log recipe");
      const profile = await session().json();
      if (profileChange === "time zone") profile.data.profile.timeZone = "UTC";
      if (profileChange === "meal groups") {
        profile.data.profile.diaryGroups = defaultDiaryGroups.map((group) => ({
          ...group,
          label: group.mealSlot === "dinner" ? "Late dinner" : group.label,
        }));
      }
      refreshed.resolve(Response.json(profile));
      await hooks.settle();
      expect(profileReads).toBe(1);
      expect(listReads).toBe(1);
      expect(field(savedFilterLabel).props.value).toBe(changed ? "" : "Saved");
      expect(field(nestedFilterLabel).props.value).toBe(changed ? "" : "Private nested query");
      if (changed) {
        invoke(oldNestedField, "onChange", { target: { value: "Obsolete nested query" } });
        invoke(oldNestedClear, "onClick");
        await hooks.settle();
        expect(field(nestedFilterLabel).props.value).toBe("");
      }
      expect(field(savedFilterLabel).props.disabled).toBe(false);
      expect(savedRecipeNames()).toEqual(["Saved recipe"]);
      expect(savedFilterStatus()).toContain("1 of 1 loaded recipes match.");
      if (changed) {
        invoke(oldField, "onChange", { target: { value: "Old private query" } });
        invoke(oldClear, "onClick");
        await hooks.settle();
        expect(field(savedFilterLabel).props.value).toBe("");
      }
      await change(savedFilterLabel, "No match");
      expect(editorValues()).toEqual(draft);
      expect(nutritionRows()).toEqual(nutrition);
      expect(field("Amount").props.value).toBe("2.000001");
      expect(field("Local diary date").props.value).toBe("2026-09-09");
      expect(text()).toContain("This recipe was not logged.");
      expect(profileReads).toBe(1);
      expect(listReads).toBe(1);
    },
  );

  it.each(["unmount", "effect replay", "owner closure"] as const)(
    "clears or hides private filtering and rejects retained callbacks after %s",
    async (transition) => {
      const fetcher = nutritionFetcher();
      await mountReady();
      await change(savedFilterLabel, "Saved");
      const oldField = field(savedFilterLabel),
        oldClear = button("Clear filter");
      if (transition === "unmount") hooks.unmount();
      else if (transition === "effect replay") {
        hooks.replayEffects();
        await hooks.settle();
      } else {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation((url, init) =>
          url === "/api/auth/me" ? Promise.resolve(session(secondRecipeId)) : original(url, init),
        );
        openSaved();
        await hooks.settle();
        expect(router.replace).toHaveBeenCalledWith("/login");
        expect(savedRecipeNames()).toEqual([]);
      }
      const calls = fetcher.mock.calls.length;
      invoke(oldField, "onChange", { target: { value: "Old private query" } });
      invoke(oldClear, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(calls);
      expect(hooks.afterClose()).toBe(0);
      if (transition !== "unmount") expect(field(savedFilterLabel).props.value).toBe("");
    },
  );

  it("hides a prior route's query and list before effects and rejects its delayed continuation", async () => {
    const oldPage = deferred<Response>(),
      newAuth = deferred<Response>();
    let authCalls = 0;
    const initial = nutritionRecipe();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          return authCalls === 3 ? newAuth.promise : session();
        }
        if (url.includes("cursor=old-page")) return oldPage.promise;
        return filterCollection([initial], "old-page");
      }),
    );
    await mountReady();
    await change(savedFilterLabel, "Saved");
    const oldField = field(savedFilterLabel),
      oldClear = button("Clear filter");
    await click("Load more recipes");
    navigation.query = "date=2026-09-10";
    hooks.renderWithoutEffects();
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(field(savedFilterLabel).props.disabled).toBe(true);
    expect(savedRecipeNames()).toEqual([]);
    expect(hasButton("Load more recipes")).toBe(false);
    expect(savedFilterStatus()).toBe("Saved recipes have not been loaded yet.");
    invoke(oldField, "onChange", { target: { value: "Stale private query" } });
    invoke(oldClear, "onClick");
    oldPage.resolve(new Response(null, { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(router.replace).not.toHaveBeenCalled();
    hooks.render();
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(savedRecipeNames()).toEqual([]);
    newAuth.resolve(session());
    await hooks.settle();
    await change(savedFilterLabel, "Saved");
    invoke(oldClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("Saved");
    expect(savedRecipeNames()).toEqual(["Saved recipe"]);
  });
});

const nestedFilterLabel = "Filter loaded nested recipes by name";
const clearNestedLabel = "Clear nested recipe filter";
function nestedRecipeCards() {
  const section = required(
    elements().find((node) => node.props["aria-labelledby"] === "nested-recipes-heading"),
  );
  return elements(section).filter((node) => node.props.className === "ingredientResult");
}
function nestedRecipeNames() {
  return nestedRecipeCards().map((card) =>
    text(required(elements(card).find((node) => node.type === "strong"))),
  );
}
function nestedPin(index = 0) {
  return required(
    elements(required(nestedRecipeCards()[index])).find((node) => node.type === "button"),
  );
}
function nestedStatus() {
  return text(required(elements().find((node) => node.props.id === "nested-recipe-filter-status")));
}

describe("actual loaded nested-recipe filtering", () => {
  it("matches literal trimmed names with duplicate order, independent saved filtering and no requests", async () => {
    const values = [
      nutritionRecipe({ name: "Chili [HOT]" }),
      nutritionRecipe({ id: secondRecipeId, name: "Café Soup" }),
      nutritionRecipe({ id: thirdRecipeId, name: "Chili [HOT]" }),
    ];
    const fetcher = nutritionFetcher(values);
    await mountReady();
    const requests = fetcher.mock.calls.length;
    expect(nestedRecipeNames()).toEqual(["Chili [HOT]", "Café Soup", "Chili [HOT]"]);
    expect(nestedStatus()).toContain("3 matching · 3 eligible loaded recipes.");
    await change(savedFilterLabel, "Café");
    for (const [query, names] of [
      ["  cHiLi  ", ["Chili [HOT]", "Chili [HOT]"]],
      ["[hOt]", ["Chili [HOT]", "Chili [HOT]"]],
      [".*", []],
      ["cafe", []],
      ["CAFÉ", ["Café Soup"]],
      [" \t ", ["Chili [HOT]", "Café Soup", "Chili [HOT]"]],
    ] as const) {
      await change(nestedFilterLabel, query);
      expect(nestedRecipeNames()).toEqual(names);
      expect(field(nestedFilterLabel).props.value).toBe(query);
      expect(savedRecipeNames()).toEqual(["Café Soup"]);
    }
    await click(clearNestedLabel);
    expect(button(clearNestedLabel).props.type).toBe("button");
    expect(button(clearNestedLabel).props.disabled).toBe(false);
    const emptyClear = button(clearNestedLabel);
    const emptyPin = nestedPin();
    const beforeClear = ingredientValues();
    const beforeMessage = text(
      required(elements().find((node) => node.props.className === "workspaceStatus")),
    );
    invoke(emptyClear, "onClick");
    invoke(emptyClear, "onClick");
    await hooks.settle();
    expect(button(clearNestedLabel).props.disabled).toBe(false);
    expect(field(nestedFilterLabel).props.value).toBe("");
    expect(ingredientValues()).toEqual(beforeClear);
    expect(
      text(required(elements().find((node) => node.props.className === "workspaceStatus"))),
    ).toBe(beforeMessage);
    expect(nestedRecipeNames()).toEqual(["Chili [HOT]", "Café Soup", "Chili [HOT]"]);
    expect(field(savedFilterLabel).props.value).toBe("Café");
    invoke(emptyPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual([{ name: "Chili [HOT]", quantity: "100", note: "" }]);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("bounds input and fences stale query/Clear/pin before paint, while same-value input keeps pin usable", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    expect(field(nestedFilterLabel).props.maxLength).toBe(200);
    await change(nestedFilterLabel, "x".repeat(220));
    expect(field(nestedFilterLabel).props.value).toBe("x".repeat(200));
    await click(clearNestedLabel);
    const oldField = field(nestedFilterLabel),
      oldClear = button(clearNestedLabel),
      oldPin = nestedPin();
    const requests = fetcher.mock.calls.length;
    invoke(oldField, "onChange", { target: { value: "Saved" } });
    invoke(oldClear, "onClick");
    invoke(oldPin, "onClick");
    await hooks.settle();
    expect(field(nestedFilterLabel).props.value).toBe("Saved");
    expect(ingredientValues()).toEqual([]);
    await click(clearNestedLabel);
    invoke(oldPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual([]);
    const currentField = field(nestedFilterLabel),
      currentPin = nestedPin();
    invoke(currentField, "onChange", { target: { value: "" } });
    invoke(currentField, "onChange", { target: { value: "" } });
    invoke(currentPin, "onClick");
    invoke(currentPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual([{ name: "Saved recipe", quantity: "100", note: "" }]);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it.each(["session", "list"] as const)(
    "keeps the picker visible but unverified after initial %s failure",
    async (failure) => {
      const pending = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url === "/api/auth/me" && failure !== "session" ? session() : pending.promise,
        ),
      );
      hooks.mount(RecipesClient);
      await hooks.settle();
      expect(nestedStatus()).toBe("Nested recipe choices have not been loaded yet.");
      expect(field(nestedFilterLabel).props.disabled).toBe(true);
      expect(button(clearNestedLabel).props.disabled).toBe(true);
      pending.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
      await hooks.settle();
      expect(nestedRecipeNames()).toEqual([]);
      expect(nestedStatus()).not.toContain("All saved recipes");
      expect(hasButton(failure === "session" ? "Retry session" : "Retry recipes")).toBe(true);
    },
  );

  it.each([null, "more"])(
    "keeps verified empty choices and paging meaning for cursor %s",
    async (cursor) => {
      const fetcher = nutritionFetcher([]);
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        url.startsWith("/api/recipes?") ? filterCollection([], cursor) : original(url, init),
      );
      await mountReady();
      expect(nestedStatus()).toContain("0 matching · 0 eligible loaded recipes.");
      expect(nestedStatus()).toContain("No eligible nested recipes are loaded.");
      expect(nestedStatus()).toContain(
        cursor ? "More recipes may be available." : "All saved recipes are loaded.",
      );
      expect(hasButton("Load more recipes")).toBe(cursor !== null);
      await change(nestedFilterLabel, "Soup");
      await click(clearNestedLabel);
    },
  );

  it("excludes self, preserves duplicate IDs/exact version pins and sends the existing final body on explicit save", async () => {
    const source = nutritionRecipe();
    const second = nutritionRecipe({ id: secondRecipeId, name: "Same name", version: 2 });
    const third = nutritionRecipe({ id: thirdRecipeId, name: "Same name" });
    const fetcher = nutritionFetcher([source, second, third]);
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(nestedStatus()).toContain("2 matching · 2 eligible loaded recipes.");
    expect(nestedStatus()).toContain("The recipe being edited is excluded.");
    await change(nestedFilterLabel, "Same");
    const firstPin = nestedPin(0),
      secondPin = nestedPin(1);
    expect(firstPin.props["aria-label"]).toBe("Pin 100 g of Same name version 2");
    invoke(firstPin, "onClick");
    await hooks.settle();
    invoke(secondPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toHaveLength(2);
    invoke(nestedPin(1), "onClick");
    await hooks.settle();
    save();
    await hooks.settle();
    const write = required(fetcher.mock.calls.find(([, init]) => init?.method === "POST"));
    expect(write[0]).toBe(`/api/recipes/${recipeId}/revisions`);
    expect(new Headers(write[1]?.headers).get("if-match")).toBe('"1"');
    const body = JSON.parse(String(write[1]?.body));
    expect(body.ingredients.slice(-2)).toEqual([
      {
        kind: "recipe",
        recipeVersionId: second.currentVersion.id,
        grams: "100",
        note: null,
        position: 1,
      },
      {
        kind: "recipe",
        recipeVersionId: third.currentVersion.id,
        grams: "100",
        note: null,
        position: 2,
      },
    ]);
  });

  it("retains query through zero-match paging/error/retry and rejects replaced or now-hidden choices", async () => {
    const old = nutritionRecipe({ name: "Older choice" });
    const updated = nutritionRecipe({ name: "Fresh choice", version: 2 });
    const soup = nutritionRecipe({ id: secondRecipeId, name: "Later soup" });
    const pending = deferred<Response>();
    let pages = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return session();
      if (url.includes("cursor=two"))
        return ++pages === 1 ? pending.promise : filterCollection([updated, soup], "three");
      if (url.includes("cursor=three")) return filterCollection([]);
      return filterCollection([old], "two");
    });
    vi.stubGlobal("fetch", fetcher);
    await mountReady();
    const oldPin = nestedPin();
    await change(nestedFilterLabel, "soup");
    expect(nestedStatus()).toContain("0 matching · 1 eligible loaded recipes.");
    await click("Load more recipes");
    expect(field(nestedFilterLabel).props.disabled).toBe(true);
    invoke(oldPin, "onClick");
    pending.resolve(Response.json({ error: "Page unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(field(nestedFilterLabel).props.value).toBe("soup");
    expect(nestedStatus()).toContain("More recipes may be available.");
    await click("Load more recipes");
    expect(nestedRecipeNames()).toEqual(["Later soup"]);
    expect(nestedStatus()).toContain("1 matching · 2 eligible loaded recipes.");
    await click(clearNestedLabel);
    invoke(oldPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual([]);
    const currentPin = nestedPin();
    await click("Load more recipes");
    expect(nestedStatus()).toContain("All saved recipes are loaded.");
    invoke(currentPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()[0]?.name).toBe("Fresh choice");
  });

  it("rejects a same-query choice replaced by paging and preserves the fresh exact version through new creation", async () => {
    const first = nutritionRecipe({ name: "Pinned choice" });
    const next = nutritionRecipe({ name: "Pinned choice", version: 2 });
    const fetcher = nutritionFetcher([first]);
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url.startsWith("/api/recipes?")
        ? filterCollection(
            [url.includes("cursor=two") ? next : first],
            url.includes("cursor=two") ? null : "two",
          )
        : original(url, init),
    );
    await mountReady();
    await change("Name", "New nested recipe");
    await change("Final yield grams", "100.000001");
    await change(nestedFilterLabel, "Pinned");
    const oldPin = nestedPin();
    await click("Load more recipes");
    const status = text(
      required(elements().find((node) => node.props.className === "workspaceStatus")),
    );
    invoke(oldPin, "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual([]);
    expect(
      text(required(elements().find((node) => node.props.className === "workspaceStatus"))),
    ).toBe(status);
    invoke(nestedPin(), "onClick");
    await hooks.settle();
    save();
    await hooks.settle();
    const write = required(fetcher.mock.calls.find(([, init]) => init?.method === "POST"));
    expect(write[0]).toBe("/api/recipes");
    expect(new Headers(write[1]?.headers).has("if-match")).toBe(false);
    const body = JSON.parse(String(write[1]?.body));
    expect(body.name).toBe("New nested recipe");
    expect(body.ingredients).toEqual([
      {
        kind: "recipe",
        recipeVersionId: next.currentVersion.id,
        grams: "100",
        note: null,
        position: 0,
      },
    ]);
    expect(field(nestedFilterLabel).props.value).toBe("Pinned");
  });

  it("retains self-only empty meaning and the fifty-ingredient cap", async () => {
    const fetcher = nutritionFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(nestedStatus()).toContain("0 matching · 0 eligible loaded recipes.");
    expect(nestedStatus()).toContain("The recipe being edited is excluded.");
    await click("New recipe");
    const oldPin = nestedPin();
    expect(
      review().onConfirm(Array.from({ length: 50 }, (_, index) => ingredient(`capacity-${index}`))),
    ).toBe(true);
    await hooks.settle();
    expect(nestedPin().props.disabled).toBe(true);
    const before = ingredientValues(),
      requests = fetcher.mock.calls.length;
    invoke(oldPin, "onClick");
    invoke(nestedPin(), "onClick");
    await hooks.settle();
    expect(ingredientValues()).toEqual(before);
    expect(fetcher.mock.calls).toHaveLength(requests);
    await change(nestedFilterLabel, "No match");
    await click(clearNestedLabel);
    expect(ingredientValues()).toEqual(before);
  });

  it.each(["new", "open", "copy", "unmount", "replay", "closure", "route"] as const)(
    "rejects retained picker callbacks after %s while retaining only the current private query",
    async (transition) => {
      const fetcher = nutritionFetcher([
        nutritionRecipe(),
        nutritionRecipe({ id: secondRecipeId, name: "Other" }),
      ]);
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(nestedFilterLabel, "Other");
      const oldField = field(nestedFilterLabel),
        oldClear = button(clearNestedLabel),
        oldPin = nestedPin();
      if (transition === "new") await click("New recipe");
      if (transition === "open") {
        openSaved();
        await hooks.settle();
      }
      if (transition === "copy") await click("Copy to new draft");
      if (transition === "unmount") hooks.unmount();
      if (transition === "replay") {
        hooks.replayEffects();
        await hooks.settle();
      }
      if (transition === "closure") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation((url, init) =>
          url === "/api/auth/me" ? Promise.resolve(session(secondRecipeId)) : original(url, init),
        );
        openSaved();
        await hooks.settle();
      }
      if (transition === "route") {
        navigation.query = "date=2026-09-10";
        hooks.renderWithoutEffects();
      }
      const before = ingredientValues(),
        requests = fetcher.mock.calls.length;
      invoke(oldField, "onChange", { target: { value: "Obsolete" } });
      invoke(oldClear, "onClick");
      invoke(oldPin, "onClick");
      if (transition !== "route") await hooks.settle();
      expect(ingredientValues()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(requests);
      expect(hooks.afterClose()).toBe(0);
      if (["new", "open", "copy"].includes(transition)) {
        expect(field(nestedFilterLabel).props.value).toBe("Other");
        await click(clearNestedLabel);
        expect(nestedRecipeNames().length).toBeGreaterThan(0);
      } else if (transition !== "unmount") {
        expect(field(nestedFilterLabel).props.value).toBe("");
        if (transition !== "replay") expect(nestedRecipeNames()).toEqual([]);
      }
    },
  );
});

const optionalTimeLabel = "Local time (optional)";
function retryableLogFetcher() {
  const fetcher = nutritionFetcher();
  const original = required(fetcher.getMockImplementation());
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST" && url.includes("/log?")
      ? Response.json({ error: "Lost confirmation" }, { status: 503 })
      : original(url, init),
  );
  return fetcher;
}
function recipeLogPosts(fetcher: ReturnType<typeof nutritionFetcher>) {
  return fetcher.mock.calls.filter(
    ([url, init]) => init?.method === "POST" && url.includes("/log?"),
  );
}
function acceptedRecipeLog() {
  return Response.json({
    data: {
      replayed: false,
      entry: null,
      affectedDays: [{ localDate: "2026-09-09", revision: "1" }],
    },
  });
}

async function recipeSessionInZone(timeZone: string, id = owner) {
  const value = await session(id).json();
  value.data.profile.timeZone = timeZone;
  value.data.profile.diaryGroups = defaultDiaryGroups.map((group) => ({
    ...group,
    label: `My ${group.mealSlot}`,
  }));
  return Response.json(value);
}

describe("actual initial recipe meal in the verified profile timezone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["2026-09-28T15:59:00.000Z", 21, "breakfast", "2026-09-28"],
    ["2026-09-28T16:00:00.000Z", 5, "lunch", "2026-09-28"],
    ["2026-09-28T19:59:00.000Z", 5, "lunch", "2026-09-28"],
    ["2026-09-28T20:00:00.000Z", 5, "dinner", "2026-09-28"],
    ["2026-09-29T01:59:00.000Z", 5, "dinner", "2026-09-28"],
    ["2026-09-29T02:00:00.000Z", 5, "snacks", "2026-09-28"],
    ["2026-09-29T05:00:00.000Z", 21, "breakfast", "2026-09-29"],
    ["2026-09-28T01:00:00.000Z", 1, "dinner", "2026-09-27"],
  ] as const)(
    "logs initial %s with browser hour %s as %s on profile date %s",
    async (instant, browserHour, expectedMeal, expectedDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(instant));
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(browserHour);
      navigation.query = "";
      const fetcher = retryableLogFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        url === "/api/auth/me" ? recipeSessionInZone("America/Chicago") : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      expect(field("Local diary date").props.value).toBe(expectedDate);
      expect(field("Meal").props.value).toBe(expectedMeal);
      expect(
        elements(field("Meal")).find(
          (node) => node.props.value === expectedMeal && node.type === "option",
        ),
      ).toMatchObject({ props: { children: `My ${expectedMeal}` } });
      await click("Log recipe");
      const [, init] = required(recipeLogPosts(fetcher)[0]);
      expect(JSON.parse(String(init?.body))).toEqual({
        recipeVersionId: versionId,
        portion: { kind: "serving", amount: "1" },
        mealSlot: expectedMeal,
        occurredAt: instant,
      });
      expect(new Headers(init?.headers).get("x-expected-profile-time-zone")).toBe(
        "America/Chicago",
      );
    },
  );

  it("keeps an explicit meal and exact pending request after clock and route-session refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T01:00:00.000Z"));
    vi.spyOn(Date.prototype, "getHours").mockReturnValue(1);
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(field("Meal").props.value).toBe("dinner");
    await change("Meal", "snacks");
    await change("Amount", "1.250000");
    await change(optionalTimeLabel, "07:30");
    await click("Log recipe");
    const [, first] = required(recipeLogPosts(fetcher)[0]);
    vi.setSystemTime(new Date("2026-09-28T17:00:00.000Z"));
    await click("Log recipe");
    const [, second] = required(recipeLogPosts(fetcher)[1]);
    expect(second?.body).toBe(first?.body);
    expect(new Headers(second?.headers).get("idempotency-key")).toBe(
      new Headers(first?.headers).get("idempotency-key"),
    );
    expect(field("Meal").props.value).toBe("snacks");
    expect(field("Amount").props.value).toBe("1.250000");
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    const oldMeal = field("Meal");
    const oldLog = button("Log recipe");
    navigation.query = "date=2026-09-10";
    hooks.renderWithoutEffects();
    invoke(oldMeal, "onChange", { target: { value: "breakfast" } });
    invoke(oldLog, "onClick");
    hooks.render();
    await hooks.settle();
    expect(recipeLogPosts(fetcher)).toHaveLength(2);
    expect(field("Meal").props.value).toBe("snacks");
    expect(field("Amount").props.value).toBe("1.250000");
    // The existing route behavior still selects the requested date and clears optional time.
    expect(field("Local diary date").props.value).toBe("2026-09-10");
    expect(field(optionalTimeLabel).props.value).toBe("");
    await change("Local diary date", "2026-09-09");
    await change(optionalTimeLabel, "07:30");
    await click("Log recipe");
    const [, third] = required(recipeLogPosts(fetcher)[2]);
    expect(third?.body).toBe(first?.body);
    expect(new Headers(third?.headers).get("idempotency-key")).toBe(
      new Headers(first?.headers).get("idempotency-key"),
    );
  });

  it.each(["route", "effect replay"] as const)(
    "does not consume the initial default from an aborted %s session",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-28T01:00:00.000Z"));
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(23);
      const oldAuth = deferred<Response>();
      const currentAuth = deferred<Response>();
      let authCalls = 0;
      const fetcher = retryableLogFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          if (authCalls === 1) return oldAuth.promise;
          if (authCalls === 2) return currentAuth.promise;
          return recipeSessionInZone("America/Chicago");
        }
        return original(url, init);
      });
      hooks.mount(RecipesClient);
      const oldSignal = required(fetcher.mock.calls[0]?.[1]?.signal ?? undefined);
      if (transition === "route") {
        navigation.query = "date=2026-09-10";
        hooks.render();
      } else hooks.replayEffects();
      expect(oldSignal.aborted).toBe(true);
      oldAuth.resolve(await recipeSessionInZone("UTC", secondRecipeId));
      await hooks.settle();
      expect(savedRecipeNames()).toEqual([]);
      expect(reviewPresent()).toBe(false);
      expect(router.replace).not.toHaveBeenCalled();
      currentAuth.resolve(await recipeSessionInZone("America/Chicago"));
      await hooks.settle();
      openSaved();
      await hooks.settle();
      expect(field("Meal").props.value).toBe("dinner");
      await click("Log recipe");
      expect(JSON.parse(String(recipeLogPosts(fetcher)[0]?.[1]?.body)).mealSlot).toBe("dinner");
    },
  );

  it.each(["route", "effect replay"] as const)(
    "keeps the established unedited meal when %s verification runs at a later hour",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-28T01:00:00.000Z"));
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(1);
      const fetcher = retryableLogFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      expect(field("Meal").props.value).toBe("dinner");
      vi.setSystemTime(new Date("2026-09-28T17:00:00.000Z"));
      if (transition === "route") {
        navigation.query = "date=2026-09-10";
        hooks.render();
      } else hooks.replayEffects();
      await hooks.settle();
      expect(field("Meal").props.value).toBe("dinner");
      await click("Log recipe");
      expect(JSON.parse(String(recipeLogPosts(fetcher)[0]?.[1]?.body)).mealSlot).toBe("dinner");
    },
  );

  it("closes the private destination when route verification returns a different owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T01:00:00.000Z"));
    vi.spyOn(Date.prototype, "getHours").mockReturnValue(1);
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Meal", "snacks");
    const oldMeal = field("Meal");
    const oldLog = button("Log recipe");
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url === "/api/auth/me" ? recipeSessionInZone("UTC", secondRecipeId) : original(url, init),
    );
    navigation.query = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(savedRecipeNames()).toEqual([]);
    expect(reviewPresent()).toBe(false);
    const count = fetcher.mock.calls.length;
    invoke(oldMeal, "onChange", { target: { value: "lunch" } });
    invoke(oldLog, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(count);
    expect(recipeLogPosts(fetcher)).toHaveLength(0);
  });

  it("does not install a delayed initial session after unmount", async () => {
    const pending = deferred<Response>();
    const fetcher = retryableLogFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url === "/api/auth/me" ? pending.promise : original(url, init),
    );
    hooks.mount(RecipesClient);
    const signal = required(fetcher.mock.calls[0]?.[1]?.signal ?? undefined);
    hooks.unmount();
    pending.resolve(await recipeSessionInZone("America/Chicago"));
    await hooks.settle();
    expect(signal.aborted).toBe(true);
    expect(hooks.afterClose()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 503])(
    "does not open a log destination after initial verification returns %s",
    async (status) => {
      const fetcher = retryableLogFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        url === "/api/auth/me"
          ? Promise.resolve(new Response(null, { status }))
          : original(url, init),
      );
      hooks.mount(RecipesClient);
      await hooks.settle();
      expect(savedRecipeNames()).toEqual([]);
      expect(elements().some((node) => node.type === "button" && text(node) === "Log recipe")).toBe(
        false,
      );
      expect(recipeLogPosts(fetcher)).toHaveLength(0);
    },
  );
});

describe("actual optional recipe log time", () => {
  it.each([
    ["2026-11-01", "", "2026-11-01T07:30:45.123Z"],
    ["2026-10-31", "", "2026-10-31T17:00:00.000Z"],
    ["2026-11-01", "01:30", "2026-11-01T06:30:00.000Z"],
    ["2026-09-09", "00:00", "2026-09-09T05:00:00.000Z"],
  ])("logs %s at %j with the exact expected instant", async (date, time, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    expect(field(optionalTimeLabel).props.value).toBe("");
    expect(field(optionalTimeLabel).props.type).toBe("time");
    await change("Local diary date", date);
    await change(optionalTimeLabel, time);
    await change("Amount", "1.250000");
    await change("Meal", "lunch");
    const count = fetcher.mock.calls.length;
    // A current same-value callback must not strand the immediately captured Log action.
    const log = button("Log recipe");
    invoke(field(optionalTimeLabel), "onChange", { target: { value: time } });
    expect(fetcher.mock.calls).toHaveLength(count);
    invoke(log, "onClick");
    await hooks.settle();
    const [url, init] = required(recipeLogPosts(fetcher)[0]);
    expect(url).toBe(`/api/recipes/${recipeId}/log?profileTimeZonePrecondition=v1`);
    expect(JSON.parse(String(init?.body))).toEqual({
      recipeVersionId: versionId,
      portion: { kind: "serving", amount: "1.250000" },
      mealSlot: "lunch",
      occurredAt: expected,
    });
    expect(new Headers(init?.headers).get("x-expected-profile-time-zone")).toBe("America/Chicago");
    expect(field(optionalTimeLabel).props.value).toBe(time);
  });

  it.each([" ", "07:30 ", "24:00", "07:30:01", "02:30"])(
    "rejects raw invalid or skipped time %j without a request",
    async (time) => {
      const fetcher = retryableLogFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Local diary date", "2026-03-08");
      await change(optionalTimeLabel, time);
      const count = fetcher.mock.calls.length;
      await click("Log recipe");
      expect(fetcher.mock.calls).toHaveLength(count);
      expect(field(optionalTimeLabel).props.value).toBe(time);
      expect(button("Log recipe").props.disabled).toBe(false);
      expect(text()).toContain(time === "02:30" ? "does not exist" : "Invalid local diary time");
    },
  );

  it("keeps each pending automatic/time intent across retries, clock changes and A-to-B-to-A edits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Local diary date", "2026-11-01");
    await click("Log recipe");
    vi.setSystemTime(new Date("2026-11-01T08:45:56.789Z"));
    await change(optionalTimeLabel, "01:30");
    await click("Log recipe");
    await change(optionalTimeLabel, "01:31");
    await click("Log recipe");
    await change(optionalTimeLabel, "01:30");
    await click("Log recipe");
    await change(optionalTimeLabel, "");
    await click("Log recipe");
    const posts = recipeLogPosts(fetcher);
    expect(posts).toHaveLength(5);
    const bodies = posts.map(([, init]) => init?.body);
    const keys = posts.map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(bodies[3]).toBe(bodies[1]);
    expect(keys[3]).toBe(keys[1]);
    expect(bodies[4]).toBe(bodies[0]);
    expect(keys[4]).toBe(keys[0]);
    expect(JSON.parse(String(bodies[4])).occurredAt).toBe("2026-11-01T07:30:45.123Z");
  });

  it("fences all retained log fields and Log synchronously after time changes without affecting other drafts", async () => {
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Unsaved independent name");
    await click("Copy to new draft");
    const confirmation = text();
    const draft = editorValues();
    const old = [optionalTimeLabel, "Local diary date", "Amount", "Portion", "Meal"].map(field);
    const log = button("Log recipe");
    invoke(old[0] as ElementNode, "onChange", { target: { value: "07:30" } });
    for (const [i, value] of ["09:00", "2026-09-01", "999", "grams", "lunch"].entries()) {
      invoke(required(old[i]), "onChange", { target: { value } });
    }
    invoke(log, "onClick");
    await hooks.settle();
    expect(recipeLogPosts(fetcher)).toHaveLength(0);
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    expect(field("Local diary date").props.value).toBe("2026-09-09");
    expect(field("Amount").props.value).toBe("1");
    expect(field("Portion").props.value).toBe("serving");
    expect(editorValues()).toEqual(draft);
    expect(text()).toContain("Keep editing");
    expect(confirmation).toContain("Keep editing");
    await change(savedFilterLabel, "Hidden selection");
    await change(nestedFilterLabel, "Nested only");
    await click("Per 100 g");
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    expect(editorValues()).toEqual(draft);
    await change("Local diary date", "2026-09-08");
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
  });

  it.each(["New", "copy", "open", "save"])(
    "resets time and rejects previous controls after %s replaces the selection",
    async (transition) => {
      const fetcher = retryableLogFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(optionalTimeLabel, "07:30");
      const old = field(optionalTimeLabel),
        log = button("Log recipe");
      if (transition === "New") await click("New recipe");
      else if (transition === "copy") await click("Copy to new draft");
      else if (transition === "save") {
        await change("Name", "Saved revision");
        save();
        await hooks.settle();
      } else {
        openSaved();
        await hooks.settle();
      }
      invoke(old, "onChange", { target: { value: "23:59" } });
      invoke(log, "onClick");
      await hooks.settle();
      expect(recipeLogPosts(fetcher)).toHaveLength(0);
      if (transition === "New" || transition === "copy") {
        openSaved();
        await hooks.settle();
        if (transition === "copy") await click(confirmOpenLabel);
      }
      expect(field(optionalTimeLabel).props.value).toBe("");
    },
  );

  it.each(["route", "owner", "unmount"])(
    "rejects retained log callbacks after %s changes private context",
    async (transition) => {
      const fetcher = retryableLogFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(optionalTimeLabel, "07:30");
      const old = field(optionalTimeLabel),
        log = button("Log recipe");
      if (transition === "route") {
        navigation.query = "date=2026-09-08";
        hooks.renderWithoutEffects();
        expect(field(optionalTimeLabel).props.value).toBe("");
        expect(field(optionalTimeLabel).props.disabled).toBe(true);
      } else if (transition === "owner") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation(async (url, init) =>
          url === "/api/auth/me"
            ? session("a3fd8855-90c8-42df-8f21-2f5a4060fa08")
            : original(url, init),
        );
        openSaved();
        await hooks.settle();
      } else hooks.unmount();
      const count = fetcher.mock.calls.length,
        updates = hooks.afterClose();
      invoke(old, "onChange", { target: { value: "23:59" } });
      invoke(log, "onClick");
      expect(fetcher.mock.calls).toHaveLength(count);
      expect(hooks.afterClose()).toBe(updates);
      if (transition === "route") {
        hooks.render();
        await hooks.settle();
        expect(field(optionalTimeLabel).props.value).toBe("");
      }
    },
  );

  it("retains date/time for new-zone confirmation and rejects stale confirmation after a further time edit", async () => {
    const fetcher = retryableLogFetcher();
    const original = required(fetcher.getMockImplementation());
    let posts = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && url.includes("/log?")) {
        posts += 1;
        return posts === 1
          ? Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 })
          : Response.json({ error: "Lost confirmation" }, { status: 503 });
      }
      if (url === "/api/auth/me" && posts > 0) {
        const profile = await session().json();
        profile.data.profile.timeZone = "UTC";
        return Response.json(profile);
      }
      return original(url, init);
    });
    await mountReady();
    openSaved();
    await hooks.settle();
    await change(optionalTimeLabel, "07:30");
    await change("Meal", "snacks");
    await change("Amount", "1.250000");
    const old = field(optionalTimeLabel);
    await click("Log recipe");
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    expect(field("Meal").props.value).toBe("snacks");
    expect(field("Amount").props.value).toBe("1.250000");
    expect(text()).toContain("Review 2026-09-09 at 07:30 in that zone");
    expect(button("Log recipe").props.disabled).toBe(true);
    invoke(old, "onChange", { target: { value: "23:59" } });
    await hooks.settle();
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    const confirm = button("Confirm 2026-09-09 at 07:30 in UTC");
    invoke(field(optionalTimeLabel), "onChange", { target: { value: "08:45" } });
    invoke(confirm, "onClick");
    await hooks.settle();
    expect(button("Log recipe").props.disabled).toBe(true);
    await click("Confirm 2026-09-09 at 08:45 in UTC");
    await click("Log recipe");
    const writes = recipeLogPosts(fetcher);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual({
      recipeVersionId: versionId,
      portion: { kind: "serving", amount: "1.250000" },
      mealSlot: "snacks",
      occurredAt: "2026-09-09T08:45:00.000Z",
    });
    expect(new Headers(writes[1]?.[1]?.headers).get("x-expected-profile-time-zone")).toBe("UTC");
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).not.toBe(
      new Headers(writes[0]?.[1]?.headers).get("idempotency-key"),
    );
  });

  it("locks pending time controls but accepts a current receipt across same-owner list refresh", async () => {
    const fetcher = nutritionFetcher();
    const original = required(fetcher.getMockImplementation());
    const pending = deferred<Response>();
    fetcher.mockImplementation(async (url, init) => {
      if (url.startsWith("/api/recipes?")) {
        const response = await nutritionCollection([nutritionRecipe()]).json();
        response.page.nextCursor = "next";
        return Response.json(response);
      }
      if (init?.method === "POST" && url.includes("/log?")) return pending.promise;
      return original(url, init);
    });
    await mountReady();
    openSaved();
    await hooks.settle();
    await change(optionalTimeLabel, "07:30");
    const time = field(optionalTimeLabel),
      log = button("Log recipe"),
      more = button("Load more recipes");
    invoke(log, "onClick");
    invoke(time, "onChange", { target: { value: "23:59" } });
    invoke(log, "onClick");
    await hooks.settle();
    expect(field(optionalTimeLabel).props.disabled).toBe(true);
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    invoke(more, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/recipes?"))).toHaveLength(2);
    pending.resolve(acceptedRecipeLog());
    await hooks.settle();
    expect(recipeLogPosts(fetcher)).toHaveLength(1);
    expect(text()).toContain("Recipe logged to");
    expect(button("Log recipe").props.disabled).toBe(false);
    await click("Log recipe");
    const writes = recipeLogPosts(fetcher);
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).not.toBe(
      new Headers(writes[0]?.[1]?.headers).get("idempotency-key"),
    );
  });

  it.each(["fetch", "json"])(
    "ignores a delayed old log at its %s boundary after a route replacement",
    async (boundary) => {
      const fetcher = retryableLogFetcher();
      const original = required(fetcher.getMockImplementation());
      const pendingFetch = deferred<Response>(),
        pendingJson = deferred<unknown>();
      fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "POST" && url.includes("/log?")) {
          if (boundary === "fetch") return pendingFetch.promise;
          const response = acceptedRecipeLog();
          response.json = () => pendingJson.promise;
          return response;
        }
        return original(url, init);
      });
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(optionalTimeLabel, "07:30");
      await click("Log recipe");
      navigation.query = "date=2026-09-08";
      hooks.renderWithoutEffects();
      if (boundary === "fetch")
        pendingFetch.resolve(Response.json({ error: "Old expiry" }, { status: 401 }));
      else pendingJson.resolve(await acceptedRecipeLog().json());
      await Promise.resolve();
      await Promise.resolve();
      expect(router.replace).not.toHaveBeenCalled();
      hooks.render();
      await hooks.settle();
      expect(field("Local diary date").props.value).toBe("2026-09-08");
      expect(field(optionalTimeLabel).props.value).toBe("");
      expect(button("Log recipe").props.disabled).toBe(false);
      expect(text()).not.toContain("Recipe logged to");
    },
  );
});

describe("native time input validity when logging a recipe", () => {
  function installTimeInput(valid: boolean) {
    const input = { value: "", validity: { valid, badInput: !valid } };
    const ref = field(optionalTimeLabel).props.ref as { current: HTMLInputElement | null };
    expect(ref).toBeDefined();
    ref.current = input as unknown as HTMLInputElement;
    return input;
  }

  it("blocks repeated partial-empty input before allocation and preserves automatic retry through genuine clearing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T14:30:45.123Z"));
    const originalCrypto = crypto;
    const allocate = vi.fn(() => originalCrypto.randomUUID());
    vi.stubGlobal("crypto", { randomUUID: allocate });
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change(optionalTimeLabel, "07:30");
    const input = installTimeInput(false);
    await change(optionalTimeLabel, "");
    expect(field(optionalTimeLabel).props.value).toBe("");
    const before = fetcher.mock.calls.length,
      beforeIds = allocate.mock.calls.length;
    await click("Log recipe");
    await click("Log recipe");
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(allocate).toHaveBeenCalledTimes(beforeIds);
    expect(button("Log recipe").props.disabled).toBe(false);
    expect(text()).toContain("Complete the local time, or clear every time segment");

    input.validity = { valid: true, badInput: false };
    await change(optionalTimeLabel, "");
    await click("Log recipe");
    const first = required(recipeLogPosts(fetcher)[0]);
    expect(JSON.parse(String(first[1]?.body)).occurredAt).toBe("2026-09-09T14:30:45.123Z");
    vi.setSystemTime(new Date("2026-09-09T18:45:56.789Z"));
    input.validity = { valid: false, badInput: true };
    await change(optionalTimeLabel, "");
    await click("Log recipe");
    expect(recipeLogPosts(fetcher)).toHaveLength(1);
    expect(allocate).toHaveBeenCalledTimes(beforeIds + 1);
    input.validity = { valid: true, badInput: false };
    await change(optionalTimeLabel, "");
    await click("Log recipe");
    const retry = required(recipeLogPosts(fetcher)[1]);
    expect(retry[1]?.body).toBe(first[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(allocate).toHaveBeenCalledTimes(beforeIds + 1);

    input.validity = { valid: false, badInput: true };
    await click("Log recipe");
    input.validity = { valid: true, badInput: false };
    input.value = "07:45";
    await change(optionalTimeLabel, "07:45");
    await click("Log recipe");
    expect(recipeLogPosts(fetcher)).toHaveLength(3);
    expect(JSON.parse(String(recipeLogPosts(fetcher)[2]?.[1]?.body)).occurredAt).toBe(
      "2026-09-09T12:45:00.000Z",
    );
    expect(allocate).toHaveBeenCalledTimes(beforeIds + 2);
  });

  it("requires a valid native time control before confirming a refreshed profile zone", async () => {
    const fetcher = retryableLogFetcher();
    const original = required(fetcher.getMockImplementation());
    let posted = false;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && url.includes("/log?")) {
        posted = true;
        return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
      }
      if (url === "/api/auth/me" && posted) {
        const profile = await session().json();
        profile.data.profile.timeZone = "UTC";
        return Response.json(profile);
      }
      return original(url, init);
    });
    await mountReady();
    openSaved();
    await hooks.settle();
    await change(optionalTimeLabel, "07:30");
    await click("Log recipe");
    const input = installTimeInput(false);
    await change(optionalTimeLabel, "");
    const before = fetcher.mock.calls.length;
    await click("Confirm 2026-09-09 as local day");
    expect(text()).toContain("Complete the local time, or clear every time segment");
    expect(button("Log recipe").props.disabled).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(before);
    input.validity = { valid: true, badInput: false };
    await change(optionalTimeLabel, "");
    await click("Confirm 2026-09-09 as local day");
    expect(button("Log recipe").props.disabled).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it.each(["route", "unmount"])(
    "does not inspect a current invalid control from stale Log or confirmation after %s",
    async (transition) => {
      const fetcher = retryableLogFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        init?.method === "POST" && url.includes("/log?")
          ? Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 })
          : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      await click("Log recipe");
      const confirm = button("Confirm 2026-09-09 as local day"),
        log = button("Log recipe");
      const readValidity = vi.fn(() => ({ valid: false, badInput: true }));
      const ref = field(optionalTimeLabel).props.ref as { current: HTMLInputElement | null };
      ref.current = {
        get validity() {
          return readValidity();
        },
      } as unknown as HTMLInputElement;
      if (transition === "route") {
        navigation.query = "date=2026-09-08";
        hooks.renderWithoutEffects();
      } else hooks.unmount();
      const before = fetcher.mock.calls.length,
        updates = hooks.afterClose(),
        beforeText = text();
      invoke(log, "onClick");
      invoke(confirm, "onClick");
      expect(readValidity).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(hooks.afterClose()).toBe(updates);
      expect(text()).toBe(beforeText);
    },
  );
});

function ingredientSearchFood(index: number, changes: Partial<FoodSearchHit> = {}): FoodSearchHit {
  return {
    ...food,
    foodId: String(1001 + index),
    foodVersionId: String(2001 + index),
    name: `Reviewed food ${index}`,
    defaultServing: { ...food.defaultServing, servingId: String(3001 + index) },
    ...changes,
  };
}
function ingredientSearchPage(items: readonly FoodSearchHit[], cursor: string | null = null) {
  return Response.json({ data: items, page: { nextCursor: cursor } });
}
function ingredientSearchRows() {
  return elements().filter(
    (node) =>
      node.props.className === "ingredientResult" &&
      elements(node).some((child) => child.type === "button" && text(child) === "Add serving"),
  );
}
function ingredientSearchNames() {
  return ingredientSearchRows().map((row) =>
    text(required(elements(row).find((node) => node.type === "strong"))),
  );
}
function ingredientSearchAdd(index: number, mode: "grams" | "serving" = "grams") {
  return required(
    elements(required(ingredientSearchRows()[index])).find(
      (node) =>
        node.type === "button" && text(node) === (mode === "grams" ? "Add 100 g" : "Add serving"),
    ),
  );
}
function ingredientSearchStatus() {
  return text(
    required(
      elements().find(
        (node) => node.props.role === "status" && node.props.className === "fieldHelp",
      ),
    ),
  );
}
function pagedIngredientFetcher() {
  const fetcher = nutritionFetcher();
  const original = required(fetcher.getMockImplementation());
  const first = Array.from({ length: 20 }, (_, index) => ingredientSearchFood(index));
  const later = [
    ingredientSearchFood(20, { name: "Same name" }),
    ingredientSearchFood(21, { foodId: first[0]?.foodId ?? "1001", name: "Same name" }),
  ];
  fetcher.mockImplementation(async (url, init) => {
    if (url.startsWith("/api/foods/search?")) {
      const cursor = new URL(url, "https://example.test").searchParams.get("cursor");
      if (cursor === null) return ingredientSearchPage(first, "page.one");
      if (cursor === "page.one")
        return ingredientSearchPage(
          [
            {
              ...required(first[19]),
              name: "Overlapping replacement must not displace loaded object",
            },
            ...later,
          ],
          "page.two",
        );
      if (cursor === "page.two") return ingredientSearchPage([]);
      throw new Error(`Unexpected ingredient cursor: ${cursor}`);
    }
    return original(url, init);
  });
  return { fetcher, first, later };
}
function ingredientSearchReads(fetcher: ReturnType<typeof nutritionFetcher>) {
  return fetcher.mock.calls.filter(([url]) => url.startsWith("/api/foods/search?"));
}

describe("actual paged reviewed-food ingredient search", () => {
  it("merges20/overlap/empty pages and saves exact later-page pins while preserving other drafts", async () => {
    const { fetcher, first, later } = pagedIngredientFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Keep this dirty recipe");
    await change("Instructions (optional)", "Raw instructions  ");
    await change(optionalTimeLabel, "07:30");
    await change("Amount", "1.250000");
    await change("Meal", "lunch");
    await change(savedFilterLabel, "Saved");
    await change(nestedFilterLabel, "Nested draft");
    await click("Per 100 g");
    await click("Copy to new draft");
    const nutrition = nutritionRows();
    const log = ["Local diary date", optionalTimeLabel, "Amount", "Portion", "Meal"].map(
      (label) => field(label).props.value,
    );
    const before = fetcher.mock.calls.length;
    await change("Find a reviewed food", "  Ｏats   bowl  ");
    expect(fetcher.mock.calls).toHaveLength(before);
    const draft = editorValues();
    await click("Search");
    expect(ingredientSearchReads(fetcher)[0]?.[0]).toBe(
      "/api/foods/search?query=Oats+bowl&intent=all&limit=20",
    );
    expect(ingredientSearchStatus()).toContain("20 reviewed foods loaded for “Oats bowl”");
    const oldAdd = ingredientSearchAdd(0);
    await click("Load more foods");
    expect(ingredientSearchNames()).toEqual([
      ...first.map((item) => item.name),
      ...later.map((item) => item.name),
    ]);
    expect(ingredientSearchRows()).toHaveLength(22);
    expect(ingredientSearchReads(fetcher)[1]?.[0]).toBe(
      "/api/foods/search?query=Oats+bowl&intent=all&cursor=page.one&limit=20",
    );
    await click("Load more foods");
    expect(ingredientSearchRows()).toHaveLength(22);
    expect(hasButton("Load more foods")).toBe(false);
    expect(ingredientSearchStatus()).toContain("No more results are available in this search.");
    expect(editorValues()).toEqual(draft);
    expect(nutritionRows()).toEqual(nutrition);
    expect(
      ["Local diary date", optionalTimeLabel, "Amount", "Portion", "Meal"].map(
        (label) => field(label).props.value,
      ),
    ).toEqual(log);
    expect(field(savedFilterLabel).props.value).toBe("Saved");
    expect(field(nestedFilterLabel).props.value).toBe("Nested draft");
    expect(hasButton(confirmCopyLabel)).toBe(true);
    const beforeAdd = fetcher.mock.calls.length;
    invoke(oldAdd, "onClick");
    await hooks.settle();
    expect(editorValues()).toEqual(draft);
    invoke(ingredientSearchAdd(20, "serving"), "onClick");
    await hooks.settle();
    invoke(ingredientSearchAdd(21), "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(beforeAdd);
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    save();
    await hooks.settle();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body)).ingredients.slice(-2)).toEqual([
      {
        kind: "food",
        foodVersionId: later[0]?.foodVersionId,
        portion: { kind: "serving", servingId: later[0]?.defaultServing?.servingId, amount: "1" },
        position: 1,
        note: null,
      },
      {
        kind: "food",
        foodVersionId: later[1]?.foodVersionId,
        portion: { kind: "grams", grams: "100" },
        position: 2,
        note: null,
      },
    ]);
  });

  it.each([null, "empty.next"])(
    "distinguishes an empty loaded page with cursor%s from an unverified search",
    async (cursor) => {
      const { fetcher } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        url.startsWith("/api/foods/search?")
          ? ingredientSearchPage([], cursor)
          : original(url, init),
      );
      await mountReady();
      expect(ingredientSearchStatus()).toContain("Search to load");
      expect(ingredientSearchStatus()).not.toContain("No more results");
      await change("Find a reviewed food", "empty");
      await click("Search");
      expect(ingredientSearchStatus()).toContain("0 reviewed foods loaded for “empty”");
      expect(hasButton("Load more foods")).toBe(cursor !== null);
      expect(ingredientSearchStatus()).toContain(
        cursor ? "More results may be available" : "No more results are available in this search",
      );
    },
  );

  it("binds exact raw query, same-value actions and stale A-to-B-to-A callbacks without requests on typing", async () => {
    const { fetcher } = pagedIngredientFetcher();
    await mountReady();
    await change("Find a reviewed food", " oats ");
    await click("Search");
    const raw = field("Find a reviewed food"),
      more = button("Load more foods"),
      add = ingredientSearchAdd(0),
      search = button("Search");
    const before = fetcher.mock.calls.length;
    invoke(raw, "onChange", { target: { value: "oats" } });
    invoke(more, "onClick");
    invoke(add, "onClick");
    invoke(search, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(button("Load more foods").props.disabled).toBe(true);
    expect(ingredientSearchAdd(0).props.disabled).toBe(true);
    expect(ingredientSearchStatus()).toContain("loaded for “oats”");
    await change("Find a reviewed food", " oats ");
    invoke(raw, "onChange", { target: { value: "obsolete" } });
    invoke(more, "onClick");
    invoke(add, "onClick");
    await hooks.settle();
    expect(field("Find a reviewed food").props.value).toBe(" oats ");
    expect(fetcher.mock.calls).toHaveLength(before);
    const currentMore = button("Load more foods");
    invoke(field("Find a reviewed food"), "onChange", { target: { value: " oats " } });
    invoke(currentMore, "onClick");
    invoke(currentMore, "onClick");
    await hooks.settle();
    expect(ingredientSearchReads(fetcher)).toHaveLength(2);
  });

  it("fresh Search replaces even the same query and prevents retained result/cursor actions", async () => {
    const { fetcher } = pagedIngredientFetcher();
    await mountReady();
    await change("Find a reviewed food", "oats");
    await click("Search");
    const old = ingredientSearchAdd(0),
      more = button("Load more foods");
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      url.startsWith("/api/foods/search?")
        ? ingredientSearchPage([ingredientSearchFood(50)], "new.page")
        : original(url, init),
    );
    const search = button("Search");
    invoke(search, "onClick");
    invoke(search, "onClick");
    await hooks.settle();
    expect(ingredientSearchNames()).toEqual(["Reviewed food 50"]);
    const before = fetcher.mock.calls.length,
      draft = editorValues();
    invoke(old, "onClick");
    invoke(more, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(editorValues()).toEqual(draft);
    expect(ingredientSearchReads(fetcher)).toHaveLength(2);
    expect(ingredientSearchReads(fetcher)[1]?.[0]).not.toContain("cursor=");
  });

  it.each(["503", "malformed"])(
    "retains loaded results/cursor for exact continuation retry after%s",
    async (failure) => {
      const { fetcher, first } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation());
      let attempts = 0;
      fetcher.mockImplementation(async (url, init) => {
        if (url.includes("cursor=page.one") && ++attempts === 1)
          return failure === "503"
            ? Response.json({ error: "Temporary search outage" }, { status: 503 })
            : Response.json({ data: [], page: { nextCursor: "invalid$cursor" } });
        return original(url, init);
      });
      await mountReady();
      await change("Find a reviewed food", "oats");
      await click("Search");
      await click("Load more foods");
      expect(ingredientSearchNames()).toEqual(first.map((item) => item.name));
      expect(ingredientSearchStatus()).toContain("Choose Load more foods to retry this page");
      expect(button("Load more foods").props.disabled).toBe(false);
      await click("Load more foods");
      const reads = ingredientSearchReads(fetcher);
      expect(reads[2]?.[0]).toBe(reads[1]?.[0]);
      expect(ingredientSearchRows()).toHaveLength(22);
    },
  );

  it("requires explicit fresh Search after400 without claiming terminal exhaustion or retrying automatically", async () => {
    const { fetcher } = pagedIngredientFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      url.includes("cursor=page.one")
        ? Response.json({ error: "Cursor expired" }, { status: 400 })
        : original(url, init),
    );
    await mountReady();
    await change("Find a reviewed food", "oats");
    await click("Search");
    const more = button("Load more foods");
    await click("Load more foods");
    expect(ingredientSearchRows()).toHaveLength(20);
    expect(ingredientSearchStatus()).toContain("Search again for a fresh result set");
    expect(ingredientSearchStatus()).not.toContain("No more results");
    expect(hasButton("Load more foods")).toBe(false);
    const before = fetcher.mock.calls.length;
    invoke(more, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(ingredientSearchReads(fetcher)).toHaveLength(2);
    await click("Search");
    expect(ingredientSearchReads(fetcher)[2]?.[0]).not.toContain("cursor=");
  });

  it.each([200, 400, 401])(
    "ignores obsolete continuation status%s before JSON or UI effects",
    async (status) => {
      const { fetcher } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation());
      const pending = deferred<Response>(),
        replacement = deferred<Response>();
      fetcher.mockImplementation(async (url, init) => {
        if (url.includes("cursor=page.one")) return pending.promise;
        if (url.includes("query=barley")) return replacement.promise;
        return original(url, init);
      });
      await mountReady();
      await change("Find a reviewed food", "oats");
      await click("Search");
      await click("Load more foods");
      await change("Find a reviewed food", "barley");
      const retainedSearch = button("Search");
      await click("Search");
      const response = Response.json(
        { data: [ingredientSearchFood(70)], page: { nextCursor: null } },
        { status },
      );
      const json = vi.spyOn(response, "json");
      const before = fetcher.mock.calls.length;
      pending.resolve(response);
      await hooks.settle();
      expect(json).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(button("Searching…").props.disabled).toBe(true);
      invoke(retainedSearch, "onClick");
      invoke(button("Searching…"), "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(ingredientSearchRows()).toHaveLength(0);
      replacement.resolve(ingredientSearchPage([ingredientSearchFood(60)], "barley.next"));
      await hooks.settle();
      expect(ingredientSearchNames()).toEqual(["Reviewed food 60"]);
      expect(button("Load more foods").props.disabled).toBe(false);
      expect(ingredientSearchStatus()).not.toContain("Search again");
    },
  );

  it("ignores a delayed parsed body when a newer query already owns the results", async () => {
    const { fetcher } = pagedIngredientFetcher();
    const original = required(fetcher.getMockImplementation());
    const pending = deferred<unknown>();
    fetcher.mockImplementation(async (url, init) => {
      if (url.includes("cursor=page.one")) {
        const response = ingredientSearchPage([]);
        response.json = () => pending.promise;
        return response;
      }
      if (url.includes("query=barley")) return ingredientSearchPage([ingredientSearchFood(60)]);
      return original(url, init);
    });
    await mountReady();
    await change("Find a reviewed food", "oats");
    await click("Search");
    await click("Load more foods");
    await change("Find a reviewed food", "barley");
    await click("Search");
    const before = fetcher.mock.calls.length;
    pending.resolve(await ingredientSearchPage([ingredientSearchFood(70)]).json());
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(ingredientSearchNames()).toEqual(["Reviewed food 60"]);
  });

  it.each(["New", "copy", "open", "save", "route", "unmount"])(
    "fences retained search/Add/cursor controls after%s replaces the context",
    async (transition) => {
      const { fetcher } = pagedIngredientFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Find a reviewed food", "oats");
      await click("Search");
      const raw = field("Find a reviewed food"),
        add = ingredientSearchAdd(0),
        search = button("Search"),
        more = button("Load more foods");
      if (transition === "New") await click("New recipe");
      else if (transition === "copy") await click("Copy to new draft");
      else if (transition === "open") {
        openSaved();
        await hooks.settle();
      } else if (transition === "save") {
        save();
        await hooks.settle();
      } else if (transition === "route") {
        navigation.query = "date=2026-09-08";
        hooks.renderWithoutEffects();
      } else hooks.unmount();
      const before = fetcher.mock.calls.length,
        draft = editorValues(),
        beforeText = text(),
        updates = hooks.afterClose();
      invoke(raw, "onChange", { target: { value: "obsolete" } });
      invoke(add, "onClick");
      invoke(search, "onClick");
      invoke(more, "onClick");
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(hooks.afterClose()).toBe(updates);
      expect(editorValues()).toEqual(draft);
      expect(text()).toBe(beforeText);
      if (transition !== "unmount") expect(ingredientSearchRows()).toHaveLength(0);
    },
  );

  it("keeps results through ordinary builder edits but rejects old Add before allocation or success", async () => {
    const { fetcher } = pagedIngredientFetcher();
    await mountReady();
    await change("Find a reviewed food", "oats");
    await click("Search");
    const old = ingredientSearchAdd(0);
    await change("Name", "Changed builder");
    const originalCrypto = crypto,
      allocate = vi.fn(() => originalCrypto.randomUUID());
    vi.stubGlobal("crypto", { randomUUID: allocate });
    const before = fetcher.mock.calls.length,
      beforeText = text();
    invoke(old, "onClick");
    await hooks.settle();
    expect(allocate).not.toHaveBeenCalled();
    expect(text()).toBe(beforeText);
    expect(ingredientSearchRows()).toHaveLength(20);
    const add = ingredientSearchAdd(0),
      second = ingredientSearchAdd(1);
    invoke(add, "onClick");
    invoke(second, "onClick");
    await hooks.settle();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(text()).toContain("Ingredients (1/50)");
  });

  it("keeps the reviewed serving and50 ingredient guards for later-page controls", async () => {
    const { fetcher } = pagedIngredientFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      url.includes("cursor=page.one")
        ? ingredientSearchPage([ingredientSearchFood(30, { defaultServing: null })])
        : original(url, init),
    );
    await mountReady();
    expect(
      review().onConfirm(Array.from({ length: 49 }, (_, index) => ingredient(`cap-${index}`))),
    ).toBe(true);
    await hooks.settle();
    await change("Find a reviewed food", "oats");
    await click("Search");
    await click("Load more foods");
    expect(ingredientSearchAdd(20, "serving").props.disabled).toBe(true);
    invoke(ingredientSearchAdd(20, "serving"), "onClick");
    await hooks.settle();
    expect(text()).toContain("Ingredients (49/50)");
    invoke(ingredientSearchAdd(20), "onClick");
    await hooks.settle();
    expect(text()).toContain("Ingredients (50/50)");
    expect(ingredientSearchAdd(0).props.disabled).toBe(true);
    invoke(ingredientSearchAdd(0), "onClick");
    await hooks.settle();
    expect(text()).toContain("Ingredients (50/50)");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it.each(["owner", "profile"])(
    "rejects newly received search data after revalidation changes%s",
    async (changeScope) => {
      const { fetcher } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation());
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(optionalTimeLabel, "07:30");
      await change("Name", "Raw independent draft");
      fetcher.mockImplementation(async (url, init) => {
        if (url === "/api/auth/me") {
          if (changeScope === "owner") return session(secondRecipeId);
          const profile = await session().json();
          profile.data.profile.timeZone = "UTC";
          return Response.json(profile);
        }
        return original(url, init);
      });
      await change("Find a reviewed food", "oats");
      await click("Search");
      expect(ingredientSearchRows()).toHaveLength(0);
      if (changeScope === "owner") expect(router.replace).toHaveBeenCalledWith("/login");
      else {
        expect(ingredientSearchStatus()).toContain("Your profile changed");
        expect(hasButton("Load more foods")).toBe(false);
        expect(field(optionalTimeLabel).props.value).toBe("07:30");
        expect(field("Name").props.value).toBe("Raw independent draft");
      }
    },
  );

  it.each(["save", "log"])(
    "preserves pending%s body/key and log time through search and continuation",
    async (action) => {
      const { fetcher } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        init?.method === "POST"
          ? Response.json({ error: "Confirmation unavailable" }, { status: 503 })
          : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      await change(optionalTimeLabel, "07:30");
      await change("Amount", "1.250000");
      await change("Name", "Unsaved retry draft");
      if (action === "save") {
        save();
        await hooks.settle();
      } else await click("Log recipe");
      const sharedStatus = text(
        required(elements().find((node) => node.props.className === "workspaceStatus")),
      );
      await change("Find a reviewed food", "oats");
      await click("Search");
      await click("Load more foods");
      expect(field(optionalTimeLabel).props.value).toBe("07:30");
      expect(text()).toContain(sharedStatus);
      if (action === "save") {
        save();
        await hooks.settle();
      } else await click("Log recipe");
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.[1]?.body).toBe(writes[0]?.[1]?.body);
      expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
        new Headers(writes[0]?.[1]?.headers).get("idempotency-key"),
      );
      expect(field(optionalTimeLabel).props.value).toBe("07:30");
    },
  );
});

describe("ingredient continuation across live context changes", () => {
  it("installs a pending page into the same builder after ordinary raw edits without overwriting them", async () => {
    const { fetcher } = pagedIngredientFetcher();
    const original = required(fetcher.getMockImplementation()),
      pending = deferred<Response>();
    fetcher.mockImplementation(async (url, init) =>
      url.includes("cursor=page.one") ? pending.promise : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Find a reviewed food", "oats");
    await click("Search");
    await click("Load more foods");
    await change("Name", "Draft changed during paging");
    await change("Rolled oats quantity in grams", "9.000001");
    await change(optionalTimeLabel, "08:45");
    const draft = editorValues();
    pending.resolve(ingredientSearchPage([ingredientSearchFood(25)]));
    await hooks.settle();
    expect(ingredientSearchRows()).toHaveLength(21);
    expect(editorValues()).toEqual(draft);
    expect(field(optionalTimeLabel).props.value).toBe("08:45");
  });

  it.each(["route", "unmount", "open"])(
    "ignores delayed continuation expiry after %s replaces its context",
    async (transition) => {
      const { fetcher } = pagedIngredientFetcher();
      const original = required(fetcher.getMockImplementation()),
        pending = deferred<Response>();
      fetcher.mockImplementation(async (url, init) =>
        url.includes("cursor=page.one") ? pending.promise : original(url, init),
      );
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Find a reviewed food", "oats");
      await click("Search");
      await click("Load more foods");
      if (transition === "route") {
        navigation.query = "date=2026-09-08";
        hooks.renderWithoutEffects();
      } else if (transition === "unmount") hooks.unmount();
      else {
        openSaved();
        await hooks.settle();
      }
      const updates = hooks.afterClose(),
        before = fetcher.mock.calls.length;
      const response = Response.json({ error: "Old expiry" }, { status: 401 }),
        json = vi.spyOn(response, "json");
      pending.resolve(response);
      await hooks.settle();
      expect(json).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(hooks.afterClose()).toBe(updates);
      if (transition !== "unmount") expect(ingredientSearchRows()).toHaveLength(0);
    },
  );

  it("resets search on an installed zone conflict while preserving raw log time and ignoring the old page", async () => {
    const { fetcher } = pagedIngredientFetcher();
    const original = required(fetcher.getMockImplementation()),
      pending = deferred<Response>();
    let posted = false;
    fetcher.mockImplementation(async (url, init) => {
      if (url.includes("cursor=page.one")) return pending.promise;
      if (init?.method === "POST" && url.includes("/log?")) {
        posted = true;
        return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
      }
      if (url === "/api/auth/me" && posted) {
        const profile = await session().json();
        profile.data.profile.timeZone = "UTC";
        return Response.json(profile);
      }
      return original(url, init);
    });
    await mountReady();
    openSaved();
    await hooks.settle();
    await change(optionalTimeLabel, "07:30");
    await change("Name", "Keep raw draft");
    await change("Find a reviewed food", "oats");
    await click("Search");
    const retainedAdd = ingredientSearchAdd(0),
      retainedMore = button("Load more foods"),
      originalIngredients = ingredientValues();
    await click("Load more foods");
    await click("Log recipe");
    expect(field(optionalTimeLabel).props.value).toBe("07:30");
    expect(field("Name").props.value).toBe("Keep raw draft");
    expect(field("Find a reviewed food").props.value).toBe("");
    expect(ingredientSearchRows()).toHaveLength(0);
    const before = fetcher.mock.calls.length,
      currentText = text();
    invoke(retainedAdd, "onClick");
    invoke(retainedMore, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(ingredientValues()).toEqual(originalIngredients);
    expect(field("Local diary date").props.value).toBe("2026-09-09");
    expect(text()).toBe(currentText);
    pending.resolve(Response.json({ error: "Old search expiry" }, { status: 401 }));
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(router.replace).not.toHaveBeenCalled();
    expect(button("Confirm 2026-09-09 at 07:30 in UTC").props.disabled).toBe(false);
  });
});

const confirmNewLabel = "Discard edits and start new recipe";
const confirmOpenLabel = "Discard edits and open saved recipe";
function savedOpener() {
  return required(
    elements().find((node) => node.type === "button" && text(node).startsWith("Saved recipe")),
  );
}
function replacementSnapshot() {
  return {
    editor: editorValues(),
    ingredients: ingredientValues(),
    nutrition: nutritionRows(),
    log: ["Portion", "Amount", "Local diary date", optionalTimeLabel, "Meal"].map(
      (label) => field(label).props.value,
    ),
  };
}
async function dirtyRecipe() {
  await change("Name", "  Unsaved name  ");
  await change("Description", "  Exact description  ");
  await change("Instructions (optional)", "  Instructions\nunchanged  ");
  await change("Final yield grams", "999.000001");
  await change("Yield source", "measured");
  await change("Serving count (optional)", "4.000001");
  await change("Serving label", "plate");
  await change("Private sauce quantity in grams", "7.000001");
  await change("Private sauce note", "  Raw ingredient note  ");
  await moveRow(0, "down");
  await change("Portion", "grams");
  await change("Amount", "12.000001");
  await change("Local diary date", "2026-09-08");
  await change(optionalTimeLabel, "07:34");
  await click("Per 100 g");
}

describe("recipe draft replacement regressions", () => {
  it.each(["new", "open"])(
    "keeps a dirty builder intact and makes no request when choosing %s until explicit discard",
    async (action) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await dirtyRecipe();
      const before = replacementSnapshot(),
        requests = fetcher.mock.calls.length;
      const choose = async () => {
        if (action === "new") await click("New recipe");
        else {
          openSaved();
          await hooks.settle();
        }
      };
      await choose();
      expect(fetcher.mock.calls).toHaveLength(requests);
      expect(replacementSnapshot()).toEqual(before);
      expect(hasButton(action === "new" ? confirmNewLabel : confirmOpenLabel)).toBe(true);
      await click("Keep editing");
      expect(replacementSnapshot()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(requests);
      await choose();
      await click(action === "new" ? confirmNewLabel : confirmOpenLabel);
      if (action === "new") {
        expect(field("Name").props.value).toBe("");
        expect(ingredientValues()).toEqual([]);
        expect(reviewPresent()).toBe(true);
        expect(fetcher.mock.calls).toHaveLength(requests);
      } else {
        expect(field("Name").props.value).toBe("Saved recipe");
        expect(
          fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`),
        ).toHaveLength(2);
      }
    },
  );

  it.each(["503", "malformed"])(
    "retains the rejected builder through a pending and %s explicit Open",
    async (failure) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await dirtyRecipe();
      const before = replacementSnapshot();
      const original = required(fetcher.getMockImplementation()),
        pending = deferred<Response>();
      fetcher.mockImplementation((url, init) =>
        url === `/api/recipes/${recipeId}` ? pending.promise : original(url, init),
      );
      openSaved();
      await hooks.settle();
      await click(confirmOpenLabel);
      expect(replacementSnapshot()).toEqual(before);
      pending.resolve(
        failure === "503"
          ? Response.json({ error: "Saved recipe unavailable" }, { status: 503 })
          : Response.json({ data: "invalid saved recipe" }),
      );
      await hooks.settle();
      expect(replacementSnapshot()).toEqual(before);
      expect(button("Publish new revision").props.disabled).toBe(false);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("preserves a 412 rejected revision and expected revision without automatically loading server values", async () => {
    const { fetcher, source } = copyFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await dirtyRecipe();
    const before = replacementSnapshot();
    const reads = fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`).length;
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) => {
      if (init?.method === "POST")
        return Promise.resolve(
          Response.json({ error: "Recipe changed on another device" }, { status: 412 }),
        );
      if (url === `/api/recipes/${recipeId}`)
        return Promise.resolve(
          Response.json({
            data: {
              recipe: {
                ...source,
                revision: "2",
                currentVersion: {
                  ...source.currentVersion,
                  id: "07853b24-a267-4588-ad7d-a66f21d6fdfc",
                  versionNumber: 2,
                  name: "New server version",
                },
              },
            },
          }),
        );
      return original(url, init);
    });
    save();
    await hooks.settle();
    expect(replacementSnapshot()).toEqual(before);
    expect(fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`)).toHaveLength(
      reads,
    );
    expect(text()).toContain("Your edits are still here");
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
    expect(new Headers(posts[0]?.[1]?.headers).get("if-match")).toBe('"1"');
    expect(new Headers(posts[1]?.[1]?.headers).get("if-match")).toBe('"1"');
    expect(replacementSnapshot()).toEqual(before);
    openSaved();
    await hooks.settle();
    expect(fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`)).toHaveLength(
      reads,
    );
    await click("Keep editing");
    expect(replacementSnapshot()).toEqual(before);
    openSaved();
    await hooks.settle();
    await click(confirmOpenLabel);
    expect(field("Name").props.value).toBe("New server version");
  });

  it.each([
    ["save", "new"],
    ["save", "open"],
    ["log", "new"],
    ["log", "open"],
  ])(
    "blocks retained %s-time %s actions without interrupting the current request",
    async (write, replacement) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      const target = replacement === "new" ? button("New recipe") : savedOpener();
      const original = required(fetcher.getMockImplementation()),
        pending = deferred<Response>();
      fetcher.mockImplementation((url, init) =>
        init?.method === "POST" ? pending.promise : original(url, init),
      );
      if (write === "save") save();
      else invoke(button("Log recipe"), "onClick");
      await hooks.settle();
      const before = replacementSnapshot(),
        requests = fetcher.mock.calls.length;
      expect((replacement === "new" ? button("New recipe") : savedOpener()).props.disabled).toBe(
        true,
      );
      invoke(target, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(requests);
      expect(replacementSnapshot()).toEqual(before);
      expect(hasButton(confirmNewLabel)).toBe(false);
      expect(hasButton(confirmOpenLabel)).toBe(false);
      pending.resolve(Response.json({ error: "Ambiguous response" }, { status: 503 }));
      await hooks.settle();
      if (write === "save") save();
      else invoke(button("Log recipe"), "onClick");
      await hooks.settle();
      const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
      expect(new Headers(posts[1]?.[1]?.headers).get("idempotency-key")).toBe(
        new Headers(posts[0]?.[1]?.headers).get("idempotency-key"),
      );
    },
  );
});

async function chooseReplacement(action: "new" | "open") {
  if (action === "new") await click("New recipe");
  else {
    openSaved();
    await hooks.settle();
  }
}
function replacementLabel(action: "new" | "open") {
  return action === "new" ? confirmNewLabel : confirmOpenLabel;
}

describe("recipe replacement choice lifecycle", () => {
  it.each(["new", "open"] as const)(
    "protects populated new drafts before %s and retires their transfer callbacks only on explicit discard",
    async (action) => {
      const fetcher = readyFetcher();
      await mountReady();
      const child = review();
      expect(child.onConfirm([ingredient("draft", "0.000001")])).toBe(true);
      await hooks.settle();
      await change("Name", "  New draft  ");
      await change("Final yield grams", "1.000001");
      const before = editorValues(),
        requests = fetcher.mock.calls.length;
      await chooseReplacement(action);
      expect(editorValues()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(requests);
      await click("Keep editing");
      expect(editorValues()).toEqual(before);
      expect(review().ownerUserId).toBe(child.ownerUserId);
      await chooseReplacement(action);
      await click(replacementLabel(action));
      expect(child.onConfirm([ingredient("obsolete")])).toBe(false);
      await hooks.settle();
      expect(field("Name").props.value).toBe(action === "new" ? "" : "Saved recipe");
    },
  );

  it.each(["new", "open"] as const)(
    "detects each editable field independently for %s and restores direct actions when the exact baseline returns",
    async (action) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      const requests = fetcher.mock.calls.length;
      for (const label of [
        "Name",
        "Description",
        "Instructions (optional)",
        "Final yield grams",
        "Serving count (optional)",
        "Serving label",
        "Private sauce quantity in grams",
        "Private sauce note",
      ]) {
        const original = String(field(label).props.value);
        await change(label, `${original} `);
        const before = replacementSnapshot();
        await chooseReplacement(action);
        expect(hasButton(replacementLabel(action))).toBe(true);
        await click("Keep editing");
        expect(replacementSnapshot()).toEqual(before);
        await change(label, original);
      }
      await change("Yield source", "measured");
      await chooseReplacement(action);
      expect(hasButton(replacementLabel(action))).toBe(true);
      await click("Keep editing");
      await change("Yield source", "estimated");
      await moveRow(0, "down");
      const reordered = ingredientValues();
      await chooseReplacement(action);
      expect(hasButton(replacementLabel(action))).toBe(true);
      await click("Keep editing");
      expect(ingredientValues()).toEqual(reordered);
      await moveRow(1, "up");
      expect(fetcher.mock.calls).toHaveLength(requests);
      await chooseReplacement(action);
      expect(hasButton(confirmNewLabel)).toBe(false);
      expect(hasButton(confirmOpenLabel)).toBe(false);
      expect(field("Name").props.value).toBe(action === "new" ? "" : "Saved recipe");
    },
  );

  it.each([
    ["new", "edit-restore"],
    ["open", "edit-restore"],
    ["new", "competing-target"],
    ["open", "competing-target"],
    ["new", "save"],
    ["open", "save"],
    ["new", "owner"],
    ["open", "owner"],
    ["new", "route"],
    ["open", "route"],
    ["new", "unmount"],
    ["open", "unmount"],
  ] as const)(
    "rejects retained %s discard and Keep after %s replaces the choice scope",
    async (action, transition) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Name", "Protected draft");
      await chooseReplacement(action);
      const discard = button(replacementLabel(action)),
        keep = button("Keep editing");
      let currentChoice: string | null = null;
      if (transition === "edit-restore") {
        await change("Name", "Later raw draft");
        await change("Name", "Protected draft");
        await chooseReplacement(action);
        currentChoice = replacementLabel(action);
      } else if (transition === "competing-target") {
        const other = action === "new" ? "open" : "new";
        await chooseReplacement(other);
        currentChoice = replacementLabel(other);
      } else if (transition === "save") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation((url, init) =>
          init?.method === "POST"
            ? Promise.resolve(Response.json({ error: "Ambiguous revision" }, { status: 503 }))
            : original(url, init),
        );
        save();
        invoke(discard, "onClick");
        invoke(keep, "onClick");
        await hooks.settle();
        expect(field("Name").props.value).toBe("Protected draft");
      } else if (transition === "owner") {
        const original = required(fetcher.getMockImplementation());
        fetcher.mockImplementation((url, init) =>
          url === "/api/auth/me"
            ? Promise.resolve(session("a3fd8855-90c8-42df-8f21-2f5a4060fa08"))
            : original(url, init),
        );
        hooks.replayEffects();
        await hooks.settle();
        expect(router.replace).toHaveBeenCalledWith("/login");
      } else if (transition === "route") {
        navigation.query = "date=2026-09-10";
        hooks.render();
        await hooks.settle();
      } else hooks.unmount();
      const before = editorValues(),
        rendered = text(),
        requests = fetcher.mock.calls.length,
        updates = hooks.afterClose();
      invoke(discard, "onClick");
      invoke(keep, "onClick");
      await hooks.settle();
      expect(editorValues()).toEqual(before);
      expect(text()).toBe(rendered);
      expect(fetcher.mock.calls).toHaveLength(requests);
      expect(hooks.afterClose()).toBe(updates);
      if (currentChoice) expect(hasButton(currentChoice)).toBe(true);
    },
  );

  it.each(["new", "open"] as const)(
    "accepts a %s discard only once before paint and never revives the old choice",
    async (action) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await change("Name", "Protected draft");
      await chooseReplacement(action);
      const discard = button(replacementLabel(action)),
        keep = button("Keep editing");
      const original = required(fetcher.getMockImplementation()),
        pending = deferred<Response>();
      const reads = fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`).length;
      if (action === "open")
        fetcher.mockImplementation((url, init) =>
          url === `/api/recipes/${recipeId}` ? pending.promise : original(url, init),
        );
      invoke(discard, "onClick");
      invoke(discard, "onClick");
      invoke(keep, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls.filter(([url]) => url === `/api/recipes/${recipeId}`)).toHaveLength(
        reads + (action === "open" ? 1 : 0),
      );
      if (action === "open") {
        pending.resolve(detail());
        await hooks.settle();
      }
      await change("Name", "Later draft survives old choice");
      const requests = fetcher.mock.calls.length;
      invoke(discard, "onClick");
      invoke(keep, "onClick");
      await hooks.settle();
      expect(field("Name").props.value).toBe("Later draft survives old choice");
      expect(fetcher.mock.calls).toHaveLength(requests);
    },
  );

  it.each(["save", "log"] as const)(
    "preserves exact ambiguous %s bodies and operation IDs across opened and declined New/Open choices",
    async (action) => {
      const { fetcher } = copyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      await dirtyRecipe();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        init?.method === "POST"
          ? Promise.resolve(Response.json({ error: "Ambiguous write" }, { status: 503 }))
          : original(url, init),
      );
      const submit = async () => {
        if (action === "save") save();
        else invoke(button("Log recipe"), "onClick");
        await hooks.settle();
      };
      await submit();
      const before = replacementSnapshot(),
        requests = fetcher.mock.calls.length;
      for (const replacement of ["new", "open"] as const) {
        await chooseReplacement(replacement);
        expect(replacementSnapshot()).toEqual(before);
        await click("Keep editing");
        expect(replacementSnapshot()).toEqual(before);
      }
      expect(fetcher.mock.calls).toHaveLength(requests);
      await submit();
      const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
      expect(new Headers(posts[1]?.[1]?.headers).get("idempotency-key")).toBe(
        new Headers(posts[0]?.[1]?.headers).get("idempotency-key"),
      );
      expect(new Headers(posts[1]?.[1]?.headers).get("if-match")).toBe(
        action === "save" ? '"1"' : null,
      );
    },
  );

  it("retires an Open choice when its target is replaced by a refreshed saved list", async () => {
    const { fetcher } = copyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url.startsWith("/api/recipes?")
        ? Promise.resolve(
            filterCollection(
              [nutritionRecipe({ version: url.includes("cursor=next") ? 2 : 1 })],
              url.includes("cursor=next") ? null : "next",
            ),
          )
        : original(url, init),
    );
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Name", "Protected old selection");
    await chooseReplacement("open");
    const discard = button(confirmOpenLabel),
      keep = button("Keep editing");
    await click("Load more recipes");
    const requests = fetcher.mock.calls.length,
      before = replacementSnapshot();
    invoke(discard, "onClick");
    invoke(keep, "onClick");
    await hooks.settle();
    expect(hasButton(confirmOpenLabel)).toBe(false);
    expect(replacementSnapshot()).toEqual(before);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });
});

it("focuses Keep editing for each new replacement choice without refocusing ordinary renders", async () => {
  copyFetcher();
  await mountReady();
  openSaved();
  await hooks.settle();
  await change("Name", "Retained draft");
  invoke(button("New recipe"), "onClick");
  hooks.renderWithoutEffects();
  const focus = vi.fn();
  (button("Keep editing").props.ref as { current: unknown }).current = { focus };
  await hooks.settle();
  hooks.render();
  expect(focus).toHaveBeenCalledOnce();
  await change("Amount", "2");
  await click("Per 100 g");
  hooks.render();
  expect(focus).toHaveBeenCalledOnce();
  openSaved();
  await hooks.settle();
  expect(focus).toHaveBeenCalledTimes(2);
  await click("Keep editing");
  expect(focus).toHaveBeenCalledTimes(2);
  expect(field("Name").props.value).toBe("Retained draft");
});

function myFoodsPicker(): MyFoodIngredientPickerProps {
  const found = elements().find((node) => node.type === MyFoodIngredientPicker);
  if (!found) throw new Error("Missing My foods ingredient picker.");
  return found.props as unknown as MyFoodIngredientPickerProps;
}
const personalFood: CustomFood = {
  id: "58c25730-1f6d-42c8-a411-0ee89f560623",
  status: "active",
  revision: "7",
  createdAt: timestamp,
  updatedAt: timestamp,
  currentVersion: {
    id: "9007199254740993",
    versionNumber: 7,
    name: "Personal oats",
    brandName: "Owner brand",
    notes: "Private food notes",
    serving: { id: "9007199254740995", label: "scoop", grams: "40.125001" },
    nutrients: [
      {
        nutrient: { id: "1", code: "protein", name: "Protein", unit: "g" },
        state: "unknown",
        amountPer100Grams: null,
        reason: "not_analyzed",
      },
    ],
    provenance: { kind: "user_entered", statement: "Entered by the owner." },
    createdAt: timestamp,
  },
};

describe("actual recipe builder My foods integration", () => {
  it("pins a personal food version with private attribution and exact recipe payload", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    expect(myFoodsPicker().ownerUserId).toBe(owner);
    expect(myFoodsPicker().date).toBe("2026-09-09");
    expect(myFoodsPicker().remainingCapacity).toBe(50);
    expect(myFoodsPicker().onAdd(personalFood, "grams")).toBe(true);
    await hooks.settle();
    expect(field("Personal oats quantity in grams").props.value).toBe("100");
    expect(text()).toContain("Owner-entered private custom food · pinned version 7");
    expect(text()).not.toContain("USDA FoodData Central");
    await change("Personal oats quantity in grams", "999999999999.999999");
    await change("Name", "Personal breakfast");
    await change("Final yield grams", "0.000001");
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(required(posts[0])[1]?.body))).toEqual({
      name: "Personal breakfast",
      description: null,
      instructions: null,
      ingredients: [
        {
          kind: "food",
          foodVersionId: personalFood.currentVersion.id,
          portion: { kind: "grams", grams: "999999999999.999999" },
          position: 0,
          note: null,
        },
      ],
      finalYield: { grams: "0.000001", source: "measured" },
      servingCount: null,
      servingLabel: null,
    });
  });
});

describe("My foods ingredient transfer fences", () => {
  it("mounts lazily for both new and saved recipes without any private food or nutrient request", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    expect(myFoodsPicker().disabled).toBe(false);
    openSaved();
    await hooks.settle();
    expect(myFoodsPicker().ownerUserId).toBe(owner);
    expect(myFoodsPicker().remainingCapacity).toBe(49);
    expect(myFoodsPicker().disabled).toBe(false);
    expect(
      fetcher.mock.calls.some(([url]) => url.includes("custom-foods") || url.includes("nutrients")),
    ).toBe(false);
  });

  it("keeps exact serving IDs and decimal strings through notes, reorder and removal", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    myFoodsPicker().onAdd(personalFood, "grams");
    await hooks.settle();
    myFoodsPicker().onAdd(personalFood, "serving");
    await hooks.settle();
    expect(field("Personal oats quantity in scoop").props.value).toBe("1");
    await change("Personal oats quantity in scoop", "0.000001");
    const notes = elements().filter((node) => node.props["aria-label"] === "Personal oats note");
    invoke(required(notes[1]), "onChange", { target: { value: "  Raw serving note\nkept  " } });
    await hooks.settle();
    invoke(field("Move Personal oats up from position 2 of 2"), "onClick");
    await hooks.settle();
    invoke(field("Remove Personal oats at position 2 of 2"), "onClick");
    await hooks.settle();
    expect(text()).toContain("Ingredients (1/50)");
    await change("Name", "Serving recipe");
    await change("Final yield grams", "40.125001");
    save();
    await hooks.settle();
    const post = required(fetcher.mock.calls.find(([, init]) => init?.method === "POST"));
    expect(JSON.parse(String(post[1]?.body)).ingredients).toEqual([
      {
        kind: "food",
        foodVersionId: personalFood.currentVersion.id,
        portion: {
          kind: "serving",
          servingId: personalFood.currentVersion.serving?.id,
          amount: "0.000001",
        },
        position: 0,
        note: "  Raw serving note\nkept  ",
      },
    ]);
  });

  it("pins the earlier ingredient when a refreshed choice adds the newer version", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    expect(myFoodsPicker().onAdd(personalFood, "serving")).toBe(true);
    await hooks.settle();
    const newer: CustomFood = {
      ...personalFood,
      revision: "8",
      currentVersion: {
        ...personalFood.currentVersion,
        id: "9007199254740997",
        versionNumber: 8,
        serving: { id: "9007199254740999", label: "new scoop", grams: "41.000001" },
      },
    };
    expect(myFoodsPicker().onAdd(newer, "serving")).toBe(true);
    await hooks.settle();
    expect(text()).toContain("pinned version 7");
    expect(text()).toContain("pinned version 8");
    expect(field("Personal oats quantity in scoop").props.value).toBe("1");
    expect(field("Personal oats quantity in new scoop").props.value).toBe("1");
    await change("Name", "Both versions");
    await change("Final yield grams", "100");
    save();
    await hooks.settle();
    const post = required(fetcher.mock.calls.find(([, init]) => init?.method === "POST"));
    expect(JSON.parse(String(post[1]?.body)).ingredients).toEqual([
      {
        kind: "food",
        foodVersionId: "9007199254740993",
        portion: { kind: "serving", servingId: "9007199254740995", amount: "1" },
        position: 0,
        note: null,
      },
      {
        kind: "food",
        foodVersionId: "9007199254740997",
        portion: { kind: "serving", servingId: "9007199254740999", amount: "1" },
        position: 1,
        note: null,
      },
    ]);
  });

  it("enforces the 50 ingredient limit synchronously across retained add callbacks", async () => {
    readyFetcher();
    await mountReady();
    review().onConfirm(Array.from({ length: 49 }, (_, index) => ingredient(`filled-${index}`)));
    await hooks.settle();
    const add = myFoodsPicker().onAdd;
    expect(add(personalFood, "grams")).toBe(true);
    expect(add(personalFood, "grams")).toBe(false);
    await hooks.settle();
    expect(myFoodsPicker().remainingCapacity).toBe(0);
    expect(text()).toContain("Ingredients (50/50)");
  });

  it("rejects archived foods and absent servings before allocating ingredient keys", async () => {
    readyFetcher();
    await mountReady();
    const randomUUID = vi.fn(() => "78502e2b-a5c8-4345-aa26-1df33584008e");
    vi.stubGlobal("crypto", { randomUUID });
    expect(myFoodsPicker().onAdd({ ...personalFood, status: "archived" }, "grams")).toBe(false);
    expect(
      myFoodsPicker().onAdd(
        { ...personalFood, currentVersion: { ...personalFood.currentVersion, serving: null } },
        "serving",
      ),
    ).toBe(false);
    expect(randomUUID).not.toHaveBeenCalled();
    expect(text()).toContain("Ingredients (0/50)");
  });

  it.each(["new", "open", "route", "closed", "unmounted"] as const)(
    "rejects retained personal-food insertion after %s without a new key or state update",
    async (transition) => {
      readyFetcher();
      await mountReady();
      const retained = myFoodsPicker().onAdd;
      if (transition === "new") await click("New recipe");
      if (transition === "open") {
        openSaved();
        await hooks.settle();
      }
      if (transition === "route") {
        navigation.query = "date=2026-09-10";
        hooks.render();
        await hooks.settle();
      }
      if (transition === "closed") {
        myFoodsPicker().onSessionClosed();
        await hooks.settle();
      }
      if (transition === "unmounted") hooks.unmount();
      const randomUUID = vi.fn(() => "78502e2b-a5c8-4345-aa26-1df33584008e");
      vi.stubGlobal("crypto", { randomUUID });
      const updates = hooks.afterClose();
      expect(retained(personalFood, "grams")).toBe(false);
      await hooks.settle();
      expect(randomUUID).not.toHaveBeenCalled();
      expect(hooks.afterClose()).toBe(updates);
      expect(text()).not.toContain("Personal oats");
      if (transition === "closed") expect(router.replace).toHaveBeenCalledWith("/login");
    },
  );

  it.each(["save", "log"] as const)(
    "blocks personal-food insertion throughout an in-flight %s",
    async (operation) => {
      const fetcher = readyFetcher();
      await mountReady();
      openSaved();
      await hooks.settle();
      const retained = myFoodsPicker().onAdd;
      const pending = deferred<Response>(),
        original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation((url, init) =>
        init?.method === "POST" ? pending.promise : original(url, init),
      );
      if (operation === "save") save();
      else invoke(button("Log recipe"), "onClick");
      expect(retained(personalFood, "grams")).toBe(false);
      await hooks.settle();
      expect(myFoodsPicker().disabled).toBe(true);
      expect(myFoodsPicker().onAdd(personalFood, "serving")).toBe(false);
      expect(text()).toContain("Ingredients (1/50)");
      pending.resolve(Response.json({ error: "Ambiguous write" }, { status: 503 }));
      await hooks.settle();
      expect(myFoodsPicker().disabled).toBe(false);
    },
  );

  it("retains the original exact save operation after later additions are removed", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    myFoodsPicker().onAdd(personalFood, "serving");
    await hooks.settle();
    await change("Personal oats quantity in scoop", "2.000001");
    await change("Name", "Retry unchanged pins");
    await change("Final yield grams", "100.000001");
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      init?.method === "POST"
        ? Promise.resolve(Response.json({ error: "Lost receipt" }, { status: 503 }))
        : original(url, init),
    );
    save();
    await hooks.settle();
    myFoodsPicker().onAdd(
      {
        ...personalFood,
        currentVersion: {
          ...personalFood.currentVersion,
          id: "9007199254740997",
          versionNumber: 8,
        },
      },
      "grams",
    );
    await hooks.settle();
    invoke(field("Remove Personal oats at position 2 of 2"), "onClick");
    await hooks.settle();
    save();
    await hooks.settle();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
    expect(new Headers(posts[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(posts[0]?.[1]?.headers).get("idempotency-key"),
    );
    expect(JSON.parse(String(posts[1]?.[1]?.body)).ingredients[0]).toMatchObject({
      foodVersionId: "9007199254740993",
      portion: { kind: "serving", servingId: "9007199254740995", amount: "2.000001" },
    });
  });
});

describe("passive recipe serving and yield amounts", () => {
  it.each([
    ["150.000000", "150"],
    ["123456789012.123450", "123456789012.12345"],
    ["0.000001", "0.000001"],
  ])("formats %s metadata without changing editor or retry quantities", async (raw, shown) => {
    const saved = recipeWire();
    saved.currentVersion.finalYield.grams = raw;
    const selectedFood = { ...food, defaultServing: { ...food.defaultServing, gramWeight: raw } };
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST")
        return Response.json({ error: "Synthetic unavailable" }, { status: 503 });
      if (url.startsWith("/api/recipes?")) {
        const page = await collection().json();
        page.data[0].currentVersion.finalYield.grams = raw;
        return Response.json(page);
      }
      if (url === `/api/recipes/${recipeId}`) return Response.json({ data: { recipe: saved } });
      if (url.startsWith("/api/foods/search?")) return ingredientSearchPage([selectedFood]);
      return original(url, init);
    });
    await mountReady();
    expect(text()).toContain(`v1 · ${shown} g yield`);
    expect(text()).toContain(`Version 1 · ${shown} g yield`);
    const pin = field("Pin 100 g of Saved recipe version 1");
    expect(text(pin)).toBe("Add 100 g");
    expect(pin.props["aria-label"]).toBe("Pin 100 g of Saved recipe version 1");
    openSaved();
    await hooks.settle();
    expect(field("Final yield grams").props.value).toBe(raw);
    await change("Find a reviewed food", "oats");
    await click("Search");
    expect(text(required(ingredientSearchRows()[0]))).toContain(`scoop · ${shown} g`);
    await click("Add serving");
    await change("Rolled oats quantity in scoop", "2.500000");
    expect(field("Rolled oats quantity in scoop").props.value).toBe("2.500000");
    expect(field("Final yield grams").props.value).toBe(raw);
    save();
    await hooks.settle();
    save();
    await hooks.settle();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(
      writes.map(([url, init]) => ({
        url,
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      })),
    ).toEqual(
      Array(2).fill({
        url: writes[0]?.[0],
        method: writes[0]?.[1]?.method,
        headers: writes[0]?.[1]?.headers,
        body: writes[0]?.[1]?.body,
      }),
    );
    const body = JSON.parse(String(writes[0]?.[1]?.body));
    expect(body.finalYield).toEqual({ grams: raw, source: "measured" });
    expect(body.ingredients[1].portion).toEqual({
      kind: "serving",
      servingId: "303",
      amount: "2.500000",
    });
    expect(field("Final yield grams").props.value).toBe(raw);
    expect(field("Rolled oats quantity in scoop").props.value).toBe("2.500000");
  });
});

describe("actual recipe session recovery", () => {
  it.each(["server", "network", "malformed"] as const)(
    "rechecks a failed %s session before requesting recipes",
    async (failure) => {
      const pending = deferred<Response>();
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      let auth = 0;
      fetcher.mockImplementation(async (url, init) => {
        if (url === "/api/auth/me") {
          auth += 1;
          if (auth === 1) {
            if (failure === "network") throw new TypeError("Synthetic offline session");
            return failure === "server"
              ? new Response(null, { status: 503 })
              : Response.json({ data: { user: { id: owner } } });
          }
          if (auth === 2) return pending.promise;
        }
        return original(url, init);
      });
      hooks.mount(RecipesClient);
      await hooks.settle();
      expect(text()).toContain("Your private recipe session could not be verified.");
      // Exercise the displayed recovery action on both the old and corrected UI.
      const retry = required(
        elements().find(
          (node) => node.type === "button" && /^Retry (session|recipes)$/u.test(text(node)),
        ),
      );
      invoke(retry, "onClick");
      await hooks.settle();
      expect(auth).toBe(2);
      expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/recipes?"))).toHaveLength(0);
      pending.resolve(session());
      await hooks.settle();
      expect(review().ownerUserId).toBe(owner);
      expect(savedRecipeNames()).toEqual(["Saved recipe"]);
      openSaved();
      await hooks.settle();
      expect(field("Local diary date").props.value).toBe("2026-09-09");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("uses the verified profile date and meal when the initial route has no date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T01:00:00.000Z"));
    navigation.query = "";
    const fetcher = readyFetcher();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    hooks.mount(RecipesClient);
    await hooks.settle();
    await click("Retry session");
    openSaved();
    await hooks.settle();
    expect(field("Local diary date").props.value).toBe("2026-09-27");
    expect(field("Meal").props.value).toBe("dinner");
  });

  it("ignores duplicate and retained retry callbacks without resetting newer edits", async () => {
    const pending = deferred<Response>();
    const fetcher = readyFetcher();
    fetcher
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockReturnValueOnce(pending.promise);
    hooks.mount(RecipesClient);
    await hooks.settle();
    const retry = button("Retry session");
    invoke(retry, "onClick");
    invoke(retry, "onClick");
    await hooks.settle();
    invoke(retry, "onClick");
    expect(fetcher).toHaveBeenCalledTimes(2);
    pending.resolve(session());
    await hooks.settle();
    await change("Name", "Newer private draft");
    const count = fetcher.mock.calls.length;
    invoke(retry, "onClick");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(field("Name").props.value).toBe("Newer private draft");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("rejects an old retry before route effects and after returning to the same date", async () => {
    const fetcher = readyFetcher();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    hooks.mount(RecipesClient);
    await hooks.settle();
    const retry = button("Retry session");
    navigation.query = "date=2026-09-10";
    hooks.renderWithoutEffects();
    invoke(retry, "onClick");
    expect(fetcher).toHaveBeenCalledTimes(1);
    hooks.render();
    await hooks.settle();
    openSaved();
    await hooks.settle();
    expect(field("Local diary date").props.value).toBe("2026-09-10");
    navigation.query = "date=2026-09-09";
    hooks.render();
    await hooks.settle();
    await change("Name", "Current route draft");
    const count = fetcher.mock.calls.length;
    invoke(retry, "onClick");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(field("Name").props.value).toBe("Current route draft");
  });

  it.each(["route", "effect replay", "unmount", "closed"] as const)(
    "cannot install a delayed retry JSON after %s",
    async (transition) => {
      const pending = deferred<unknown>();
      const response = session("c95d87b0-0975-4bdb-87aa-eef8b614b186");
      response.json = () => pending.promise;
      const fetcher = readyFetcher();
      await mountReady();
      const close = review().onSessionClosed;
      fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
      navigation.query = "date=2026-09-10";
      hooks.render();
      await hooks.settle();
      fetcher.mockResolvedValueOnce(response);
      const retry = button("Retry session");
      const retryIndex = fetcher.mock.calls.length;
      invoke(retry, "onClick");
      await hooks.settle();
      const signal = required(fetcher.mock.calls[retryIndex]?.[1]?.signal ?? undefined);
      if (transition === "route") {
        navigation.query = "date=2026-09-11";
        hooks.render();
      } else if (transition === "effect replay") hooks.replayEffects();
      else if (transition === "closed") close();
      else hooks.unmount();
      await hooks.settle();
      const count = fetcher.mock.calls.length;
      const afterClose = hooks.afterClose();
      pending.resolve(await session("c95d87b0-0975-4bdb-87aa-eef8b614b186").json());
      await hooks.settle();
      invoke(retry, "onClick");
      await hooks.settle();
      expect(signal.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(hooks.afterClose()).toBe(afterClose);
      if (transition === "route" || transition === "effect replay") {
        expect(review().ownerUserId).toBe(owner);
        expect(router.replace).not.toHaveBeenCalled();
      } else if (transition === "closed") expect(router.replace).toHaveBeenCalledWith("/login");
    },
  );

  it("closes on a retry 401 and leaves the retained retry inert", async () => {
    const fetcher = readyFetcher();
    fetcher
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    hooks.mount(RecipesClient);
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    expect(router.replace).toHaveBeenCalledWith("/login");
    invoke(retry, "onClick");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reviewPresent()).toBe(false);
  });

  it("closes rather than adopting a replacement owner during route-session recovery", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    await change("Name", "Original owner draft");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    navigation.query = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    fetcher.mockResolvedValueOnce(session("c95d87b0-0975-4bdb-87aa-eef8b614b186"));
    const count = fetcher.mock.calls.length;
    await click("Retry session");
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(field("Name").props.value).toBe("");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("keeps list failures on the existing owner-fenced recipe retry", async () => {
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    let lists = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (url.startsWith("/api/recipes?") && ++lists === 1)
        return new Response(null, { status: 503 });
      return original(url, init);
    });
    hooks.mount(RecipesClient);
    await hooks.settle();
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Retry session"),
    ).toBe(false);
    await click("Retry recipes");
    expect(lists).toBe(2);
    expect(savedRecipeNames()).toEqual(["Saved recipe"]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/me",
      "/api/recipes?limit=50",
      "/api/recipes?limit=50",
      "/api/auth/me",
    ]);
  });

  it("preserves a dirty builder and pending save through session recovery without replaying the write", async () => {
    const fetcher = readyFetcher();
    await mountReady();
    review().onConfirm([ingredient("saved", "12.000001")]);
    await hooks.settle();
    await change("Name", "Retryable draft");
    await change("Description", "Keep this description");
    await change("Instructions (optional)", "Keep these steps");
    await change("Final yield grams", "10.000001");
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) =>
      init?.method === "POST" ? new Response(null, { status: 503 }) : original(url, init),
    );
    save();
    await hooks.settle();
    const first = required(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")[0]);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    navigation.query = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    await click("Retry session");
    expect(field("Name").props.value).toBe("Retryable draft");
    expect(field("Description").props.value).toBe("Keep this description");
    expect(field("Instructions (optional)").props.value).toBe("Keep these steps");
    expect(field("Final yield grams").props.value).toBe("10.000001");
    expect(text()).toContain("Ingredients (1/50)");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    save();
    await hooks.settle();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.body).toBe(first[1]?.body);
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
  });

  it("preserves pending log intent and destination choices without replaying the write", async () => {
    const fetcher = retryableLogFetcher();
    await mountReady();
    openSaved();
    await hooks.settle();
    await change("Meal", "snacks");
    await change("Amount", "1.250000");
    await change(optionalTimeLabel, "07:30");
    await click("Log recipe");
    const [, first] = required(recipeLogPosts(fetcher)[0]);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    navigation.query = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    await click("Retry session");
    expect(recipeLogPosts(fetcher)).toHaveLength(1);
    expect(field("Meal").props.value).toBe("snacks");
    expect(field("Amount").props.value).toBe("1.250000");
    expect(field("Local diary date").props.value).toBe("2026-09-10");
    // Route replacement still clears optional time; retry does not discard the pending operation.
    expect(field(optionalTimeLabel).props.value).toBe("");
    await change("Local diary date", "2026-09-09");
    await change(optionalTimeLabel, "07:30");
    await click("Log recipe");
    const writes = recipeLogPosts(fetcher);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.body).toBe(first?.body);
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first?.headers).get("idempotency-key"),
    );
  });
});

it("rejects retained recipe-list retries while a replacement route needs session recovery", async () => {
  const fetcher = readyFetcher();
  fetcher
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  hooks.mount(RecipesClient);
  await hooks.settle();
  const retry = button("Retry recipes");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
  navigation.query = "date=2026-09-10";
  hooks.render();
  await hooks.settle();
  const count = fetcher.mock.calls.length;
  invoke(retry, "onClick");
  await hooks.settle();
  expect(fetcher).toHaveBeenCalledTimes(count);
  await click("Retry session");
  expect(savedRecipeNames()).toEqual(["Saved recipe"]);
});
