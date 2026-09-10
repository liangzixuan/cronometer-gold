import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the actual component and its effects with deterministic synchronous hooks.
// This observes native callbacks/request transitions; native rendering, concurrent
// React, assistive technology and signed devices remain separate evidence.
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

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));

const nativeState = vi.hoisted(() => ({
  current: "active",
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  AppState: {
    get currentState() {
      return nativeState.current;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      nativeState.listeners.add(listener);
      return { remove: () => nativeState.listeners.delete(listener) };
    },
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../auth/operation-id", () => ({ newOperationId: () => crypto.randomUUID() }));

import type { FoodSearchHit } from "../search/food-search";
import { PastedIngredientReview, type PastedIngredientReviewProps } from "./PastedIngredientReview";
import type { RecipeIngredientDraft } from "./recipes-goals";

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
  const found = elements().find((node) => node.type === "Pressable" && text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function field(label: string): ElementNode {
  const found = elements().find((node) => node.props.accessibilityLabel === label);
  if (!found) throw new Error(`Missing field: ${label}`);
  return found;
}
function invoke(node: ElementNode, action: string, ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node, "onPress");
  await hooks.settle();
}
async function change(label: string, value: string) {
  if (label.startsWith("Quantity type for line ")) {
    await click(value === "serving" ? "Reviewed serving" : "Grams");
    return;
  }
  invoke(field(label), "onChangeText", value);
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
const anotherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
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

let props: PastedIngredientReviewProps;
let onConfirm: ReturnType<typeof vi.fn<(ingredients: readonly RecipeIngredientDraft[]) => boolean>>;
let onSessionClosed: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  nativeState.current = "active";
  nativeState.listeners.clear();
  onConfirm = vi.fn(() => true);
  onSessionClosed = vi.fn();
  props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-mobile-review-token",
    ownerUserId: owner,
    disabled: false,
    remainingCapacity: 50,
    onConfirm,
    onSessionClosed,
  };
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function readyFetcher() {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url === "http://127.0.0.1:4000/v1/auth/me") return session(props.ownerUserId);
    if (url.startsWith("http://127.0.0.1:4000/v1/foods/search?")) return searchResponse();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function mountReview(paste = "SECRET original oats line") {
  hooks.mount(() => PastedIngredientReview(props));
  await hooks.settle();
  await change("Pasted ingredient lines", paste);
  await click("Review pasted lines");
}
async function resolveLine(line = 1, quantity = "0.000001", kind = "grams") {
  await change(`Food search for line ${line}`, "oats");
  await click("Search foods");
  await click("Select Rolled oats");
  if (kind !== "grams") await change(`Quantity type for line ${line}`, kind);
  await change(`Quantity for line ${line}`, quantity);
  await click(`Confirm line ${line}`);
}
function hasButton(label: string) {
  return elements().some((node) => node.type === "Pressable" && text(node) === label);
}
async function updateProps(change: Partial<PastedIngredientReviewProps>) {
  props = { ...props, ...change };
  hooks.render();
  await hooks.settle();
}

async function appState(state: string) {
  nativeState.current = state;
  for (const listener of [...nativeState.listeners]) listener(state);
  await hooks.settle();
}

describe("actual native pasted ingredient review lifecycle", () => {
  it("requires explicit choices, preserves exact portions, and transfers once without transmitting pasted text", async () => {
    const fetcher = readyFetcher();
    await mountReview("SECRET original oats line\nSECRET second original line");
    expect(fetcher).not.toHaveBeenCalled();
    expect(button("Add reviewed ingredients").props.disabled).toBe(true);
    await resolveLine(1, "999999999999.999999");
    await click("Review line 2");
    await resolveLine(2, "2.000001", "serving");
    expect(text()).toContain("2 of 2 lines confirmed");
    const retained = button("Add reviewed ingredients");
    invoke(retained, "onPress");
    invoke(retained, "onPress");
    await hooks.settle();
    invoke(retained, "onPress");
    await hooks.settle();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const ingredients = required(onConfirm.mock.calls[0])[0];
    expect(ingredients).toHaveLength(2);
    expect(ingredients[0]).toMatchObject({
      foodVersionId: "202",
      portion: { kind: "grams", grams: "999999999999.999999" },
      note: null,
    });
    expect(ingredients[1]).toMatchObject({
      foodVersionId: "202",
      portion: { kind: "serving", servingId: "303", amount: "2.000001", servingLabel: "scoop" },
      note: null,
    });
    expect(required(ingredients[0]).clientKey).not.toBe(required(ingredients[1]).clientKey);
    expect(JSON.stringify(ingredients)).not.toContain("SECRET");
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain("SECRET");
      expect(init?.body).toBeUndefined();
      expect(init?.method ?? "GET").toBe("GET");
    }
    expect(field("Pasted ingredient lines").props.value).toBe("");
  });

  it("never offers a default quantity as an explicit line confirmation", async () => {
    readyFetcher();
    await mountReview();
    await change("Food search for line 1", "oats");
    await click("Search foods");
    await click("Select Rolled oats");
    expect(field("Quantity for line 1").props.value).toBe("");
    await click("Confirm line 1");
    expect(text()).toContain("0 of 1 lines confirmed");
    expect(button("Add reviewed ingredients").props.disabled).toBe(true);
    await change("Quantity for line 1", "100.000001");
    await change("Quantity type for line 1", "serving");
    expect(field("Quantity for line 1").props.value).toBe("");
  });

  it("invalidates an earlier confirmation when that line is reopened for a new choice", async () => {
    readyFetcher();
    await mountReview();
    await resolveLine();
    expect(button("Add reviewed ingredients").props.disabled).toBe(false);
    await click("Review line 1");
    expect(button("Add reviewed ingredients").props.disabled).toBe(true);
    await change("Food search for line 1", "oats");
    await click("Search foods");
    await click("Select Rolled oats");
    await change("Quantity for line 1", "2");
    invoke(button("Add reviewed ingredients"), "onPress");
    await hooks.settle();
    expect(onConfirm).not.toHaveBeenCalled();
    await click("Confirm line 1");
    await click("Add reviewed ingredients");
    expect(required(onConfirm.mock.calls[0])[0][0]).toMatchObject({
      portion: { kind: "grams", grams: "2" },
    });
  });

  it("editing the paste invalidates all reviewed choices and cancellation never transfers", async () => {
    const fetcher = readyFetcher();
    await mountReview();
    await resolveLine();
    const retainedAdd = button("Add reviewed ingredients");
    await click("Edit pasted lines");
    expect(field("Pasted ingredient lines").props.value).toBe("SECRET original oats line");
    await change("Pasted ingredient lines", "Replacement original");
    await click("Review pasted lines");
    const requestsBefore = fetcher.mock.calls.length;
    invoke(retainedAdd, "onPress");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(requestsBefore);
    expect(button("Add reviewed ingredients").props.disabled).toBe(true);
    await click("Cancel ingredient review");
    expect(field("Pasted ingredient lines").props.value).toBe("");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("rejects retained search/result callbacks after the current query or line changes", async () => {
    const fetcher = readyFetcher();
    await mountReview("Original one\nOriginal two");
    await change("Food search for line 1", "oats");
    const staleSearch = button("Search foods");
    await change("Food search for line 1", "rice");
    invoke(staleSearch, "onPress");
    await hooks.settle();
    expect(fetcher).not.toHaveBeenCalled();
    await click("Search foods");
    const staleSelection = button("Select Rolled oats");
    await click("Review line 2");
    invoke(staleSelection, "onPress");
    await hooks.settle();
    expect(hasButton("Confirm line 2")).toBe(false);
    expect(field("Food search for line 2").props.value).toBe("");
    expect(text()).toContain("0 of 2 lines confirmed");
  });

  it.each(["fetch", "json"] as const)(
    "drops delayed search %s after cancellation and a different active line/query",
    async (boundary) => {
      const pendingFetch = deferred<Response>();
      const pendingJson = deferred<unknown>();
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (url.startsWith("http://127.0.0.1:4000/v1/foods/search?")) {
          if (boundary === "fetch") return pendingFetch.promise;
          const response = searchResponse();
          response.json = () => pendingJson.promise;
          return response;
        }
        return original(url, init);
      });
      await mountReview();
      await change("Food search for line 1", "oats");
      await click("Search foods");
      await click("Cancel ingredient review");
      await change("Pasted ingredient lines", "New first\nNew second");
      await click("Review pasted lines");
      await click("Review line 2");
      await change("Food search for line 2", "rice");
      if (boundary === "fetch") pendingFetch.resolve(searchResponse());
      else pendingJson.resolve(await searchResponse().json());
      await hooks.settle();
      expect(hasButton("Select Rolled oats")).toBe(false);
      expect(field("Food search for line 2").props.value).toBe("rice");
      expect(onSessionClosed).not.toHaveBeenCalled();
      expect(
        fetcher.mock.calls.filter(([url]) => url === "http://127.0.0.1:4000/v1/auth/me"),
      ).toHaveLength(0);
    },
  );

  it.each(["owner", "token", "base", "background", "disabled", "unmount"] as const)(
    "drops late private search JSON after %s invalidation",
    async (transition) => {
      const pending = deferred<unknown>();
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (url.startsWith("http://127.0.0.1:4000/v1/foods/search?")) {
          const response = searchResponse();
          response.json = () => pending.promise;
          return response;
        }
        return original(url, init);
      });
      await mountReview();
      await change("Food search for line 1", "oats");
      await click("Search foods");
      if (transition === "owner") await updateProps({ ownerUserId: anotherOwner });
      if (transition === "token") await updateProps({ accessToken: "replacement-fixture-token" });
      if (transition === "base") await updateProps({ apiBase: new URL("http://localhost:4100") });
      if (transition === "background") await appState("background");
      if (transition === "disabled") await updateProps({ disabled: true });
      if (transition === "unmount") hooks.unmount();
      const updatesBefore = hooks.afterClose();
      pending.resolve(await searchResponse().json());
      await hooks.settle();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onSessionClosed).not.toHaveBeenCalled();
      expect(hooks.afterClose()).toBe(updatesBefore);
      expect(hasButton("Select Rolled oats")).toBe(false);
      if (["owner", "token", "base", "background"].includes(transition)) {
        expect(field("Pasted ingredient lines").props.value).toBe("");
      }
      if (transition === "disabled") {
        await updateProps({ disabled: false });
        expect(text()).toContain("SECRET original oats line");
        expect(hasButton("Select Rolled oats")).toBe(false);
      }
    },
  );

  it("ignores stale revalidation JSON from another owner after the review scope changes", async () => {
    const pending = deferred<unknown>();
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url, init) => {
      if (url === "http://127.0.0.1:4000/v1/auth/me") {
        const response = session();
        response.json = () => pending.promise;
        return response;
      }
      return original(url, init);
    });
    await mountReview();
    await change("Food search for line 1", "oats");
    await click("Search foods");
    await click("Cancel ingredient review");
    await change("Pasted ingredient lines", "Fresh owner draft");
    pending.resolve(await session(anotherOwner).json());
    await hooks.settle();
    expect(onSessionClosed).not.toHaveBeenCalled();
    expect(field("Pasted ingredient lines").props.value).toBe("Fresh owner draft");
    expect(hasButton("Select Rolled oats")).toBe(false);
  });

  it.each(["search", "transfer"] as const)(
    "retains reviewed lines after retryable 503 during %s and succeeds on retry",
    async (stage) => {
      const fetcher = readyFetcher();
      await mountReview("First original\nSecond original");
      await resolveLine();
      if (stage === "search") await click("Review line 2");
      else {
        await click("Review line 2");
        await resolveLine(2, "2");
      }
      const original = required(fetcher.getMockImplementation());
      let fail = true;
      fetcher.mockImplementation(async (url, init) => {
        if (url === "http://127.0.0.1:4000/v1/auth/me" && fail) {
          fail = false;
          return Response.json({ error: "Unavailable" }, { status: 503 });
        }
        return original(url, init);
      });
      if (stage === "search") {
        await change("Food search for line 2", "oats");
        await click("Search foods");
      } else await click("Add reviewed ingredients");
      expect(text()).toContain(
        stage === "search" ? "1 of 2 lines confirmed" : "2 of 2 lines confirmed",
      );
      expect(text()).toContain("Your review is kept");
      expect(onSessionClosed).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
      if (stage === "search") {
        await click("Search foods");
        await click("Select Rolled oats");
        await change("Quantity for line 2", "2");
        await click("Confirm line 2");
      }
      await click("Add reviewed ingredients");
      expect(onConfirm).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["fetch", "json"] as const)(
    "fences the final authentication %s after cancellation",
    async (boundary) => {
      const fetcher = readyFetcher();
      await mountReview();
      await resolveLine();
      const pendingFetch = deferred<Response>();
      const pendingJson = deferred<unknown>();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (url === "http://127.0.0.1:4000/v1/auth/me") {
          if (boundary === "fetch") return pendingFetch.promise;
          const response = session();
          response.json = () => pendingJson.promise;
          return response;
        }
        return original(url, init);
      });
      await click("Add reviewed ingredients");
      await click("Cancel ingredient review");
      if (boundary === "fetch")
        pendingFetch.resolve(Response.json({ error: "Stale unauthorized" }, { status: 401 }));
      else pendingJson.resolve(await session(anotherOwner).json());
      await hooks.settle();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onSessionClosed).not.toHaveBeenCalled();
      expect(field("Pasted ingredient lines").props.value).toBe("");
    },
  );

  it.each(["owner", "token", "base", "background", "disabled", "unmount", "capacity"] as const)(
    "rechecks %s before final transfer after authentication JSON",
    async (transition) => {
      const fetcher = readyFetcher();
      await mountReview();
      await resolveLine();
      const pending = deferred<unknown>();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) => {
        if (url === "http://127.0.0.1:4000/v1/auth/me") {
          const response = session();
          response.json = () => pending.promise;
          return response;
        }
        return original(url, init);
      });
      await click("Add reviewed ingredients");
      if (transition === "owner") await updateProps({ ownerUserId: anotherOwner });
      if (transition === "token") await updateProps({ accessToken: "replacement-fixture-token" });
      if (transition === "base") await updateProps({ apiBase: new URL("http://localhost:4100") });
      if (transition === "background") await appState("background");
      if (transition === "disabled") await updateProps({ disabled: true });
      if (transition === "capacity") await updateProps({ remainingCapacity: 0 });
      if (transition === "unmount") hooks.unmount();
      const updatesBefore = hooks.afterClose();
      pending.resolve(await session().json());
      await hooks.settle();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onSessionClosed).not.toHaveBeenCalled();
      expect(hooks.afterClose()).toBe(updatesBefore);
    },
  );

  it.each(["401", "owner"] as const)(
    "clears private review when current final verification proves %s closure",
    async (reason) => {
      const fetcher = readyFetcher();
      await mountReview();
      await resolveLine();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        url === "http://127.0.0.1:4000/v1/auth/me"
          ? reason === "401"
            ? Response.json({ error: "Session ended" }, { status: 401 })
            : session(anotherOwner)
          : original(url, init),
      );
      const retained = button("Add reviewed ingredients");
      await click("Add reviewed ingredients");
      expect(onSessionClosed).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(text()).not.toContain("SECRET");
      invoke(retained, "onPress");
      await hooks.settle();
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("loads a usable empty review after StrictMode setup-cleanup-setup", async () => {
    readyFetcher();
    hooks.mount(() => PastedIngredientReview(props));
    hooks.replayEffects();
    await hooks.settle();
    await change("Pasted ingredient lines", "StrictMode original");
    await click("Review pasted lines");
    await resolveLine();
    await click("Add reviewed ingredients");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onSessionClosed).not.toHaveBeenCalled();
  });

  it("keeps the review when the latest parent refuses transfer and permits an explicit retry", async () => {
    readyFetcher();
    onConfirm.mockReturnValueOnce(false);
    await mountReview();
    await resolveLine();
    await click("Add reviewed ingredients");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain("1 of 1 lines confirmed");
    expect(text()).toContain("Your review is kept");
    await click("Add reviewed ingredients");
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm.mock.calls[1]?.[0]).toEqual(onConfirm.mock.calls[0]?.[0]);
    expect(field("Pasted ingredient lines").props.value).toBe("");
  });

  it("clears a confirmed review on background and never revives it on foreground", async () => {
    const fetcher = readyFetcher();
    await mountReview();
    await resolveLine();
    const retained = button("Add reviewed ingredients");
    await appState("background");
    const calls = fetcher.mock.calls.length;
    invoke(retained, "onPress");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(text()).not.toContain("SECRET");
    await appState("active");
    expect(field("Pasted ingredient lines").props.value).toBe("");
    expect(onConfirm).not.toHaveBeenCalled();
    await change("Pasted ingredient lines", "Fresh foreground line");
    await click("Review pasted lines");
    await resolveLine();
    await click("Add reviewed ingredients");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials off public search and authenticates only against the selected API", async () => {
    const fetcher = readyFetcher();
    await mountReview();
    await resolveLine();
    for (const [url, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (url.includes("/v1/foods/search?")) {
        expect(headers.has("authorization")).toBe(false);
        expect(new URL(url).searchParams.get("query")).toBe("oats");
      } else {
        expect(url).toBe("http://127.0.0.1:4000/v1/auth/me");
        expect(headers.get("authorization")).toBe("Bearer synthetic-mobile-review-token");
      }
    }
  });
});
