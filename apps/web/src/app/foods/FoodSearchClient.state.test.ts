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

import { FoodSearchClient } from "./FoodSearchClient";

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
