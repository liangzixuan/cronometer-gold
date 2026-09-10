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
  const render = () => {
    cursor = 0;
    dirty = false;
    tree = component();
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

import { type DiaryNutrient, localDateInTimeZone } from "../../lib/diary";
import type { FoodSearchHit } from "../../lib/food-search";
import { parseRecipeResponse, type RecipeIngredientDraft } from "../../lib/recipes-goals";
import { PastedIngredientReview } from "./PastedIngredientReview";
import { RecipesClient } from "./RecipesClient";

interface ElementNode {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function elements(value: unknown = hooks.tree()): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item ?? null));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ElementNode;
  return [node, ...elements(node.props.children ?? null)];
}
function text(value: unknown = hooks.tree()): string {
  if (Array.isArray(value)) return value.map((item) => text(item ?? null)).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  return text((value as ElementNode).props.children ?? null);
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

  it("cannot install a delayed save receipt into a new workspace", async () => {
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
    await change("Name", "Second draft survives");
    pendingJson.resolve(await mutation("Stale saved receipt").json());
    await hooks.settle();
    expect(field("Name").props.value).toBe("Second draft survives");
    expect(reviewPresent()).toBe(true);
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
      ["Partial nutrient", "Partial · 1/2 contributions quantified", "≥ 74.0740734 g"],
      ["Trace nutrient", "Complete coverage · includes trace values", "≥ 0 g"],
    ]);
    const calls = fetcher.mock.calls.length;
    await click("Per 100 g");
    expect(button("Per 100 g").props["aria-pressed"]).toBe(true);
    expect(button("Per serving (bowl)").props["aria-pressed"]).toBe(false);
    expect(nutritionRows()[2]).toEqual([
      "Partial nutrient",
      "Partial · 1/2 contributions quantified",
      "≥ 123.456789 g",
    ]);
    await click("Per serving (bowl)");
    expect(nutritionRows()[2]?.[2]).toBe("≥ 74.0740734 g");
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
    expect(nutritionRows()[2]?.[2]).toBe("≥ 123.456789 g");
    await change("Serving count (optional)", "3");
    await change("Serving label", "plate");
    expect(
      elements().some((node) => node.type === "button" && text(node).startsWith("Per serving")),
    ).toBe(false);
    expect(nutritionRows()[2]?.[2]).toBe("≥ 123.456789 g");
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
