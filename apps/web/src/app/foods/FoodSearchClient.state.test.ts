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
    const attachRefs = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) attachRefs(child);
        return;
      }
      if (!value || typeof value !== "object" || !("props" in value)) return;
      const props = (value as { props: Record<string, unknown> }).props;
      const ref = props.ref as { current: unknown } | undefined;
      if (ref && !ref.current) ref.current = { focus: vi.fn() };
      attachRefs(props.children);
    };
    attachRefs(tree);
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

const hit = {
  foodId: "101",
  foodVersionId: "202",
  kind: "branded",
  name: "Apple Pie",
  brandName: "Orchard Kitchen",
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
    label: "1 slice",
    quantity: "1",
    unit: "slice",
    gramWeight: "125.5",
    milliliterVolume: null,
  },
} as const;

const route = vi.hoisted(() => ({ query: "date=2026-09-24&meal=dinner" }));
const operationId = vi.hoisted(() => vi.fn());
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(route.query) }));
vi.mock("../../lib/diary", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createOperationId: operationId,
}));

import { FoodAddConfirmation, FoodSearchClient } from "./FoodSearchClient";

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
  const node = elements().find(
    (item) =>
      item.type === "button" && (item.props["aria-label"] === label || text(item) === label),
  );
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}
function field(id: string): ElementNode {
  const node = elements().find((item) => item.props.id === id);
  if (!node) throw new Error(`Missing field: ${id}`);
  return node;
}
function invoke(node: ElementNode, action = "onClick", ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function change(id: string, value: string) {
  invoke(field(id), "onChange", { target: { value } });
  await hooks.settle();
}
async function search() {
  await change("food-query", "apple");
  const form = elements().find(
    (node) => node.type === "form" && node.props["aria-label"] === "Food search",
  );
  if (!form) throw new Error("Missing search form");
  invoke(form, "onSubmit", { preventDefault: vi.fn() });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
function session(timeZone = "America/Chicago") {
  return Response.json({
    data: {
      user: { id: owner, email: "owner@example.test", emailVerified: true },
      profile: {
        displayName: "Owner",
        birthDate: null,
        sexAtBirth: "not_specified",
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone,
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "4",
      },
    },
  });
}
function publicResponse(url: string) {
  if (url.startsWith("/api/foods/search?"))
    return Response.json({ data: [hit], page: { nextCursor: null } });
  if (url.startsWith("/api/foods/barcodes/")) return Response.json({ data: hit });
  if (url.startsWith("/api/foods/autocomplete?"))
    return Response.json({
      data: [
        {
          foodId: hit.foodId,
          foodVersionId: hit.foodVersionId,
          kind: hit.kind,
          label: hit.name,
          brandName: hit.brandName,
          source: hit.source,
        },
      ],
    });
  throw new Error(`Unexpected request: ${url}`);
}
function failure(kind: string): Response {
  if (kind === "network") throw new TypeError("Synthetic network failure");
  if (kind === "malformed") return Response.json({ data: { broken: true } });
  return Response.json({ error: "Synthetic unavailable" }, { status: 503 });
}
const timers = new Map<number, () => void>();
let timerId = 0;
beforeEach(() => {
  route.query = "date=2026-09-24&meal=dinner";
  timers.clear();
  timerId = 0;
  operationId.mockReset();
  operationId.mockImplementation(
    () => `a7183708-7725-4b7c-a180-${String(operationId.mock.calls.length).padStart(12, "0")}`,
  );
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Foods initial session recovery", () => {
  it.each(["503", "network", "malformed"])(
    "recovers %s discovery with one session read while public search stays usable",
    async (kind) => {
      let authReads = 0;
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/auth/me") return ++authReads === 1 ? failure(kind) : session();
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      expect(text()).toContain("Apple Pie");
      expect(field("quick-add-date").props.value).toBe("2026-09-24");
      expect(field("quick-add-meal").props.value).toBe("dinner");
      const before = fetcher.mock.calls.length;
      invoke(button("Retry session"));
      await hooks.settle();
      expect(fetcher.mock.calls.slice(before).map(([url]) => url)).toEqual(["/api/auth/me"]);
      expect(authReads).toBe(2);
      expect(text()).toContain("Apple Pie");
      expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(false);
      expect(operationId).not.toHaveBeenCalled();
    },
  );
});

function savedMutation(init: RequestInit, date = "2026-09-24") {
  const body = JSON.parse(String(init.body));
  const source = { ...hit.source, releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19" };
  return Response.json({
    data: {
      replayed: true,
      entry: {
        id: "96aac405-c107-4776-923e-a40ca5014975",
        revision: "1",
        entryKind: "food",
        foodVersionId: body.foodVersionId,
        recipeVersionId: null,
        portion:
          body.portion.kind === "serving"
            ? { ...body.portion, servingLabel: "1 slice" }
            : body.portion,
        food: { name: hit.name, brandName: hit.brandName },
        recipe: null,
        source,
        foodProvenance: { kind: "public", source },
        mealSlot: body.mealSlot,
        resolvedGrams: "125.5",
        note: null,
        occurredAt: body.occurredAt,
        localDate: date,
        timeZone: "America/Chicago",
        localTime: "12:00:00",
        position: 0,
        nutrients: [],
      },
      affectedDays: [{ localDate: date, revision: "8" }],
    },
  });
}
function pendingPosts(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
}
function authCount(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.filter(([url]) => url === "/api/auth/me").length;
}
function hasRetry() {
  return elements().some((node) => node.type === "button" && text(node) === "Retry session");
}

describe("Foods session lifecycle and public independence", () => {
  it("keeps search, suggestions and exact barcode usable during pending discovery and its error", async () => {
    const auth = deferred<Response>();
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? auth.promise : publicResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    expect(text()).toContain("Checking your session");
    await change("food-query", "apple");
    for (const callback of timers.values()) callback();
    timers.clear();
    await hooks.settle();
    expect(
      elements().some((node) => node.type === "button" && text(node).startsWith("Apple Pie")),
    ).toBe(true);
    await search();
    await change("food-barcode", "012345678905");
    const form = elements().find(
      (node) => node.type === "form" && node.props.className === "barcodeForm",
    );
    if (!form) throw new Error("Missing barcode form");
    invoke(form, "onSubmit", { preventDefault: vi.fn() });
    await hooks.settle();
    expect(
      elements().filter((node) => node.type === "h3" && text(node) === "Apple Pie"),
    ).toHaveLength(2);
    expect(authCount(fetcher)).toBe(1);
    expect(pendingPosts(fetcher)).toHaveLength(0);
    auth.resolve(failure("503"));
    await hooks.settle();
    expect(hasRetry()).toBe(true);
    expect(
      elements().filter((node) => node.type === "h3" && text(node) === "Apple Pie"),
    ).toHaveLength(2);
    expect(button("Search").props.disabled).toBe(false);
    expect(button("Look up").props.disabled).toBe(false);
    expect(operationId).not.toHaveBeenCalled();
  });

  it("treats a current retry 401 as signed out without parsing JSON or hiding public results", async () => {
    const json = vi.fn(() => {
      throw new Error("401 body must not be parsed");
    });
    let auth = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url !== "/api/auth/me") return publicResponse(url);
      return ++auth === 1
        ? failure("503")
        : ({ ok: false, status: 401, json } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    const retry = button("Retry session");
    invoke(retry);
    await hooks.settle();
    expect(json).not.toHaveBeenCalled();
    expect(hasRetry()).toBe(false);
    expect(text()).toContain("Sign in");
    expect(text()).toContain("Apple Pie");
    expect(elements().some((node) => node.props.href === "/login")).toBe(true);
    invoke(retry);
    route.query = "date=2026-09-25&meal=lunch";
    hooks.render();
    await hooks.settle();
    expect(authCount(fetcher)).toBe(2);
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });

  it.each(["", "date=2026-09-24&meal=dinner"])(
    "preserves edits and raw quantity while retry finishes for route %s",
    async (query) => {
      route.query = query;
      const retried = deferred<Response>();
      let auth = 0;
      const fetcher = vi.fn(async (url: string) =>
        url === "/api/auth/me"
          ? ++auth === 1
            ? failure("503")
            : retried.promise
          : publicResponse(url),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      invoke(button("Retry session"));
      await hooks.settle();
      await change("quick-add-date", "2026-09-22");
      await change("quick-add-meal", "snacks");
      await change("quick-add-search-202-kind", "grams");
      await change("quick-add-search-202-amount", "125.500");
      retried.resolve(session("Pacific/Kiritimati"));
      await hooks.settle();
      expect(field("quick-add-date").props.value).toBe("2026-09-22");
      expect(field("quick-add-meal").props.value).toBe("snacks");
      expect(field("quick-add-search-202-kind").props.value).toBe("grams");
      expect(field("quick-add-search-202-amount").props.value).toBe("125.500");
      expect(field("food-query").props.value).toBe("apple");
      expect(operationId).not.toHaveBeenCalled();
      expect(pendingPosts(fetcher)).toHaveLength(0);
    },
  );

  it.each(["", "date=2026-02-30&meal=invalid"])(
    "sets only untouched defaults from the recovered profile clock for route %s",
    async (query) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-24T13:00:00Z"));
      route.query = query;
      let auth = 0;
      const fetcher = vi.fn(async () =>
        ++auth === 1 ? failure("503") : session("America/Los_Angeles"),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      vi.setSystemTime(new Date("2026-09-25T02:00:00Z"));
      invoke(button("Retry session"));
      await hooks.settle();
      expect(field("quick-add-date").props.value).toBe("2026-09-24");
      expect(field("quick-add-meal").props.value).toBe("dinner");
      expect(auth).toBe(2);
    },
  );

  it("rejects duplicate and old retry callbacks across repeated failures, before another render", async () => {
    const pending = deferred<Response>();
    let auth = 0;
    const fetcher = vi.fn(async () =>
      ++auth === 1 ? failure("503") : auth === 2 ? pending.promise : session(),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    const oldRetry = button("Retry session");
    invoke(oldRetry);
    invoke(oldRetry);
    expect(authCount(fetcher)).toBe(2);
    pending.resolve(failure("503"));
    await hooks.settle();
    const freshRetry = button("Retry session");
    invoke(oldRetry);
    expect(authCount(fetcher)).toBe(2);
    invoke(freshRetry);
    invoke(freshRetry);
    await hooks.settle();
    expect(authCount(fetcher)).toBe(3);
    expect(hasRetry()).toBe(false);
    invoke(freshRetry);
    expect(authCount(fetcher)).toBe(3);
  });

  it("rejects retained retry before replacement-route effects and ignores the previous held response", async () => {
    const held = deferred<Response>();
    let auth = 0;
    const fetcher = vi.fn(async () =>
      ++auth === 1 ? failure("503") : auth === 2 ? held.promise : session("UTC"),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    const retry = button("Retry session");
    invoke(retry);
    route.query = "date=2026-09-25&meal=lunch";
    hooks.renderWithoutEffects();
    invoke(retry);
    expect(authCount(fetcher)).toBe(2);
    hooks.render();
    await hooks.settle();
    held.resolve(session("Pacific/Kiritimati"));
    await hooks.settle();
    expect(authCount(fetcher)).toBe(3);
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    expect(field("quick-add-meal").props.value).toBe("lunch");
    expect(text()).not.toContain("could not be verified");
  });

  it.each(["success", "network", "401"])(
    "ignores late %s and retained retry after unmount",
    async (outcome) => {
      const held = deferred<Response>();
      let auth = 0;
      const fetcher = vi.fn(async () => (++auth === 1 ? failure("503") : held.promise));
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      const retry = button("Retry session");
      invoke(retry);
      await hooks.settle();
      hooks.unmount();
      invoke(retry);
      if (outcome === "network") held.reject(new TypeError("Late failure"));
      else held.resolve(outcome === "401" ? Response.json({}, { status: 401 }) : session());
      await hooks.settle();
      expect(authCount(fetcher)).toBe(2);
      expect(hooks.afterClose()).toBe(0);
    },
  );

  it("ignores late session JSON after a newer route has recovered", async () => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    let auth = 0;
    const fetcher = vi.fn(async () => {
      auth += 1;
      return auth === 1
        ? failure("503")
        : auth === 2
          ? ({ ok: true, status: 200, json } as unknown as Response)
          : session("UTC");
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    invoke(button("Retry session"));
    await hooks.settle();
    expect(json).toHaveBeenCalledOnce();
    route.query = "date=2026-09-26&meal=breakfast";
    hooks.render();
    await hooks.settle();
    body.resolve({ data: { malformed: true } });
    await hooks.settle();
    expect(hasRetry()).toBe(false);
    expect(field("quick-add-date").props.value).toBe("2026-09-26");
    expect(field("quick-add-meal").props.value).toBe("breakfast");
    expect(text()).not.toContain("could not be verified");
  });

  it("does not let an old request finally release a newer retry", async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    let auth = 0;
    const fetcher = vi.fn(async () => {
      auth += 1;
      return auth === 1 || auth === 3 ? failure("503") : auth === 2 ? old.promise : current.promise;
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    invoke(button("Retry session"));
    route.query = "date=2026-09-25&meal=snacks";
    hooks.render();
    await hooks.settle();
    const retry = button("Retry session");
    invoke(retry);
    old.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    invoke(retry);
    expect(authCount(fetcher)).toBe(4);
    current.resolve(session());
    await hooks.settle();
    expect(hasRetry()).toBe(false);
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
  });

  it("survives StrictMode cleanup replay and ignores its old 401", async () => {
    const old = deferred<Response>();
    let auth = 0;
    const fetcher = vi.fn(async () => (++auth === 1 ? old.promise : session()));
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    hooks.replayEffects();
    await hooks.settle();
    old.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    expect(authCount(fetcher)).toBe(2);
    expect(hasRetry()).toBe(false);
    expect(text()).not.toContain("Sign in to choose");
    expect(text()).not.toContain("could not be verified");
  });
});

describe("initial retry preserves quick-add operations", () => {
  it.each(["503", "network", "malformed"])(
    "keeps exact %s pending-add identity through retry attempts and destination round trips",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-24T17:00:00Z"));
      const pending = deferred<Response>();
      let auth = 0;
      let posts = 0;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return ++auth === 1 ? failure("503") : session();
        if (init?.method === "POST") return ++posts === 1 ? pending.promise : savedMutation(init);
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      const retry = button("Retry session");
      invoke(retry);
      await hooks.settle();
      await search();
      await change("quick-add-search-202-amount", "2.500");
      const add = button("Add 2.500 default servings of Apple Pie");
      invoke(add);
      invoke(retry);
      invoke(add);
      expect(posts).toBe(1);
      expect(authCount(fetcher)).toBe(2);
      if (kind === "network") pending.reject(new TypeError("Unknown write outcome"));
      else
        pending.resolve(
          kind === "503" ? failure("503") : Response.json({ data: { invalid: true } }),
        );
      await hooks.settle();
      invoke(retry);
      route.query = "date=2026-09-25&meal=lunch";
      hooks.render();
      await hooks.settle();
      expect(field("quick-add-date").props.value).toBe("2026-09-25");
      expect(field("quick-add-meal").props.value).toBe("lunch");
      invoke(retry);
      route.query = "date=2026-09-24&meal=dinner";
      hooks.render();
      await hooks.settle();
      expect(field("quick-add-search-202-amount").props.value).toBe("2.500");
      vi.setSystemTime(new Date("2026-09-24T18:42:00Z"));
      invoke(button("Add 2.500 default servings of Apple Pie"));
      await hooks.settle();
      const writes = pendingPosts(fetcher);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[0]?.[0]).toBe(
        "/api/diary/entries?date=2026-09-24&profileTimeZonePrecondition=v1",
      );
      expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({
        foodVersionId: "202",
        portion: { kind: "serving", servingId: "303", amount: "2.5" },
        mealSlot: "dinner",
        occurredAt: "2026-09-24T17:00:00.000Z",
      });
      expect(writes[0]?.[1]?.headers).toMatchObject({
        "idempotency-key": "a7183708-7725-4b7c-a180-000000000001",
        "x-expected-profile-time-zone": "America/Chicago",
      });
      expect(operationId).toHaveBeenCalledOnce();
      expect(authCount(fetcher)).toBe(2);
      expect(text()).toContain("was added to Dinner on 2026-09-24");
    },
  );

  it("keeps typed timezone no-write conflict and explicit day review separate from initial retry", async () => {
    const profile = deferred<Response>();
    let auth = 0;
    let posts = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me")
        return ++auth === 1 ? failure("503") : auth === 2 ? session() : profile.promise;
      if (init?.method === "POST")
        return ++posts === 1
          ? Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 })
          : savedMutation(init);
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    const retry = button("Retry session");
    invoke(retry);
    await hooks.settle();
    await search();
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    invoke(retry);
    expect(authCount(fetcher)).toBe(3);
    expect(posts).toBe(1);
    profile.resolve(session("UTC"));
    await hooks.settle();
    expect(text()).toContain("This food was not added");
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    invoke(retry);
    expect(authCount(fetcher)).toBe(3);
    expect(posts).toBe(1);
    invoke(button("Confirm 2026-09-24 as local day"));
    await hooks.settle();
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const writes = pendingPosts(fetcher);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.headers).toMatchObject({ "x-expected-profile-time-zone": "UTC" });
    expect(writes[1]?.[1]?.headers).not.toEqual(writes[0]?.[1]?.headers);
    expect(operationId).toHaveBeenCalledTimes(2);
  });
});

it("changes only the explicit destination parameter that changed after successful discovery", async () => {
  let auth = 0;
  const fetcher = vi.fn(async () => (++auth === 1 ? failure("503") : session()));
  vi.stubGlobal("fetch", fetcher);
  hooks.mount(FoodSearchClient);
  await hooks.settle();
  const retry = button("Retry session");
  invoke(retry);
  await hooks.settle();
  await change("quick-add-date", "2026-09-22");
  route.query = "date=2026-09-24&meal=breakfast";
  hooks.render();
  await hooks.settle();
  expect(field("quick-add-date").props.value).toBe("2026-09-22");
  expect(field("quick-add-meal").props.value).toBe("breakfast");
  await change("quick-add-meal", "lunch");
  route.query = "date=2026-09-25&meal=breakfast";
  hooks.render();
  await hooks.settle();
  expect(field("quick-add-date").props.value).toBe("2026-09-25");
  expect(field("quick-add-meal").props.value).toBe("lunch");
  invoke(retry);
  expect(authCount(fetcher)).toBe(2);
  expect(operationId).not.toHaveBeenCalled();
});

describe("passive food serving amounts", () => {
  it.each([
    ["150.000000", null, "150 g"],
    ["123456789012.123450", null, "123456789012.12345 g"],
    ["0.000001", null, "0.000001 g"],
    [null, "250.500000", "250.5 mL"],
    [null, "0.000001", "0.000001 mL"],
  ])(
    "shows exact readable search and barcode metadata for %s / %s",
    async (grams, volume, shown) => {
      const result = {
        ...hit,
        defaultServing: { ...hit.defaultServing, gramWeight: grams, milliliterVolume: volume },
      };
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/auth/me") return session();
        if (url.startsWith("/api/foods/search?"))
          return Response.json({ data: [result], page: { nextCursor: null } });
        if (url.startsWith("/api/foods/barcodes/")) return Response.json({ data: result });
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      expect(text(elements().find((node) => node.props.className === "servingCopy"))).toBe(
        `1 slice · ${shown}`,
      );
      await change("quick-add-search-202-amount", "2.500000");
      const kind = grams === null ? "grams" : "serving";
      expect(field("quick-add-search-202-kind").props.value).toBe(kind);
      expect(
        elements(field("quick-add-search-202-kind"))
          .filter((node) => node.type === "option")
          .map((node) => [node.props.value, text(node)]),
      ).toEqual(
        grams === null
          ? [["grams", "Grams"]]
          : [
              ["serving", "Default serving: 1 slice"],
              ["grams", "Grams"],
            ],
      );
      const action = `Add 2.500000 ${grams === null ? "g" : "default servings"} of Apple Pie`;
      expect(button(action).props["aria-label"]).toBe(action);
      await change("food-barcode", "012345678905");
      const form = elements().find(
        (node) => node.type === "form" && node.props.className === "barcodeForm",
      );
      if (!form) throw new Error("Missing barcode form");
      invoke(form, "onSubmit", { preventDefault: vi.fn() });
      await hooks.settle();
      const barcode = elements().find((node) => node.props.className === "barcodeResult");
      expect(text(barcode)).toContain(`1 slice · ${shown} · Data source: USDA FoodData Central`);
      expect(field("quick-add-barcode-202-kind").props.value).toBe(kind);
      expect(field("quick-add-barcode-202-amount").props.value).toBe("2.500000");
      expect(field("quick-add-search-202-amount").props.value).toBe("2.500000");
      expect(operationId).not.toHaveBeenCalled();
      expect(result.defaultServing.gramWeight).toBe(grams);
      expect(result.defaultServing.milliliterVolume).toBe(volume);
    },
  );

  it("keeps raw quick-add controls and exact pending request bytes beside trimmed metadata", async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST") return ++posts === 1 ? failure("503") : savedMutation(init);
      if (url.startsWith("/api/foods/search?"))
        return Response.json({
          data: [{ ...hit, defaultServing: { ...hit.defaultServing, gramWeight: "150.000000" } }],
          page: { nextCursor: null },
        });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    await change("quick-add-search-202-amount", "2.500000");
    invoke(button("Add 2.500000 default servings of Apple Pie"));
    await hooks.settle();
    expect(field("quick-add-search-202-amount").props.value).toBe("2.500000");
    invoke(button("Add 2.500000 default servings of Apple Pie"));
    await hooks.settle();
    const writes = pendingPosts(fetcher);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(JSON.parse(String(writes[0]?.[1]?.body)).portion).toEqual({
      kind: "serving",
      servingId: "303",
      amount: "2.5",
    });
    expect(writes[0]?.[0]).toBe(
      "/api/diary/entries?date=2026-09-24&profileTimeZonePrecondition=v1",
    );
    expect(operationId).toHaveBeenCalledOnce();
    expect(text()).toContain("1 slice · 150 g");
  });
});

describe("web search request retirement", () => {
  const freshHit = { ...hit, foodId: "102", foodVersionId: "203", name: "Fresh Pear" };
  const finalHit = { ...hit, foodId: "103", foodVersionId: "204", name: "Final Pear" };
  const page = (items: readonly unknown[], nextCursor: string | null = null) => ({
    data: items,
    page: { nextCursor },
  });
  async function submitQuery(value: string) {
    await change("food-query", value);
    const form = elements().find(
      (node) => node.type === "form" && node.props["aria-label"] === "Food search",
    );
    if (!form) throw new Error("Missing search form");
    // Calls the real form handler. This does not prove an implicit browser submit
    // is reachable while the submit button is disabled.
    invoke(form, "onSubmit", { preventDefault: vi.fn() });
    await hooks.settle();
  }
  function searchView() {
    const status = elements().find(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.startsWith("searchStatus "),
    );
    const list = elements().find((node) => node.props["aria-label"] === "Food search results");
    return {
      status: text(status),
      state: status?.props.className,
      names: elements(list ?? null)
        .filter((node) => node.type === "h3")
        .map((node) => text(node)),
      loadMore: elements().some(
        (node) => node.type === "button" && text(node) === "Load more results",
      ),
    };
  }

  it.each(["success", "http", "network", "json", "malformed-json"])(
    "keeps blank handler validation after an older %s response and permits fresh recovery",
    async (outcome) => {
      const held = deferred<Response>();
      const body = deferred<unknown>();
      const delayedBody = outcome === "json" || outcome === "malformed-json";
      const oldJson = vi.fn(() =>
        delayedBody ? body.promise : Promise.resolve(page([hit], "old_cursor")),
      );
      let originalSignal: AbortSignal | null | undefined;
      let reads = 0;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (url.startsWith("/api/foods/search?")) {
          reads += 1;
          if (reads === 1) {
            originalSignal = init?.signal;
            return delayedBody
              ? ({ ok: true, status: 200, json: oldJson } as unknown as Response)
              : held.promise;
          }
          return Response.json(page([freshHit]));
        }
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await submitQuery("apple");
      expect(button("Searching…").props.disabled).toBe(true);
      if (delayedBody) expect(oldJson).toHaveBeenCalledOnce();
      await submitQuery(outcome === "http" || outcome === "json" ? " \t " : "");
      const validation = searchView();
      expect(validation.status).toBe("Enter a food or brand name before searching.");
      expect(validation.names).toEqual([]);
      expect(validation.loadMore).toBe(false);
      expect(reads).toBe(1);
      if (delayedBody)
        body.resolve(outcome === "json" ? page([hit], "old_cursor") : { broken: true });
      else if (outcome === "network") held.reject(new TypeError("Synthetic retired request"));
      else
        held.resolve({
          ok: outcome !== "http",
          status: outcome === "http" ? 503 : 200,
          json: oldJson,
        } as unknown as Response);
      await hooks.settle();
      expect(searchView()).toEqual(validation);
      expect(originalSignal?.aborted).toBe(true);
      if (!delayedBody) expect(oldJson).not.toHaveBeenCalled();
      await submitQuery("pear");
      expect(searchView().names).toEqual(["Fresh Pear"]);
      expect(searchView().status).toBe("1 result shown for “pear”.");
      expect(reads).toBe(2);
      expect(authCount(fetcher)).toBe(1);
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
    },
  );

  it.each(["new-search", "intent", "unmount"])(
    "ignores an older invalid continuation after %s",
    async (boundary) => {
      const held = deferred<Response>();
      const oldJson = vi.fn(() => Promise.resolve({ error: "Synthetic expired cursor" }));
      let originalSignal: AbortSignal | null | undefined;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (url.startsWith("/api/foods/search?")) {
          const query = new URL(url, "https://example.test").searchParams;
          if (query.get("cursor") === "old_cursor") {
            originalSignal = init?.signal;
            return held.promise;
          }
          if (query.get("cursor") === "fresh_cursor") return Response.json(page([finalHit]));
          return query.get("query") === "pear"
            ? Response.json(page([freshHit], "fresh_cursor"))
            : Response.json(page([hit], "old_cursor"));
        }
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await submitQuery("apple");
      invoke(button("Load more results"));
      await hooks.settle();
      if (boundary === "new-search") await submitQuery("pear");
      else if (boundary === "intent") {
        const radio = elements().find(
          (node) => node.props.name === "food-intent" && node.props.value === "generic",
        );
        if (!radio) throw new Error("Missing food intent");
        expect(radio.props.disabled).not.toBe(true);
        invoke(radio, "onChange");
        await hooks.settle();
      } else hooks.unmount();
      const current = searchView();
      held.resolve({ ok: false, status: 400, json: oldJson } as unknown as Response);
      await hooks.settle();
      expect(hooks.afterClose()).toBe(0);
      expect(searchView()).toEqual(current);
      expect(originalSignal?.aborted).toBe(true);
      expect(oldJson).not.toHaveBeenCalled();
      if (boundary === "new-search") {
        expect(current.names).toEqual(["Fresh Pear"]);
        expect(current.loadMore).toBe(true);
        invoke(button("Load more results"));
        await hooks.settle();
        expect(searchView().names).toEqual(["Fresh Pear", "Final Pear"]);
        expect(searchView().loadMore).toBe(false);
      } else if (boundary === "intent") {
        expect(current.names).toEqual([]);
        expect(current.status).toBe("Search generic by food or brand name.");
        await submitQuery("pear");
        expect(searchView().names).toEqual(["Fresh Pear"]);
        expect(fetcher.mock.calls.some(([url]) => url.includes("intent=generic"))).toBe(true);
      }
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
    },
  );

  it("appends a current continuation without duplicating versions", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return session();
      if (url.startsWith("/api/foods/search?"))
        return Response.json(
          url.includes("cursor=") ? page([hit, freshHit]) : page([hit], "current_cursor"),
        );
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await submitQuery("apple");
    await change("quick-add-search-202-amount", "2.500000");
    invoke(button("Load more results"));
    await hooks.settle();
    expect(searchView().names).toEqual(["Apple Pie", "Fresh Pear"]);
    expect(searchView().status).toBe("2 results shown for “apple”.");
    expect(searchView().loadMore).toBe(false);
    expect(field("quick-add-search-202-amount").props.value).toBe("2.500000");
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
  });

  it("keeps current continuation expiry visible and permits a fresh search", async () => {
    const json = vi.fn();
    let reads = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return session();
      if (url.startsWith("/api/foods/search?")) {
        reads += 1;
        if (url.includes("cursor=")) return { ok: false, status: 400, json } as unknown as Response;
        return Response.json(
          page(reads === 1 ? [hit] : [freshHit], reads === 1 ? "expired_cursor" : null),
        );
      }
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await submitQuery("apple");
    invoke(button("Load more results"));
    await hooks.settle();
    expect(searchView().names).toEqual(["Apple Pie"]);
    expect(searchView().status).toBe(
      "These results changed while you were browsing. Search again for a fresh result set.",
    );
    expect(searchView().loadMore).toBe(false);
    expect(json).not.toHaveBeenCalled();
    await submitQuery("pear");
    expect(searchView().names).toEqual(["Fresh Pear"]);
    expect(reads).toBe(3);
  });
});

describe("food additions after session expiry", () => {
  async function showPublicResults() {
    await search();
    await change("food-barcode", "012345678905");
    const form = elements().find((node) => node.props.className === "barcodeForm");
    if (!form) throw new Error("Missing barcode form");
    invoke(form, "onSubmit", { preventDefault: vi.fn() });
    await hooks.settle();
  }

  it.each(["search", "barcode"])(
    "retires a current %s Add 401 before parsing and keeps the public draft",
    async (instance) => {
      const post = deferred<Response>();
      const json = vi.fn(() => {
        throw new Error("401 body must not be parsed");
      });
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return post.promise;
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await showPublicResults();
      await change("quick-add-date", "2026-09-22");
      await change("quick-add-meal", "snacks");
      await change("quick-add-search-202-amount", "2.500000");
      const add = elements().find(
        (node) =>
          node.type === "fieldset" &&
          elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
      );
      if (!add) throw new Error("Missing quick-add controls");
      const retained = elements(add).find((node) => node.type === "button");
      if (!retained) throw new Error("Missing Add");
      invoke(retained);
      post.resolve({ ok: false, status: 401, json } as unknown as Response);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      invoke(retained); // A retained event can arrive before React renders the disabled button.
      expect(pendingPosts(fetcher)).toHaveLength(1);
      await hooks.settle();
      expect(json).not.toHaveBeenCalled();
      expect(text()).toContain("Sign in");
      expect(text()).not.toContain("Choose Add again to retry safely");
      expect(text()).not.toContain("was not added");
      expect(
        elements().filter((node) => node.type === "h3" && text(node) === "Apple Pie"),
      ).toHaveLength(2);
      for (const source of ["search", "barcode"]) {
        expect(field(`quick-add-${source}-202-amount`).props.value).toBe("2.500000");
      }
      expect(field("quick-add-date").props.value).toBe("2026-09-22");
      expect(field("quick-add-meal").props.value).toBe("snacks");
      const adds = elements().filter(
        (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("Add "),
      );
      expect(adds).toHaveLength(2);
      expect(adds.every((node) => node.props.disabled === true)).toBe(true);
      for (const node of adds) invoke(node);
      invoke(retained);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(operationId).toHaveBeenCalledOnce();
      expect(authCount(fetcher)).toBe(1);
      expect(button("Search").props.disabled).toBe(false);
      expect(button("Look up").props.disabled).toBe(false);
      expect(elements().some((node) => node.props.href === "/login")).toBe(true);
    },
  );

  it("keeps an uncertain attempt's identity when its exact retry returns 401", async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST")
        return ++posts === 1 ? failure("503") : Response.json({}, { status: 401 });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    await change("quick-add-search-202-amount", "2.500000");
    invoke(button("Add 2.500000 default servings of Apple Pie"));
    await hooks.settle();
    expect(text()).toContain("Choose Add again to retry safely");
    const retry = button("Add 2.500000 default servings of Apple Pie");
    invoke(retry);
    await hooks.settle();
    const writes = pendingPosts(fetcher);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(operationId).toHaveBeenCalledOnce();
    expect(text()).toContain("Check your diary before retrying an unconfirmed addition");
    expect(text()).not.toContain("was not added");
    invoke(retry);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(2);
    expect(hasRetry()).toBe(false);
  });

  it.each(["loading", "unauthenticated"])(
    "does not submit from a retained Add while session discovery is %s",
    async (state) => {
      const auth = deferred<Response>();
      const fetcher = vi.fn(async (url: string) =>
        url === "/api/auth/me" ? auth.promise : publicResponse(url),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      if (state === "unauthenticated") {
        auth.resolve(Response.json({}, { status: 401 }));
        await hooks.settle();
      }
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
    },
  );

  it.each(["401", "network", "late-json"])(
    "ignores a late Add %s and retained callback after unmount",
    async (outcome) => {
      const post = deferred<Response>();
      const body = deferred<unknown>();
      const json = vi.fn(() => body.promise);
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return post.promise;
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      const add = button("Add 1 default serving of Apple Pie");
      invoke(add);
      if (outcome === "late-json") {
        post.resolve({ ok: false, status: 503, json } as unknown as Response);
        await hooks.settle();
        expect(json).toHaveBeenCalledOnce();
      }
      hooks.unmount();
      invoke(add);
      if (outcome === "network") post.reject(new Error("Late network failure"));
      else if (outcome === "late-json") body.resolve({ error: "Late failure" });
      else post.resolve({ ok: false, status: 401, json } as unknown as Response);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(hooks.afterClose()).toBe(0);
      if (outcome === "401") expect(json).not.toHaveBeenCalled();
    },
  );

  it("ignores a retired route's 401 and fences its retained Add before route effects", async () => {
    const post = deferred<Response>();
    const json = vi.fn(() => {
      throw new Error("Retired body must not be parsed");
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST") return post.promise;
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    const oldAdd = button("Add 1 default serving of Apple Pie");
    invoke(oldAdd);
    await hooks.settle();
    route.query = "date=2026-09-25&meal=lunch";
    hooks.renderWithoutEffects();
    invoke(oldAdd);
    post.resolve({ ok: false, status: 401, json } as unknown as Response);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    hooks.render();
    await hooks.settle();
    expect(json).not.toHaveBeenCalled();
    expect(text()).not.toContain("Sign in");
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    expect(field("quick-add-meal").props.value).toBe("lunch");
    invoke(oldAdd);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(false);
  });
});

it("permits the current Add after a route effect changes no selected destination values", async () => {
  route.query = "date=2026-09-24";
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return session();
    if (init?.method === "POST") return savedMutation(init);
    return publicResponse(url);
  });
  vi.stubGlobal("fetch", fetcher);
  hooks.mount(FoodSearchClient);
  await hooks.settle();
  await search();
  await change("quick-add-meal", "dinner");
  route.query = "date=2026-09-24&meal=dinner";
  hooks.render();
  await hooks.settle();
  const add = button("Add 1 default serving of Apple Pie");
  expect(add.props.disabled).toBe(false);
  invoke(add);
  await hooks.settle();
  expect(pendingPosts(fetcher)).toHaveLength(1);
  expect(text()).toContain("was added to Dinner on 2026-09-24");
});

it("ignores the remaining Add work after unmount during a time-zone profile refresh", async () => {
  const profile = deferred<Response>();
  let auth = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return ++auth === 1 ? session() : profile.promise;
    if (init?.method === "POST") {
      return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
    }
    return publicResponse(url);
  });
  vi.stubGlobal("fetch", fetcher);
  hooks.mount(FoodSearchClient);
  await hooks.settle();
  await search();
  invoke(button("Add 1 default serving of Apple Pie"));
  await hooks.settle();
  expect(authCount(fetcher)).toBe(2);
  expect(pendingPosts(fetcher)).toHaveLength(1);

  hooks.unmount();
  profile.resolve(session("UTC"));
  await hooks.settle();

  expect(hooks.afterClose()).toBe(0);
  expect(pendingPosts(fetcher)).toHaveLength(1);
});

describe("Food suggestion query limits", () => {
  it.each([
    ["short", "Apple Pie", "Apple Pie"],
    ["long ASCII", "A".repeat(129), "A".repeat(128)],
    ["astral", "\u{1f34e}".repeat(129), "\u{1f34e}".repeat(64)],
    ["surrogate boundary", "A".repeat(127) + "\u{1f34e}", "A".repeat(127)],
    ["normalization expansion", "\ufb03".repeat(64), "ffi".repeat(42) + "ff"],
  ])("selects a %s label and logs its full named food", async (_kind, label, expectedQuery) => {
    const namedHit = { ...hit, name: label };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (url.startsWith("/api/foods/autocomplete?")) {
        return Response.json({
          data: [
            {
              foodId: hit.foodId,
              foodVersionId: hit.foodVersionId,
              kind: hit.kind,
              label,
              brandName: hit.brandName,
              source: hit.source,
            },
          ],
        });
      }
      if (url.startsWith("/api/foods/search?")) {
        const query = new URL(url, "https://example.test").searchParams.get("query");
        expect(query).toBe(expectedQuery);
        expect([...(query ?? "")].length).toBeLessThanOrEqual(128);
        expect(query?.length).toBeLessThanOrEqual(128);
        return Response.json({ data: [namedHit], page: { nextCursor: null } });
      }
      if (url.startsWith("/api/diary/entries?") && init?.method === "POST") {
        const saved = await savedMutation(init).json();
        saved.data.entry.food.name = label;
        return Response.json(saved);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("food-query", "apple");
    for (const callback of timers.values()) callback();
    timers.clear();
    await hooks.settle();
    const suggestion = elements().find(
      (node) => node.type === "button" && text(node).startsWith(label),
    );
    if (!suggestion) throw new Error("Missing full-name suggestion");
    invoke(suggestion);
    await hooks.settle();
    expect(field("food-query").props.value).toBe(expectedQuery);
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/foods/search?"))).toHaveLength(
      1,
    );
    expect(elements().some((node) => node.type === "h3" && text(node) === label)).toBe(true);
    expect(text()).not.toContain("Food search is unavailable");
    expect(field("quick-add-date").props.value).toBe("2026-09-24");
    expect(field("quick-add-meal").props.value).toBe("dinner");
    await change("quick-add-search-202-amount", "1.5");
    const add = button(`Add 1.5 default servings of ${label}`);
    expect(add.props.disabled).toBe(false);
    invoke(add);
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toBe("/api/diary/entries?date=2026-09-24&profileTimeZonePrecondition=v1");
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
      foodVersionId: hit.foodVersionId,
      portion: { kind: "serving", servingId: hit.defaultServing.servingId, amount: "1.5" },
      mealSlot: "dinner",
    });
    expect(text()).toContain(`1.5 default servings of ${label} was added to Dinner on 2026-09-24.`);
    expect(text()).not.toContain("retry safely");
  });
});

describe("food Add response matches the submitted operation", () => {
  for (const instance of ["search", "barcode"] as const) {
    it.each([
      "quantity",
      "unit",
      "serving",
      "meal",
      "instant",
      "time-zone",
      "day",
      "submillisecond",
      "compact-offset",
      "lowercase-zone",
    ] as const)(
      `keeps an uncertain ${instance} Add after a valid but unrelated %s result`,
      async (mismatch) => {
        const writes: RequestInit[] = [];
        const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes.push(init);
            const response = await savedMutation(init).json();
            if (writes.length === 1) {
              const saved = response.data.entry;
              if (mismatch === "quantity") saved.portion.amount = "3";
              if (mismatch === "unit") saved.portion = { kind: "grams", grams: "2.5" };
              if (mismatch === "serving") saved.portion.servingId = "304";
              if (mismatch === "meal") saved.mealSlot = "breakfast";
              if (mismatch === "instant") saved.occurredAt = "2026-09-24T17:01:00.000Z";
              if (mismatch === "time-zone") saved.timeZone = "America/New_York";
              if (mismatch === "submillisecond") saved.occurredAt = "2026-09-24T17:00:00.000001Z";
              if (mismatch === "compact-offset")
                saved.occurredAt = "2026-09-24T17:00:00.000001+0000";
              if (mismatch === "lowercase-zone") saved.occurredAt = "2026-09-24T17:00:00.000001z";
              if (mismatch === "day") {
                saved.localDate = "2026-09-23";
                response.data.affectedDays[0].localDate = "2026-09-23";
              }
            }
            return Response.json(response);
          }
          return publicResponse(url);
        });
        vi.stubGlobal("fetch", fetcher);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-24T17:00:00.000Z"));
        hooks.mount(FoodSearchClient);
        await hooks.settle();
        if (instance === "search") await search();
        else {
          await change("food-barcode", "012345678905");
          const form = elements().find((node) => node.props.className === "barcodeForm");
          if (!form) throw new Error("Missing barcode form");
          invoke(form, "onSubmit", { preventDefault: vi.fn() });
          await hooks.settle();
        }
        await change(`quick-add-${instance}-202-amount`, "2.500000");
        invoke(button("Add 2.500000 default servings of Apple Pie"));
        await hooks.settle();
        expect(writes).toHaveLength(1);
        expect(operationId).toHaveBeenCalledOnce();
        expect(text()).not.toContain("was added to");
        expect(text()).toContain("Choose Add again to retry safely");
        expect(field(`quick-add-${instance}-202-amount`).props.value).toBe("2.500000");
        expect(field("quick-add-date").props.value).toBe("2026-09-24");
        expect(field("quick-add-meal").props.value).toBe("dinner");
        vi.setSystemTime(new Date("2026-09-24T18:00:00.000Z"));
        invoke(button("Add 2.500000 default servings of Apple Pie"));
        await hooks.settle();
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual(writes[0]);
        expect(operationId).toHaveBeenCalledOnce();
        expect(text()).toContain("was added to Dinner on 2026-09-24");
        invoke(button("Add 2.500000 default servings of Apple Pie"));
        await hooks.settle();
        expect(writes).toHaveLength(3);
        expect(operationId).toHaveBeenCalledTimes(2);
        expect(new Headers(writes[2]?.headers).get("idempotency-key")).not.toBe(
          new Headers(writes[0]?.headers).get("idempotency-key"),
        );
      },
    );
  }

  it.each([false, true])(
    "settles a matching grams result with equivalent decimal/instant for replayed=%s",
    async (replayed) => {
      const writes: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes.push(init);
            const response = await savedMutation(init).json();
            response.data.replayed = replayed;
            response.data.entry.portion.grams = "2.500000";
            response.data.entry.occurredAt = "2026-09-24T17:00:00.000000000+00:00";
            return Response.json(response);
          }
          return publicResponse(url);
        }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-24T17:00:00.000Z"));
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      await change("quick-add-search-202-kind", "grams");
      await change("quick-add-search-202-amount", "2.500000");
      invoke(button("Add 2.500000 g of Apple Pie"));
      await hooks.settle();
      expect(text()).toContain("2.500000 g of Apple Pie was added to Dinner on 2026-09-24");
      invoke(button("Add 2.500000 g of Apple Pie"));
      await hooks.settle();
      expect(writes).toHaveLength(2);
      expect(operationId).toHaveBeenCalledTimes(2);
    },
  );
});

describe("Food diary-day review callback ownership", () => {
  async function requireDayReview() {
    let authReads = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session(++authReads === 1 ? "America/Chicago" : "UTC");
      if (init?.method === "POST") {
        if (authReads === 1) {
          return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
        }
        const date = new URL(url, "https://fixture.invalid").searchParams.get("date");
        const response = await savedMutation(init, date ?? "2026-09-24").json();
        response.data.entry.timeZone = "UTC";
        response.data.entry.localTime = new Date(response.data.entry.occurredAt)
          .toISOString()
          .slice(11, 19);
        return Response.json(response);
      }
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(text()).toContain("This food was not added");
    return { fetcher, review: button("Confirm 2026-09-24 as local day") };
  }

  it("keeps a changed diary day locked when a retained previous-day confirmation fires", async () => {
    const { fetcher, review } = await requireDayReview();
    await change("quick-add-date", "2026-09-25");
    invoke(review);
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    expect(button("Confirm 2026-09-25 as local day").props.disabled).toBe(false);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(text()).not.toContain("2026-09-24 is confirmed");
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it("retires the previous day synchronously before the changed input renders", async () => {
    const { review, fetcher } = await requireDayReview();
    invoke(field("quick-add-date"), "onChange", { target: { value: "2026-09-25" } });
    invoke(review);
    await hooks.settle();
    expect(button("Confirm 2026-09-25 as local day").props.disabled).toBe(false);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it("does not revive an older confirmation after a destination date round trip", async () => {
    const { review, fetcher } = await requireDayReview();
    await change("quick-add-date", "2026-09-25");
    await change("quick-add-date", "2026-09-24");
    invoke(review);
    await hooks.settle();
    expect(button("Confirm 2026-09-24 as local day").props.disabled).toBe(false);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it("ignores a confirmation retained before a replacement-route render and its effects", async () => {
    const { review, fetcher } = await requireDayReview();
    route.query = "date=2026-09-25&meal=lunch";
    hooks.renderWithoutEffects();
    invoke(review);
    hooks.render();
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    expect(button("Confirm 2026-09-25 as local day").props.disabled).toBe(false);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it("allows current review when replacement route parameters keep the selected destination", async () => {
    const { review, fetcher } = await requireDayReview();
    route.query = "date=2026-09-24";
    hooks.render();
    await hooks.settle();
    invoke(review);
    await hooks.settle();
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    invoke(button("Confirm 2026-09-24 as local day"));
    await hooks.settle();
    expect(text()).toContain("2026-09-24 is confirmed as a local diary day in UTC");
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(false);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it("allows only the current reviewed day and one explicit fresh add after confirmation", async () => {
    const { review, fetcher } = await requireDayReview();
    await change("quick-add-date", "2026-09-25");
    invoke(review);
    await hooks.settle();
    const current = button("Confirm 2026-09-25 as local day");
    invoke(current);
    invoke(current);
    await hooks.settle();
    expect(text()).toContain("2026-09-25 is confirmed as a local diary day in UTC");
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(false);
    expect(pendingPosts(fetcher)).toHaveLength(1);
    invoke(current);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[0]).toContain("date=2026-09-25");
    expect(posts[1]?.[1]?.headers).toMatchObject({ "x-expected-profile-time-zone": "UTC" });
    expect(posts[1]?.[1]?.headers).not.toEqual(posts[0]?.[1]?.headers);
    expect(text()).toContain("was added to Dinner on 2026-09-25");
    expect(operationId).toHaveBeenCalledTimes(2);
  });

  it("ignores retained diary-day confirmation after unmount", async () => {
    const { review, fetcher } = await requireDayReview();
    hooks.unmount();
    invoke(review);
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });
});

describe("Food timezone profile recovery follows the current session", () => {
  async function pendingProfile() {
    const profile = deferred<Response>();
    let authReads = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return ++authReads === 1 ? session() : profile.promise;
      if (init?.method === "POST") {
        return Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
      }
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    return { profile, fetcher };
  }

  it.each(["search", "barcode"])(
    "keeps the %s draft and requests sign-in when timezone recovery returns401",
    async (instance) => {
      const { profile, fetcher } = await pendingProfile();
      await change("food-barcode", "012345678905");
      const form = elements().find((node) => node.props.className === "barcodeForm");
      if (!form) throw new Error("Missing barcode form");
      invoke(form, "onSubmit", { preventDefault: vi.fn() });
      await hooks.settle();
      await change("quick-add-date", "2026-09-22");
      await change("quick-add-meal", "snacks");
      await change("quick-add-search-202-amount", "2.500000");
      const controls = elements().find(
        (node) =>
          node.type === "fieldset" &&
          elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
      );
      const add = controls && elements(controls).find((node) => node.type === "button");
      if (!add) throw new Error("Missing Add");
      invoke(add);
      await hooks.settle();
      expect(authCount(fetcher)).toBe(2);
      const json = vi.fn(() => {
        throw new Error("401 body must not be parsed");
      });
      profile.resolve({ ok: false, status: 401, json } as unknown as Response);
      await hooks.settle();
      expect(text()).toContain("Sign in to choose a quantity and add it to your diary.");
      expect(text()).not.toContain("refresh this page");
      expect(json).not.toHaveBeenCalled();
      expect(field("quick-add-date").props.value).toBe("2026-09-22");
      expect(field("quick-add-meal").props.value).toBe("snacks");
      for (const source of ["search", "barcode"]) {
        expect(field(`quick-add-${source}-202-amount`).props.value).toBe("2.500000");
      }
      expect(button("Search").props.disabled).toBe(false);
      expect(button("Look up").props.disabled).toBe(false);
      invoke(add);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(authCount(fetcher)).toBe(2);
      expect(operationId).toHaveBeenCalledOnce();
    },
  );

  it("does not apply profile JSON retained across a replacement diary route", async () => {
    const { profile, fetcher } = await pendingProfile();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    profile.resolve({ ok: true, status: 200, json } as unknown as Response);
    await hooks.settle();
    expect(json).toHaveBeenCalledOnce();
    route.query = "date=2026-09-25&meal=lunch";
    hooks.render();
    await hooks.settle();
    body.resolve(await session("Pacific/Honolulu").json());
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    expect(button("Confirm 2026-09-25 as local day").props.disabled).toBe(true);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });

  it.each([
    ["route", 200],
    ["route", 401],
    ["unmount", 200],
    ["unmount", 401],
  ] as const)("ignores profile headers after %s for status %s", async (retirement, status) => {
    const { profile, fetcher } = await pendingProfile();
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const json = vi.fn(() => session("Pacific/Honolulu").json());
    if (retirement === "route") {
      route.query = "date=2026-09-25&meal=lunch";
      hooks.renderWithoutEffects();
    } else {
      hooks.unmount();
    }
    const writes = hooks.afterClose();
    profile.resolve({ ok: status === 200, status, json } as unknown as Response);
    await hooks.settle();
    expect(json).not.toHaveBeenCalled();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(authCount(fetcher)).toBe(2);
    if (retirement === "route") {
      expect(text()).not.toContain("Sign in to choose a quantity");
      expect(button("Confirm 2026-09-25 as local day").props.disabled).toBe(true);
    } else {
      expect(hooks.afterClose()).toBe(writes);
    }
  });

  it("ignores parsed profile settings after the page closes", async () => {
    const { profile, fetcher } = await pendingProfile();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    profile.resolve({ ok: true, status: 200, json } as unknown as Response);
    await hooks.settle();
    expect(json).toHaveBeenCalledOnce();
    hooks.unmount();
    const writes = hooks.afterClose();
    body.resolve(await session("Pacific/Honolulu").json());
    await hooks.settle();
    expect(hooks.afterClose()).toBe(writes);
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(authCount(fetcher)).toBe(2);
  });
});

describe("Food recent diary days", () => {
  async function mountReady(
    timeZone = "UTC",
    post?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session(timeZone);
      if (init?.method === "POST") {
        if (post) return post(url, init);
        const date = new URL(url, "https://fixture.invalid").searchParams.get("date") ?? "";
        const result = await savedMutation(init, date).json();
        result.data.entry.timeZone = "UTC";
        result.data.entry.localTime = new Date(result.data.entry.occurredAt)
          .toISOString()
          .slice(11, 19);
        return Response.json(result);
      }
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    return fetcher;
  }

  it.each([
    ["America/Los_Angeles", "2026-01-01T00:30:00Z", "2025-12-31", "2025-12-30"],
    ["Pacific/Kiritimati", "2026-01-01T12:30:00Z", "2026-01-02", "2026-01-01"],
    ["America/Chicago", "2026-03-09T05:30:00Z", "2026-03-09", "2026-03-08"],
    ["UTC", "2024-03-01T12:30:00Z", "2024-03-01", "2024-02-29"],
  ])("chooses calendar days in %s at %s", async (timeZone, now, today, yesterday) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const fetcher = await mountReady(timeZone);
    await change("quick-add-meal", "snacks");
    await change("quick-add-search-202-amount", "2.500000");
    invoke(button("Set diary date to today"));
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe(today);
    invoke(button("Set diary date to yesterday"));
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe(yesterday);
    expect(field("quick-add-meal").props.value).toBe("snacks");
    expect(field("quick-add-search-202-amount").props.value).toBe("2.500000");
    expect(text()).toContain("Apple Pie");
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
  });

  it("reads the clock when clicked and submits only after an explicit Add", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const fetcher = await mountReady();
    const today = button("Set diary date to today");
    vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
    invoke(today);
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-10-01");
    expect(pendingPosts(fetcher)).toHaveLength(0);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toContain("date=2026-10-01");
    expect(text()).toContain("was added to Dinner on 2026-10-01");
    expect(operationId).toHaveBeenCalledOnce();
  });

  it.each(["loading", "signed-out", "unavailable"])(
    "keeps date choices inactive while session is %s",
    async (state) => {
      const auth = deferred<Response>();
      const fetcher = vi.fn(async (url: string) =>
        url === "/api/auth/me" ? auth.promise : publicResponse(url),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      if (state !== "loading") {
        auth.resolve(Response.json({}, { status: state === "signed-out" ? 401 : 503 }));
        await hooks.settle();
      }
      const today = button("Set diary date to today");
      expect(today.props.disabled).toBe(true);
      invoke(today);
      await hooks.settle();
      expect(field("quick-add-date").props.value).toBe("2026-09-24");
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
    },
  );

  it.each(["route", "unmount"])(
    "ignores a date shortcut retained before %s",
    async (retirement) => {
      const fetcher = await mountReady();
      const today = button("Set diary date to today");
      if (retirement === "route") {
        route.query = "date=2026-09-25&meal=lunch";
        hooks.renderWithoutEffects();
      } else {
        hooks.unmount();
      }
      invoke(today);
      if (retirement === "route") hooks.render();
      await hooks.settle();
      if (retirement === "route") expect(field("quick-add-date").props.value).toBe("2026-09-25");
      else expect(hooks.afterClose()).toBe(0);
      expect(pendingPosts(fetcher)).toHaveLength(0);
    },
  );

  it("ignores a retained shortcut during a pending add and enables it after failure", async () => {
    const response = deferred<Response>();
    const fetcher = await mountReady("UTC", () => response.promise);
    const today = button("Set diary date to today");
    invoke(button("Add 1 default serving of Apple Pie"));
    invoke(today);
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-24");
    expect(button("Set diary date to today").props.disabled).toBe(true);
    response.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(button("Set diary date to today").props.disabled).toBe(false);
    invoke(button("Set diary date to today"));
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    await change("quick-add-date", "2026-09-24");
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
    expect(posts[1]?.[1]?.headers).toEqual(posts[0]?.[1]?.headers);
    expect(operationId).toHaveBeenCalledOnce();
  });

  it("keeps the new day under review after choosing Yesterday following a timezone conflict", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const fetcher = await mountReady("UTC", async () =>
      Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 }),
    );
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const oldReview = button("Confirm 2026-09-24 as local day");
    invoke(button("Set diary date to yesterday"));
    invoke(oldReview);
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-29");
    expect(button("Confirm 2026-09-29 as local day").props.disabled).toBe(false);
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(1);
    invoke(button("Confirm 2026-09-29 as local day"));
    await hooks.settle();
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(false);
    expect(pendingPosts(fetcher)).toHaveLength(1);
  });
});

describe("Public food optional local time", () => {
  async function ready() {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST")
        return Response.json({ error: "Lost confirmation" }, { status: 503 });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    return fetcher;
  }

  it.each(["search", "barcode"])(
    "uses the shared explicit time when adding from %s",
    async (instance) => {
      const fetcher = await ready();
      if (instance === "barcode") {
        await change("food-barcode", "012345678905");
        const form = elements().find((node) => node.props.className === "barcodeForm");
        if (!form) throw new Error("Missing barcode form");
        invoke(form, "onSubmit", { preventDefault() {} });
        await hooks.settle();
      }
      await change("quick-add-time", "07:30");
      await change("quick-add-meal", "lunch");
      expect(pendingPosts(fetcher)).toHaveLength(0);
      const controls = elements().find(
        (node) =>
          node.type === "fieldset" &&
          elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
      );
      const add = controls && elements(controls).find((node) => node.type === "button");
      if (!add) throw new Error("Missing Add");
      invoke(add);
      await hooks.settle();
      const posts = pendingPosts(fetcher);
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
        foodVersionId: "202",
        mealSlot: "lunch",
        occurredAt: "2026-09-24T12:30:00.000Z",
      });
      expect(field("quick-add-time").props.value).toBe("07:30");
      expect(operationId).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["2026-09-24", "07:30 ", "Invalid local"],
    ["2026-03-08", "02:30", "does not exist"],
    ["2026-11-01", "01:30", "Choose Earlier or Later"],
  ])("rejects %s at %j before creating an operation", async (date, time, message) => {
    const fetcher = await ready();
    await change("quick-add-date", date);
    await change("quick-add-time", time);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(text()).toContain(message);
    expect(field("quick-add-time").props.value).toBe(time);
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
  });

  it.each([
    ["Earlier occurrence · UTC−05:00", "2026-11-01T06:30:00.000Z"],
    ["Later occurrence · UTC−06:00", "2026-11-01T07:30:00.000Z"],
  ])("logs the explicitly selected %s", async (choice, instant) => {
    const fetcher = await ready();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    invoke(button(choice));
    await hooks.settle();
    expect(button(choice).props["aria-pressed"]).toBe(true);
    expect(pendingPosts(fetcher)).toHaveLength(0);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body)).occurredAt).toBe(instant);
  });

  it("keeps automatic and entered-time retries independent after changing the clock and time choice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    const fetcher = await ready();
    await change("quick-add-date", "2026-11-01");
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    await change("quick-add-time", "01:30");
    for (const choice of [
      "Earlier occurrence · UTC−05:00",
      "Later occurrence · UTC−06:00",
      "Earlier occurrence · UTC−05:00",
    ]) {
      invoke(button(choice));
      await hooks.settle();
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
    }
    vi.setSystemTime(new Date("2026-11-01T08:55:00Z"));
    await change("quick-add-time", "");
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(5);
    expect(JSON.parse(String(posts[0]?.[1]?.body)).occurredAt).toBe("2026-11-01T07:30:45.123Z");
    expect(posts[3]?.[1]?.body).toBe(posts[1]?.[1]?.body);
    expect(posts[3]?.[1]?.headers).toEqual(posts[1]?.[1]?.headers);
    expect(posts[4]?.[1]?.body).toBe(posts[0]?.[1]?.body);
    expect(posts[4]?.[1]?.headers).toEqual(posts[0]?.[1]?.headers);
    expect(operationId).toHaveBeenCalledTimes(3);
  });

  it.each(["date", "time", "route", "unmount"])(
    "retires a time choice across %s",
    async (retirement) => {
      const fetcher = await ready();
      await change("quick-add-date", "2026-11-01");
      await change("quick-add-time", "01:30");
      invoke(button("Later occurrence · UTC−06:00"));
      await hooks.settle();
      const earlier = button("Earlier occurrence · UTC−05:00");
      const oldTime = field("quick-add-time");
      if (retirement === "date") {
        await change("quick-add-date", "2026-11-02");
        await change("quick-add-date", "2026-11-01");
      }
      if (retirement === "time") {
        await change("quick-add-time", "01:31");
        await change("quick-add-time", "01:30");
      }
      if (retirement === "route") {
        route.query = "date=2026-11-01&meal=lunch";
        hooks.renderWithoutEffects();
      }
      if (retirement === "unmount") hooks.unmount();
      invoke(earlier);
      if (retirement === "unmount") invoke(oldTime, "onChange", { target: { value: "02:00" } });
      else if (retirement === "route") hooks.render();
      await hooks.settle();
      if (retirement === "unmount") expect(hooks.afterClose()).toBe(0);
      else {
        expect(button("Earlier occurrence · UTC−05:00").props["aria-pressed"]).toBe(false);
        expect(button("Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(false);
      }
      expect(pendingPosts(fetcher)).toHaveLength(0);
    },
  );

  it("retains the occurrence after current no-op coordinate controls", async () => {
    await ready();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    invoke(button("Later occurrence · UTC−06:00"));
    await hooks.settle();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    expect(button("Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(true);
  });

  it("rejects an incomplete native time before an operation or write even when its value is blank", async () => {
    const fetcher = await ready();
    const ref = field("quick-add-time").props.ref as { current: unknown };
    const focus = vi.fn();
    ref.current = { validity: { valid: false }, focus };
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(text()).toContain("Complete the local time");
    expect(field("quick-add-time").props.value).toBe("");
    expect(focus).toHaveBeenCalledOnce();
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
  });

  it("preserves the raw time but requires a new-zone occurrence and confirmation after a no-write conflict", async () => {
    const fetcher = await ready();
    const original = fetcher.getMockImplementation();
    if (!original) throw new Error("Missing fetch fixture");
    let posts = 0;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return Response.json(
          posts === 1 ? { code: "DIARY_TIME_ZONE_CHANGED" } : { error: "Lost confirmation" },
          { status: posts === 1 ? 409 : 503 },
        );
      }
      return url === "/api/auth/me" && posts > 0
        ? session("America/New_York")
        : original(url, init);
    });
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    invoke(button("Later occurrence · UTC−06:00"));
    await hooks.settle();
    const oldChoice = button("Earlier occurrence · UTC−05:00");
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(field("quick-add-time").props.value).toBe("01:30");
    expect(button("Earlier occurrence · UTC−04:00").props["aria-pressed"]).toBe(false);
    expect(button("Later occurrence · UTC−05:00").props["aria-pressed"]).toBe(false);
    invoke(oldChoice);
    invoke(button("Confirm 2026-11-01 at 01:30 in America/New_York"));
    await hooks.settle();
    expect(text()).toContain("Choose Earlier or Later");
    expect(button("Add 1 default serving of Apple Pie").props.disabled).toBe(true);
    expect(operationId).toHaveBeenCalledOnce();
    invoke(button("Later occurrence · UTC−05:00"));
    await hooks.settle();
    invoke(button("Confirm 2026-11-01 at 01:30 in America/New_York"));
    await hooks.settle();
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const requests = pendingPosts(fetcher);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]?.[1]?.body)).occurredAt).toBe("2026-11-01T06:30:00.000Z");
    expect(requests[1]?.[1]?.headers).toMatchObject({
      "x-expected-profile-time-zone": "America/New_York",
    });
    expect(operationId).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["2026-09-24", "07:30", null, "2026-09-24T12:30:00.000Z"],
    ["2026-11-01", "01:30", "Later occurrence · UTC−06:00", "2026-11-01T07:30:00.000Z"],
  ])(
    "accepts only the matching explicit receipt for %s %s and permits a later fresh Add",
    async (date, time, choice, instant) => {
      const fetcher = await ready();
      const original = fetcher.getMockImplementation();
      if (!original) throw new Error("Missing fetch fixture");
      fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const result = await savedMutation(init, date).json();
          result.data.entry.localTime = `${time}:00`;
          return Response.json(result);
        }
        return original(url, init);
      });
      await change("quick-add-date", date);
      await change("quick-add-time", time);
      if (choice) {
        invoke(button(choice));
        await hooks.settle();
      }
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
      expect(text()).toContain(`was added to Dinner on ${date}`);
      expect(field("quick-add-time").props.value).toBe(time);
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
      const posts = pendingPosts(fetcher);
      expect(posts).toHaveLength(2);
      for (const [, init] of posts) expect(JSON.parse(String(init?.body)).occurredAt).toBe(instant);
      expect(new Headers(posts[1]?.[1]?.headers).get("idempotency-key")).not.toBe(
        new Headers(posts[0]?.[1]?.headers).get("idempotency-key"),
      );
      expect(operationId).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["time", "occurrence"])(
    "ignores an Add retained before a newer %s choice renders",
    async (changeKind) => {
      const fetcher = await ready();
      if (changeKind === "occurrence") {
        await change("quick-add-date", "2026-11-01");
        await change("quick-add-time", "01:30");
        invoke(button("Earlier occurrence · UTC−05:00"));
        await hooks.settle();
      }
      const oldAdd = button("Add 1 default serving of Apple Pie");
      if (changeKind === "time")
        invoke(field("quick-add-time"), "onChange", { target: { value: "07:30" } });
      else invoke(button("Later occurrence · UTC−06:00"));
      invoke(oldAdd);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body)).occurredAt).toBe(
        changeKind === "time" ? "2026-09-24T12:30:00.000Z" : "2026-11-01T07:30:00.000Z",
      );
    },
  );
});

describe("Food saved receipt clock", () => {
  async function openReady(response: "success" | "503" | "wrong-instant" = "success") {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST") {
        if (response === "503")
          return Response.json({ error: "Lost confirmation" }, { status: 503 });
        const saved = await savedMutation(init, "2026-11-01").json();
        saved.data.entry.localTime = "01:30:00";
        if (response === "wrong-instant") saved.data.entry.occurredAt = "2026-11-01T08:30:00.000Z";
        return Response.json(saved);
      }
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    return fetcher;
  }
  function confirmedProps() {
    return elements()
      .filter((node) => node.type === FoodAddConfirmation)
      .map((node) => node.props.confirmation)
      .filter(Boolean) as Array<{
      localDate: string;
      occurredAt: string;
      timeZone: string;
      message: string;
    }>;
  }
  it.each([
    ["search", "Earlier occurrence · UTC−05:00", "2026-11-01T06:30:00.000Z"],
    ["barcode", "Later occurrence · UTC−06:00", "2026-11-01T07:30:00.000Z"],
  ])(
    "keeps the matched %s receipt independent of later draft changes",
    async (instance, choice, instant) => {
      const fetcher = await openReady();
      if (instance === "barcode") {
        await change("food-barcode", "012345678905");
        const form = elements().find((node) => node.props.className === "barcodeForm");
        if (!form) throw new Error("Missing barcode form");
        invoke(form, "onSubmit", { preventDefault() {} });
        await hooks.settle();
      }
      invoke(button(choice));
      await hooks.settle();
      const controls = elements().find(
        (node) =>
          node.type === "fieldset" &&
          elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
      );
      const add = controls && elements(controls).find((node) => node.type === "button");
      if (!add) throw new Error("Missing Add");
      invoke(add);
      await hooks.settle();
      expect(confirmedProps()).toHaveLength(1);
      expect(confirmedProps()[0]).toMatchObject({
        localDate: "2026-11-01",
        occurredAt: instant,
        timeZone: "America/Chicago",
      });
      await change("quick-add-date", "2026-11-02");
      await change("quick-add-time", "09:00");
      expect(confirmedProps()[0]).toMatchObject({
        localDate: "2026-11-01",
        occurredAt: instant,
        timeZone: "America/Chicago",
      });
      expect(pendingPosts(fetcher)).toHaveLength(1);
    },
  );
  it.each(["503", "wrong-instant"] as const)(
    "shows no saved clock for an unconfirmed %s result",
    async (response) => {
      const fetcher = await openReady(response);
      invoke(button("Later occurrence · UTC−06:00"));
      await hooks.settle();
      invoke(button("Add 1 default serving of Apple Pie"));
      await hooks.settle();
      expect(confirmedProps()).toHaveLength(0);
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(field("quick-add-time").props.value).toBe("01:30");
    },
  );
});

describe("Current food portion draft actions", () => {
  async function ready(twoFoods = false) {
    const second = {
      ...hit,
      foodId: "403",
      foodVersionId: "404",
      name: "Other food",
      defaultServing: { ...hit.defaultServing, servingId: "405" },
    };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST")
        return Response.json({ error: "Lost confirmation" }, { status: 503 });
      if (twoFoods && url.startsWith("/api/foods/search?"))
        return Response.json({ data: [hit, second], page: { nextCursor: null } });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    await change("food-barcode", "012345678905");
    const form = elements().find((node) => node.props.className === "barcodeForm");
    if (!form) throw new Error("Missing barcode form");
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    return fetcher;
  }
  function addFor(instance: string, id = "202") {
    const controls = elements().find(
      (node) =>
        node.type === "fieldset" &&
        elements(node).some((child) => child.props.id === `quick-add-${instance}-${id}-amount`),
    );
    const add = controls && elements(controls).find((node) => node.type === "button");
    if (!add) throw new Error("Missing Add");
    return add;
  }
  it.each([
    ["search", "amount"],
    ["search", "kind"],
    ["barcode", "amount"],
    ["barcode", "kind"],
  ])("rejects a prior Add before a newer %s %s renders", async (instance, part) => {
    const fetcher = await ready();
    const oldAdd = addFor(instance);
    invoke(field(`quick-add-${instance}-202-${part}`), "onChange", {
      target: { value: part === "amount" ? "2.500000" : "grams" },
    });
    invoke(oldAdd);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
    invoke(addFor(instance));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body)).portion).toEqual(
      part === "amount"
        ? { kind: "serving", servingId: "303", amount: "2.5" }
        : { kind: "grams", grams: "1" },
    );
  });

  it.each(["amount", "kind"])(
    "retires an old %s control through an edit-and-restore cycle",
    async (part) => {
      await ready();
      const id = `quick-add-search-202-${part}`;
      const old = field(id);
      await change(id, part === "amount" ? "2.500000" : "grams");
      await change(id, part === "amount" ? "1" : "serving");
      invoke(old, "onChange", { target: { value: part === "amount" ? "9" : "grams" } });
      await hooks.settle();
      expect(field(id).props.value).toBe(part === "amount" ? "1" : "serving");
    },
  );
  it.each(["amount", "kind"])(
    "keeps same-value %s controls and the current Add usable",
    async (part) => {
      const fetcher = await ready();
      const add = addFor("search");
      invoke(field(`quick-add-search-202-${part}`), "onChange", {
        target: { value: part === "amount" ? "1" : "serving" },
      });
      invoke(add);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(operationId).toHaveBeenCalledOnce();
    },
  );
  it("shares draft retirement between search and barcode", async () => {
    const fetcher = await ready();
    const oldBarcodeAdd = addFor("barcode");
    invoke(field("quick-add-search-202-amount"), "onChange", { target: { value: "2.500000" } });
    invoke(oldBarcodeAdd);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(field("quick-add-barcode-202-amount").props.value).toBe("2.500000");
    invoke(addFor("barcode"));
    await hooks.settle();
    expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body)).portion.amount).toBe("2.5");
  });
  it("keeps the submitted portion fixed when retained inputs fire before the pending view renders", async () => {
    const fetcher = await ready();
    const amount = field("quick-add-search-202-amount");
    const kind = field("quick-add-search-202-kind");
    invoke(addFor("search"));
    invoke(amount, "onChange", { target: { value: "9" } });
    invoke(kind, "onChange", { target: { value: "grams" } });
    await hooks.settle();
    expect(field("quick-add-search-202-amount").props.value).toBe("1");
    expect(field("quick-add-search-202-kind").props.value).toBe("serving");
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body)).portion).toEqual({
      kind: "serving",
      servingId: "303",
      amount: "1",
    });
  });
  it.each(["route", "unmount"])("ignores portion input retained across %s", async (retirement) => {
    const fetcher = await ready();
    const old = field("quick-add-search-202-amount");
    if (retirement === "route") {
      route.query = "date=2026-09-25&meal=lunch";
      hooks.renderWithoutEffects();
    } else hooks.unmount();
    invoke(old, "onChange", { target: { value: "9" } });
    if (retirement === "route") hooks.render();
    await hooks.settle();
    expect(field("quick-add-search-202-amount").props.value).toBe("1");
    expect(hooks.afterClose()).toBe(0);
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("keeps a different pinned food's unchanged Add independent of an edited portion", async () => {
    const fetcher = await ready(true);
    const otherAdd = addFor("search", "404");
    invoke(field("quick-add-search-202-amount"), "onChange", { target: { value: "2.500000" } });
    invoke(otherAdd);
    await hooks.settle();
    expect(field("quick-add-search-202-amount").props.value).toBe("2.500000");
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body))).toMatchObject({
      foodVersionId: "404",
      portion: { kind: "serving", servingId: "405", amount: "1" },
    });
  });
});

describe("Current food meal draft actions", () => {
  async function ready() {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST")
        return Response.json({ error: "Lost confirmation" }, { status: 503 });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    await change("food-barcode", "012345678905");
    const form = elements().find((node) => node.props.className === "barcodeForm");
    if (!form) throw new Error("Missing barcode form");
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    return fetcher;
  }
  function mealAdd(instance: string) {
    const controls = elements().find(
      (node) =>
        node.type === "fieldset" &&
        elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
    );
    const add = controls && elements(controls).find((node) => node.type === "button");
    if (!add) throw new Error("Missing Add");
    return add;
  }
  it.each(["search", "barcode"])(
    "rejects an old %s Add before a new meal renders",
    async (instance) => {
      const fetcher = await ready();
      const oldAdd = mealAdd(instance);
      invoke(field("quick-add-meal"), "onChange", { target: { value: "snacks" } });
      invoke(oldAdd);
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
      invoke(mealAdd(instance));
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body)).mealSlot).toBe("snacks");
    },
  );
  it("retires an old meal input after editing and restoring its value", async () => {
    await ready();
    const oldMeal = field("quick-add-meal");
    const initial = String(oldMeal.props.value);
    await change("quick-add-meal", "snacks");
    await change("quick-add-meal", initial);
    invoke(oldMeal, "onChange", { target: { value: "snacks" } });
    await hooks.settle();
    expect(field("quick-add-meal").props.value).toBe(initial);
  });
  it.each(["route", "unmount"])("ignores meal actions retained across %s", async (retirement) => {
    const fetcher = await ready();
    const oldMeal = field("quick-add-meal");
    const initial = oldMeal.props.value;
    if (retirement === "route") {
      route.query = "date=2026-09-25&meal=lunch";
      hooks.renderWithoutEffects();
    } else hooks.unmount();
    invoke(oldMeal, "onChange", { target: { value: "snacks" } });
    if (retirement === "route") hooks.render();
    await hooks.settle();
    expect(field("quick-add-meal").props.value).toBe(retirement === "route" ? "lunch" : initial);
    expect(hooks.afterClose()).toBe(0);
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("keeps same-value meal choices and the current Add usable", async () => {
    const fetcher = await ready();
    const add = mealAdd("search");
    invoke(field("quick-add-meal"), "onChange", {
      target: { value: field("quick-add-meal").props.value },
    });
    invoke(add);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(operationId).toHaveBeenCalledOnce();
  });
  it("preserves the submitted meal and its exact retry while editing a pending meal draft", async () => {
    const post = deferred<Response>();
    const fetcher = await ready();
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return pendingPosts(fetcher).length === 1
          ? post.promise
          : Response.json({}, { status: 503 });
      return publicResponse(url);
    });
    const initial = String(field("quick-add-meal").props.value);
    invoke(mealAdd("search"));
    await hooks.settle();
    const original = pendingPosts(fetcher)[0]?.[1];
    await change("quick-add-meal", "snacks");
    expect(field("quick-add-meal").props.value).toBe("snacks");
    post.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    await change("quick-add-meal", initial);
    invoke(mealAdd("search"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(original?.body);
    expect(posts[1]?.[1]?.headers).toEqual(original?.headers);
    expect(JSON.parse(String(original?.body)).mealSlot).toBe(initial);
    expect(operationId).toHaveBeenCalledOnce();
  });
  it("keeps a meal selected while initial session discovery is pending", async () => {
    route.query = "date=2026-09-24";
    const auth = deferred<Response>();
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? auth.promise : publicResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("quick-add-meal", "snacks");
    auth.resolve(session());
    await hooks.settle();
    expect(field("quick-add-meal").props.value).toBe("snacks");
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("keeps an explicitly chosen repeated minute after a meal edit", async () => {
    const fetcher = await ready();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    const later = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Later occurrence"),
    );
    if (!later) throw new Error("Missing Later occurrence");
    invoke(later);
    await hooks.settle();
    await change("quick-add-meal", "snacks");
    const chosen = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Later occurrence"),
    );
    expect(chosen?.props["aria-pressed"]).toBe(true);
    invoke(mealAdd("search"));
    await hooks.settle();
    expect(JSON.parse(String(pendingPosts(fetcher)[0]?.[1]?.body))).toMatchObject({
      mealSlot: "snacks",
      occurredAt: "2026-11-01T07:30:00.000Z",
    });
  });
});

describe("Current food manual date actions", () => {
  async function ready() {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return session();
      if (init?.method === "POST") return Response.json({}, { status: 503 });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await search();
    return fetcher;
  }
  it("retires the old date input before a newer day renders", async () => {
    await ready();
    const old = field("quick-add-date");
    invoke(old, "onChange", { target: { value: "2026-09-25" } });
    invoke(old, "onChange", { target: { value: "2026-09-26" } });
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
  });
  it("does not revive a date input after editing and restoring its day", async () => {
    await ready();
    const old = field("quick-add-date");
    await change("quick-add-date", "2026-09-25");
    await change("quick-add-date", "2026-09-24");
    invoke(old, "onChange", { target: { value: "2026-09-26" } });
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-24");
  });
  it("rejects a date input retained from a previous route", async () => {
    await ready();
    const old = field("quick-add-date");
    route.query = "date=2026-09-25&meal=lunch";
    hooks.render();
    await hooks.settle();
    invoke(old, "onChange", { target: { value: "2026-09-26" } });
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
  });
  it("does not write date state after the page closes", async () => {
    const fetcher = await ready();
    const old = field("quick-add-date");
    hooks.unmount();
    invoke(old, "onChange", { target: { value: "2026-09-25" } });
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("keeps a same-value date event and the current Add usable", async () => {
    const fetcher = await ready();
    const add = button("Add 1 default serving of Apple Pie");
    invoke(field("quick-add-date"), "onChange", { target: { value: "2026-09-24" } });
    invoke(add);
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(1);
    expect(operationId).toHaveBeenCalledOnce();
  });
  it("keeps the day selected while the initial profile loads", async () => {
    route.query = "meal=dinner";
    const auth = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/auth/me" ? auth.promise : publicResponse(url))),
    );
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("quick-add-date", "2026-09-25");
    auth.resolve(session());
    await hooks.settle();
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
  });
  it("preserves the pending day's request when its editable date changes", async () => {
    const fetcher = await ready();
    const post = deferred<Response>();
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return pendingPosts(fetcher).length === 1
          ? post.promise
          : Response.json({}, { status: 503 });
      return publicResponse(url);
    });
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const original = pendingPosts(fetcher)[0];
    await change("quick-add-date", "2026-09-25");
    expect(field("quick-add-date").props.value).toBe("2026-09-25");
    post.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    await change("quick-add-date", "2026-09-24");
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    const posts = pendingPosts(fetcher);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[0]).toBe(original?.[0]);
    expect(posts[1]?.[1]?.body).toBe(original?.[1]?.body);
    expect(posts[1]?.[1]?.headers).toEqual(original?.[1]?.headers);
    expect(operationId).toHaveBeenCalledOnce();
  });
  it("clears a chosen repeated-minute occurrence only when the manual day changes", async () => {
    const fetcher = await ready();
    await change("quick-add-date", "2026-11-01");
    await change("quick-add-time", "01:30");
    const later = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Later occurrence"),
    );
    if (!later) throw new Error("Missing Later occurrence");
    invoke(later);
    await hooks.settle();
    await change("quick-add-date", "2026-11-01");
    expect(
      elements().find((node) => node.type === "button" && text(node).startsWith("Later occurrence"))
        ?.props["aria-pressed"],
    ).toBe(true);
    await change("quick-add-date", "2026-11-02");
    await change("quick-add-date", "2026-11-01");
    const freshLater = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Later occurrence"),
    );
    expect(freshLater?.props["aria-pressed"]).toBe(false);
    invoke(button("Add 1 default serving of Apple Pie"));
    await hooks.settle();
    expect(pendingPosts(fetcher)).toHaveLength(0);
    expect(operationId).not.toHaveBeenCalled();
  });
});

describe("Closed food lookup actions", () => {
  it.each(["search", "more", "suggestion", "intent", "barcode", "query-input", "barcode-input"])(
    "ignores a retained %s action after the page closes",
    async (action) => {
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/auth/me") return session();
        if (url.startsWith("/api/foods/search?"))
          return Response.json({ data: [hit], page: { nextCursor: "lifecycle_cursor" } });
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await change("food-query", "apple");
      for (const callback of timers.values()) callback();
      timers.clear();
      await hooks.settle();
      const suggestion = elements().find(
        (node) => node.type === "button" && text(node).startsWith("Apple Pie"),
      );
      if (!suggestion) throw new Error("Missing suggestion");
      const form = elements().find(
        (node) => node.type === "form" && node.props["aria-label"] === "Food search",
      );
      if (!form) throw new Error("Missing search form");
      invoke(form, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      await change("food-barcode", "012345678905");
      const barcodeForm = elements().find((node) => node.props.className === "barcodeForm");
      const intent = elements().find(
        (node) => node.props.name === "food-intent" && node.props.value === "generic",
      );
      if (!barcodeForm || !intent) throw new Error("Missing public lookup control");
      const actions: Record<string, () => unknown> = {
        search: () => invoke(form, "onSubmit", { preventDefault() {} }),
        more: () => invoke(button("Load more results")),
        suggestion: () => invoke(suggestion),
        intent: () => invoke(intent, "onChange"),
        barcode: () => invoke(barcodeForm, "onSubmit", { preventDefault() {} }),
        "query-input": () => invoke(field("food-query"), "onChange", { target: { value: "pear" } }),
        "barcode-input": () =>
          invoke(field("food-barcode"), "onChange", { target: { value: "12345678" } }),
      };
      const act = actions[action];
      if (!act) throw new Error("Missing action");
      const reads = fetcher.mock.calls.length;
      hooks.unmount();
      act();
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(reads);
      expect(hooks.afterClose()).toBe(0);
      expect(pendingPosts(fetcher)).toHaveLength(0);
      expect(operationId).not.toHaveBeenCalled();
    },
  );
});

describe("Current food suggestion ownership", () => {
  async function suggested() {
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : publicResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("food-query", "apple");
    for (const callback of timers.values()) callback();
    timers.clear();
    await hooks.settle();
    const suggestion = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Apple Pie"),
    );
    if (!suggestion) throw new Error("Missing suggestion");
    return { fetcher, suggestion };
  }
  function searches(fetcher: ReturnType<typeof vi.fn>) {
    return fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/foods/search?"));
  }
  it.each(["query", "intent", "restore"])("retires a suggestion after %s changes", async (kind) => {
    const { fetcher, suggestion } = await suggested();
    if (kind === "intent") {
      const radio = elements().find(
        (node) => node.props.name === "food-intent" && node.props.value === "generic",
      );
      if (!radio) throw new Error("Missing intent");
      invoke(radio, "onChange");
    } else if (kind === "restore") {
      await change("food-query", "pear");
      await change("food-query", "apple");
    } else invoke(field("food-query"), "onChange", { target: { value: "pear" } });
    invoke(suggestion);
    await hooks.settle();
    expect(searches(fetcher)).toHaveLength(0);
    expect(field("food-query").props.value).toBe(kind === "query" ? "pear" : "apple");
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it.each(["selection", "manual-search"])("consumes the old suggestion after %s", async (kind) => {
    const { fetcher, suggestion } = await suggested();
    if (kind === "selection") invoke(suggestion);
    else {
      const form = elements().find(
        (node) => node.type === "form" && node.props["aria-label"] === "Food search",
      );
      if (!form) throw new Error("Missing search form");
      invoke(form, "onSubmit", { preventDefault() {} });
    }
    invoke(suggestion);
    await hooks.settle();
    expect(searches(fetcher)).toHaveLength(1);
    expect(field("food-query").props.value).toBe(kind === "selection" ? "Apple Pie" : "apple");
    expect(text()).toContain("Apple Pie");
  });
  it("keeps a current suggestion after a same-value query event", async () => {
    const { fetcher, suggestion } = await suggested();
    invoke(field("food-query"), "onChange", { target: { value: "apple" } });
    invoke(suggestion);
    await hooks.settle();
    expect(searches(fetcher)).toHaveLength(1);
    expect(field("food-query").props.value).toBe("Apple Pie");
  });
});

describe("Current barcode draft actions", () => {
  function form() {
    const result = elements().find((node) => node.props.className === "barcodeForm");
    if (!result) throw new Error("Missing barcode form");
    return result;
  }
  function submit(node: ElementNode) {
    invoke(node, "onSubmit", { preventDefault() {} });
  }
  function barcodeReads(fetcher: ReturnType<typeof vi.fn>) {
    return fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/foods/barcodes/"));
  }
  async function ready() {
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : publicResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("food-barcode", "012345678905");
    return fetcher;
  }
  it("retires an old form before changed barcode digits render", async () => {
    const fetcher = await ready();
    const old = form();
    invoke(field("food-barcode"), "onChange", { target: { value: "036000291452" } });
    submit(old);
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(0);
    expect(field("food-barcode").props.value).toBe("036000291452");
    submit(form());
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(1);
    expect(barcodeReads(fetcher)[0]?.[0]).toContain("036000291452");
  });
  it("does not revive an old form after editing and restoring the code", async () => {
    const fetcher = await ready();
    const old = form();
    await change("food-barcode", "036000291452");
    await change("food-barcode", "012345678905");
    submit(old);
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(0);
  });
  it("does not let an old input overwrite newer restored digits", async () => {
    await ready();
    const old = field("food-barcode");
    await change("food-barcode", "036000291452");
    await change("food-barcode", "012345678905");
    invoke(old, "onChange", { target: { value: "036000291452" } });
    await hooks.settle();
    expect(field("food-barcode").props.value).toBe("012345678905");
  });
  it("keeps a same-value barcode input and current form usable", async () => {
    const fetcher = await ready();
    const current = form();
    invoke(field("food-barcode"), "onChange", { target: { value: "012345678905" } });
    submit(current);
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(1);
    expect(text()).toContain("Found Apple Pie.");
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("keeps an earlier lookup owned until a fresh form replaces it", async () => {
    const fetcher = await ready();
    const held = deferred<Response>();
    let firstSignal: AbortSignal | null | undefined;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("012345678905")) {
        firstSignal = init?.signal;
        return held.promise;
      }
      return publicResponse(url);
    });
    const old = form();
    submit(old);
    await hooks.settle();
    await change("food-barcode", "036000291452");
    submit(old);
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(1);
    expect(firstSignal?.aborted).toBe(false);
    submit(form());
    await hooks.settle();
    expect(barcodeReads(fetcher)).toHaveLength(2);
    expect(firstSignal?.aborted).toBe(true);
    held.resolve(Response.json({ data: { ...hit, name: "Retired lookup" } }));
    await hooks.settle();
    expect(text()).not.toContain("Retired lookup");
    expect(text()).toContain("Found Apple Pie.");
    expect(operationId).not.toHaveBeenCalled();
  });
});

describe("Current public search draft actions", () => {
  function form() {
    const result = elements().find(
      (node) => node.type === "form" && node.props["aria-label"] === "Food search",
    );
    if (!result) throw new Error("Missing search form");
    return result;
  }
  function submit(node: ElementNode) {
    invoke(node, "onSubmit", { preventDefault() {} });
  }
  function radio(value: string) {
    const result = elements().find(
      (node) => node.props.name === "food-intent" && node.props.value === value,
    );
    if (!result) throw new Error("Missing intent");
    return result;
  }
  function reads(fetcher: ReturnType<typeof vi.fn>) {
    return fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/foods/search?"));
  }
  async function ready() {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return session();
      if (url.startsWith("/api/foods/search?"))
        return Response.json({ data: [hit], page: { nextCursor: "draft_cursor" } });
      return publicResponse(url);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(FoodSearchClient);
    await hooks.settle();
    await change("food-query", "apple");
    return fetcher;
  }
  it("rejects an old search form before new text renders and uses the fresh form", async () => {
    const fetcher = await ready();
    const old = form();
    invoke(field("food-query"), "onChange", { target: { value: "pear" } });
    submit(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(0);
    submit(form());
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(1);
    expect(
      new URL(String(reads(fetcher)[0]?.[0]), "https://fixture.invalid").searchParams.get("query"),
    ).toBe("pear");
  });
  it("does not revive an old form after query edit-and-restore", async () => {
    const fetcher = await ready();
    const old = form();
    await change("food-query", "pear");
    await change("food-query", "apple");
    submit(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(0);
  });
  it("does not let an old query input overwrite a restored draft", async () => {
    await ready();
    const old = field("food-query");
    await change("food-query", "pear");
    await change("food-query", "apple");
    invoke(old, "onChange", { target: { value: "banana" } });
    await hooks.settle();
    expect(field("food-query").props.value).toBe("apple");
  });
  it("rejects an old form before a changed food type renders", async () => {
    const fetcher = await ready();
    const old = form();
    invoke(radio("generic"), "onChange");
    submit(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(0);
    submit(form());
    await hooks.settle();
    expect(
      new URL(String(reads(fetcher)[0]?.[0]), "https://fixture.invalid").searchParams.get("intent"),
    ).toBe("generic");
  });
  it("does not revive an old type control after type edit-and-restore", async () => {
    await ready();
    const old = radio("generic");
    invoke(old, "onChange");
    await hooks.settle();
    invoke(radio("all"), "onChange");
    await hooks.settle();
    invoke(old, "onChange");
    await hooks.settle();
    expect(radio("all").props.checked).toBe(true);
  });
  it("keeps a suggestion search from being replaced by its old manual form", async () => {
    const fetcher = await ready();
    const old = form();
    for (const callback of timers.values()) callback();
    timers.clear();
    await hooks.settle();
    const suggestion = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Apple Pie"),
    );
    if (!suggestion) throw new Error("Missing suggestion");
    invoke(suggestion);
    submit(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(1);
    expect(
      new URL(String(reads(fetcher)[0]?.[0]), "https://fixture.invalid").searchParams.get("query"),
    ).toBe("Apple Pie");
  });
  it("ignores pagination retained before changing food type", async () => {
    const fetcher = await ready();
    submit(form());
    await hooks.settle();
    const old = button("Load more results");
    invoke(radio("generic"), "onChange");
    invoke(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(1);
    expect(text()).not.toContain("1 result shown");
  });
  it("keeps results and current form after choosing the same food type", async () => {
    const fetcher = await ready();
    submit(form());
    await hooks.settle();
    const current = form();
    invoke(radio("all"), "onChange");
    await hooks.settle();
    expect(text()).toContain("1 result shown");
    submit(current);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(2);
  });
  it("keeps the form usable after a same-value query event", async () => {
    const fetcher = await ready();
    const current = form();
    invoke(field("food-query"), "onChange", { target: { value: "apple" } });
    submit(current);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(1);
    expect(pendingPosts(fetcher)).toHaveLength(0);
  });
  it("retires its manual form even when a chosen suggestion equals the typed query", async () => {
    const fetcher = await ready();
    await change("food-query", "Apple Pie");
    for (const callback of timers.values()) callback();
    timers.clear();
    await hooks.settle();
    const old = form();
    const suggestion = elements().find(
      (node) => node.type === "button" && text(node).startsWith("Apple Pie"),
    );
    if (!suggestion) throw new Error("Missing suggestion");
    invoke(suggestion);
    submit(old);
    await hooks.settle();
    expect(reads(fetcher)).toHaveLength(1);
    expect(field("food-query").props.value).toBe("Apple Pie");
  });
});

describe("Public Add provenance", () => {
  it.each(["search", "barcode"])(
    "retains exact %s retry when a private-food receipt reuses the version ID",
    async (instance) => {
      let privateReceipt = true;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          const receipt = await savedMutation(init).json();
          if (privateReceipt) {
            receipt.data.entry.source = null;
            receipt.data.entry.foodProvenance = {
              kind: "private_custom",
              customFoodId: "3bcfa2bf-4950-43f7-9f24-000000000001",
              customFoodVersionNumber: 1,
            };
          }
          return Response.json(receipt);
        }
        return publicResponse(url);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(FoodSearchClient);
      await hooks.settle();
      await search();
      if (instance === "barcode") {
        await change("food-barcode", "012345678905");
        const form = elements().find((node) => node.props.className === "barcodeForm");
        if (!form) throw new Error("Missing barcode form");
        invoke(form, "onSubmit", { preventDefault() {} });
        await hooks.settle();
      }
      const currentAdd = () => {
        const controls = elements().find(
          (node) =>
            node.type === "fieldset" &&
            elements(node).some((child) => child.props.id === `quick-add-${instance}-202-amount`),
        );
        const add = controls && elements(controls).find((node) => node.type === "button");
        if (!add) throw new Error("Missing Add");
        return add;
      };
      const amount = field(`quick-add-${instance}-202-amount`).props.value;
      invoke(currentAdd());
      await hooks.settle();
      expect(pendingPosts(fetcher)).toHaveLength(1);
      expect(text()).not.toContain("was added to Dinner");
      expect(
        elements().filter((node) => node.type === FoodAddConfirmation && node.props.confirmation),
      ).toHaveLength(0);
      expect(field(`quick-add-${instance}-202-amount`).props.value).toBe(amount);
      expect(field("quick-add-date").props.value).toBe("2026-09-24");
      expect(field("quick-add-time").props.value).toBe("");
      privateReceipt = false;
      invoke(currentAdd());
      await hooks.settle();
      const posts = pendingPosts(fetcher);
      expect(posts).toHaveLength(2);
      expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
      expect(posts[1]?.[1]?.headers).toEqual(posts[0]?.[1]?.headers);
      expect(text()).toContain("was added to Dinner on 2026-09-24");
      expect(
        elements().filter((node) => node.type === FoodAddConfirmation && node.props.confirmation),
      ).toHaveLength(1);
      invoke(currentAdd());
      await hooks.settle();
      const fresh = pendingPosts(fetcher);
      expect(fresh).toHaveLength(3);
      expect(new Headers(fresh[2]?.[1]?.headers).get("idempotency-key")).not.toBe(
        new Headers(fresh[0]?.[1]?.headers).get("idempotency-key"),
      );
    },
  );
});
