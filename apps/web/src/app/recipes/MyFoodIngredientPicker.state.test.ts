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

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));

import type { CustomFood } from "../../lib/retention";
import { MyFoodIngredientPicker } from "./MyFoodIngredientPicker";

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
const timestamp = "2026-09-09T12:00:00.000Z";
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

function listResponse(
  items: readonly CustomFood[] = [personalFood],
  nextCursor: string | null = null,
) {
  return Response.json({ data: items, page: { nextCursor } });
}
const otherFood: CustomFood = {
  ...personalFood,
  id: "265b7531-95ca-4552-b283-4f356d5b42be",
  currentVersion: {
    ...personalFood.currentVersion,
    id: "880",
    name: "Banana puree",
    serving: null,
  },
};
const newerFood: CustomFood = {
  ...personalFood,
  revision: "8",
  currentVersion: {
    ...personalFood.currentVersion,
    id: "9007199254740997",
    versionNumber: 8,
    serving: { id: "9007199254740999", label: "new scoop", grams: "41.000001" },
  },
};
let props: Parameters<typeof MyFoodIngredientPicker>[0];
let onAdd = vi.fn<(food: CustomFood, mode: "grams" | "serving") => boolean>();
let onSessionClosed = vi.fn<() => void>();
function pickerFetcher() {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url === "/api/auth/me") return session();
    if (url.startsWith("/api/retention/custom-foods")) return listResponse();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function mount() {
  hooks.mount(() => MyFoodIngredientPicker(props));
  await hooks.settle();
}
function updateProps(
  change: Partial<Parameters<typeof MyFoodIngredientPicker>[0]>,
  effects = true,
) {
  props = { ...props, ...change };
  if (effects) hooks.render();
  else hooks.renderWithoutEffects();
}
function addButton(food = personalFood, mode: "grams" | "serving" = "grams") {
  const version = food.currentVersion;
  return field(
    mode === "grams"
      ? `Add 100 g of ${version.name} version ${version.versionNumber}`
      : `Add one ${version.serving?.label} of ${version.name} version ${version.versionNumber}`,
  );
}
function addButtons() {
  return elements().filter(
    (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("Add "),
  );
}
async function ready() {
  await mount();
  await click("Load my foods");
}
function foodReads(fetcher: ReturnType<typeof pickerFetcher>) {
  return fetcher.mock.calls.filter(([url]) => url.startsWith("/api/retention/custom-foods"));
}
beforeEach(() => {
  onAdd = vi.fn(() => true);
  onSessionClosed = vi.fn();
  props = { ownerUserId: owner, disabled: false, remainingCapacity: 50, onAdd, onSessionClosed };
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("My foods ingredient picker loading and choices", () => {
  it("loads only on demand and waits for post-read owner verification before exposing choices", async () => {
    const verification = deferred<Response>();
    const fetcher = pickerFetcher();
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me" ? verification.promise : listResponse(),
    );
    await mount();
    await hooks.settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(addButtons()).toHaveLength(0);
    await click("Load my foods");
    expect(
      fetcher.mock.calls.map(([url]) =>
        url.startsWith("/api/retention/custom-foods") ? "foods" : url,
      ),
    ).toEqual(["foods", "/api/auth/me"]);
    expect(addButtons()).toHaveLength(0);
    verification.resolve(session());
    await hooks.settle();
    expect(addButton().props.disabled).not.toBe(true);
    expect(text()).toContain("Personal oats");
    expect(text().toLowerCase()).toContain("archiv");
    expect(
      fetcher.mock.calls.every(
        ([url]) => url === "/api/auth/me" || url.startsWith("/api/retention/custom-foods"),
      ),
    ).toBe(true);
  });

  it("forwards exact immutable choices and unknown nutrients without public-source coercion", async () => {
    pickerFetcher();
    await ready();
    invoke(addButton(), "onClick");
    invoke(addButton(personalFood, "serving"), "onClick");
    expect(onAdd.mock.calls).toEqual([
      [personalFood, "grams"],
      [personalFood, "serving"],
    ]);
    expect(onAdd.mock.calls[0]?.[0].currentVersion.nutrients[0]).toMatchObject({
      state: "unknown",
      amountPer100Grams: null,
      reason: "not_analyzed",
    });
    expect(onAdd.mock.calls[1]?.[0].currentVersion.serving).toEqual({
      id: "9007199254740995",
      label: "scoop",
      grams: "40.125001",
    });
  });

  it("offers grams without inventing a serving and filters only loaded names", async () => {
    const fetcher = pickerFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation((url, init) =>
      url.startsWith("/api/retention/custom-foods")
        ? Promise.resolve(listResponse([personalFood, otherFood]))
        : original(url, init),
    );
    await ready();
    expect(addButtons()).toHaveLength(3);
    const requests = fetcher.mock.calls.length;
    await change("Filter loaded personal foods by name", "  BANANA  ");
    expect(addButtons()).toHaveLength(1);
    expect(addButton(otherFood)).toBeDefined();
    await change("Filter loaded personal foods by name", "Owner brand");
    expect(addButtons()).toHaveLength(0);
    await change("Filter loaded personal foods by name", "");
    expect(addButtons()).toHaveLength(3);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("shows an empty result and permits an explicit refresh", async () => {
    const fetcher = pickerFetcher();
    let empty = true;
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me" ? session() : listResponse(empty ? [] : [personalFood]),
    );
    await ready();
    expect(addButtons()).toHaveLength(0);
    expect(text().toLowerCase()).toMatch(/no .*foods|no foods/);
    empty = false;
    await click("Refresh my foods");
    expect(addButton()).toBeDefined();
  });

  it.each(["network", "response", "malformed"] as const)(
    "recovers from initial %s failure without exposing unverified choices",
    async (failure) => {
      const fetcher = pickerFetcher();
      let fail = true;
      fetcher.mockImplementation(async (url) => {
        if (url === "/api/auth/me") return session();
        if (fail) {
          if (failure === "network") throw new TypeError("Connection lost");
          if (failure === "response")
            return Response.json({ error: "Unavailable" }, { status: 503 });
          return Response.json({
            data: [
              {
                ...personalFood,
                currentVersion: { ...personalFood.currentVersion, id: personalFood.id },
              },
            ],
            page: { nextCursor: null },
          });
        }
        return listResponse();
      });
      await ready();
      expect(addButtons()).toHaveLength(0);
      expect(onSessionClosed).not.toHaveBeenCalled();
      fail = false;
      await click("Retry my foods");
      expect(addButton().props.disabled).not.toBe(true);
      expect(foodReads(fetcher)).toHaveLength(2);
    },
  );

  it("paginates by the exact cursor, retains prior rows on failure and retries that page", async () => {
    const fetcher = pickerFetcher();
    let failPage = true;
    fetcher.mockImplementation(async (url) => {
      if (url === "/api/auth/me") return session();
      const cursor = new URL(url, "https://test.invalid").searchParams.get("cursor");
      if (cursor === null) return listResponse([personalFood], "next/+?");
      expect(cursor).toBe("next/+?");
      return failPage
        ? Response.json({ error: "Temporary page failure" }, { status: 503 })
        : listResponse([personalFood, otherFood]);
    });
    await ready();
    const retained = addButton();
    await click("Load more personal foods");
    expect(text()).toContain("Personal oats");
    expect(addButton().props.disabled).toBe(true);
    invoke(retained, "onClick");
    expect(onAdd).not.toHaveBeenCalled();
    failPage = false;
    await click("Retry my foods");
    expect(addButtons()).toHaveLength(3);
    expect(addButton(otherFood).props.disabled).not.toBe(true);
    expect(
      foodReads(fetcher).map(([url]) =>
        new URL(url, "https://test.invalid").searchParams.get("cursor"),
      ),
    ).toEqual([null, "next/+?", "next/+?"]);
  });

  it("refreshes future choices and rejects old-version callbacks after the list changes", async () => {
    const fetcher = pickerFetcher();
    let newer = false;
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me" ? session() : listResponse([newer ? newerFood : personalFood]),
    );
    await ready();
    const stale = addButton(personalFood, "serving");
    newer = true;
    await click("Refresh my foods");
    invoke(stale, "onClick");
    expect(onAdd).not.toHaveBeenCalled();
    invoke(addButton(newerFood, "serving"), "onClick");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(newerFood, "serving");
  });

  it("disables retained choices through a failed refresh until a successful retry", async () => {
    const fetcher = pickerFetcher();
    let fail = false;
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me"
        ? session()
        : fail
          ? Response.json({ error: "Refresh failed" }, { status: 503 })
          : listResponse(),
    );
    await ready();
    const stale = addButton();
    fail = true;
    await click("Refresh my foods");
    invoke(stale, "onClick");
    expect(onAdd).not.toHaveBeenCalled();
    fail = false;
    await click("Retry my foods");
    invoke(addButton(), "onClick");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(personalFood, "grams");
  });

  it("starts only one request when a retained Load callback is invoked twice before paint", async () => {
    const pending = deferred<Response>(),
      fetcher = pickerFetcher();
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me" ? session() : pending.promise,
    );
    await mount();
    const load = button("Load my foods");
    invoke(load, "onClick");
    invoke(load, "onClick");
    await hooks.settle();
    expect(foodReads(fetcher)).toHaveLength(1);
    pending.resolve(listResponse());
    await hooks.settle();
    expect(addButton()).toBeDefined();
  });
});

describe("My foods ingredient picker owner and lifecycle fences", () => {
  it.each(["disabled", "capacity"] as const)(
    "rejects retained add callbacks after %s changes before effects",
    async (reason) => {
      pickerFetcher();
      await ready();
      const retained = addButton();
      updateProps(reason === "disabled" ? { disabled: true } : { remainingCapacity: 0 }, false);
      expect(addButton().props.disabled).toBe(true);
      invoke(retained, "onClick");
      expect(onAdd).not.toHaveBeenCalled();
      updateProps({ disabled: false, remainingCapacity: 1 });
      await hooks.settle();
      invoke(addButton(), "onClick");
      expect(onAdd).toHaveBeenCalledExactlyOnceWith(personalFood, "grams");
    },
  );

  it.each(["list401", "auth401", "different-owner"] as const)(
    "closes the private picker on %s without installing foods",
    async (reason) => {
      const fetcher = pickerFetcher();
      fetcher.mockImplementation(async (url) => {
        if (url === "/api/auth/me")
          return reason === "auth401"
            ? Response.json({}, { status: 401 })
            : session("2f351373-2d7e-4198-853c-9f4602fe259b");
        return reason === "list401" ? Response.json({}, { status: 401 }) : listResponse();
      });
      await ready();
      expect(onSessionClosed).toHaveBeenCalledTimes(1);
      expect(addButtons()).toHaveLength(0);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it("rejects old-owner callbacks immediately on owner prop change", async () => {
    pickerFetcher();
    await ready();
    const retained = addButton();
    updateProps({ ownerUserId: "2f351373-2d7e-4198-853c-9f4602fe259b" }, false);
    invoke(retained, "onClick");
    expect(onAdd).not.toHaveBeenCalled();
    expect(addButtons().every((node) => node.props.disabled === true)).toBe(true);
    hooks.render();
    await hooks.settle();
    expect(text()).not.toContain("Personal oats");
  });

  it.each(["fetch", "json", "auth"] as const)(
    "ignores a stale private %s completion after unmount",
    async (boundary) => {
      const pendingResponse = deferred<Response>(),
        pendingJson = deferred<unknown>(),
        fetcher = pickerFetcher();
      fetcher.mockImplementation(async (url) => {
        if (url === "/api/auth/me")
          return boundary === "auth" ? pendingResponse.promise : session();
        if (boundary === "fetch") return pendingResponse.promise;
        const response = listResponse();
        if (boundary === "json") response.json = () => pendingJson.promise;
        return response;
      });
      await mount();
      await click("Load my foods");
      hooks.unmount();
      const updates = hooks.afterClose();
      pendingResponse.resolve(boundary === "auth" ? session() : listResponse());
      pendingJson.resolve(await listResponse().json());
      await hooks.settle();
      expect(hooks.afterClose()).toBe(updates);
      expect(onAdd).not.toHaveBeenCalled();
      expect(onSessionClosed).not.toHaveBeenCalled();
    },
  );

  it("ignores a stale unauthorized response after the owner scope changes", async () => {
    const pending = deferred<Response>(),
      fetcher = pickerFetcher();
    fetcher.mockImplementation(async () => pending.promise);
    await mount();
    await click("Load my foods");
    updateProps({ ownerUserId: "2f351373-2d7e-4198-853c-9f4602fe259b" });
    await hooks.settle();
    pending.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    expect(onSessionClosed).not.toHaveBeenCalled();
    expect(addButtons()).toHaveLength(0);
  });

  it("rejects retained add and load callbacks after unmount without any side effect", async () => {
    const fetcher = pickerFetcher();
    await ready();
    const add = addButton(),
      refresh = button("Refresh my foods");
    const calls = fetcher.mock.calls.length;
    hooks.unmount();
    const updates = hooks.afterClose();
    invoke(add, "onClick");
    invoke(refresh, "onClick");
    await hooks.settle();
    expect(onAdd).not.toHaveBeenCalled();
    expect(fetcher.mock.calls).toHaveLength(calls);
    expect(hooks.afterClose()).toBe(updates);
  });
});

describe("My foods picker recovery boundaries", () => {
  it.each([400, 409])("restarts from the first page after a cursor %s response", async (status) => {
    const fetcher = pickerFetcher();
    let firstPages = 0;
    fetcher.mockImplementation(async (url) => {
      if (url === "/api/auth/me") return session();
      if (new URL(url, "https://test.invalid").searchParams.has("cursor"))
        return Response.json({}, { status });
      firstPages += 1;
      return firstPages === 1
        ? listResponse([personalFood], "old-cursor")
        : listResponse([newerFood]);
    });
    await ready();
    await click("Load more personal foods");
    expect(text()).toContain("These food choices changed.");
    expect(text()).toContain("Refresh your personal foods to continue.");
    expect(text()).toContain("Personal oats");
    const statusText = text(
      required(elements().find((node) => node.props.id === "my-food-ingredients-status")),
    );
    expect(statusText).not.toContain("All personal foods are loaded");
    expect(statusText).not.toContain("More foods may be available");
    expect(addButton().props.disabled).toBe(true);
    await click("Retry my foods");
    expect(
      foodReads(fetcher).map(([url]) =>
        new URL(url, "https://test.invalid").searchParams.get("cursor"),
      ),
    ).toEqual([null, "old-cursor", null]);
    expect(addButton(newerFood).props.disabled).not.toBe(true);
    expect(addButtons()).toHaveLength(2);
  });

  it("recovers from failed owner verification without closing the owner or installing the unverified page", async () => {
    const fetcher = pickerFetcher();
    let fail = true;
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me"
        ? fail
          ? Response.json({}, { status: 503 })
          : session()
        : listResponse(),
    );
    await ready();
    expect(addButtons()).toHaveLength(0);
    expect(onSessionClosed).not.toHaveBeenCalled();
    fail = false;
    await click("Retry my foods");
    expect(addButton().props.disabled).not.toBe(true);
    expect(foodReads(fetcher)).toHaveLength(2);
  });

  it("excludes archived rows and never downgrades an already loaded version on an overlapping page", async () => {
    const fetcher = pickerFetcher();
    fetcher.mockImplementation(async (url) => {
      if (url === "/api/auth/me") return session();
      return new URL(url, "https://test.invalid").searchParams.has("cursor")
        ? listResponse([personalFood, { ...otherFood, status: "archived" }])
        : listResponse([newerFood, otherFood], "next");
    });
    await ready();
    await click("Load more personal foods");
    expect(addButtons()).toHaveLength(2);
    expect(addButton(newerFood)).toBeDefined();
    expect(text()).not.toContain("Banana puree");
    invoke(addButton(newerFood), "onClick");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(newerFood, "grams");
  });

  it("discards a pending page when disabled and requires a fresh load after re-enabling", async () => {
    const pending = deferred<Response>(),
      fetcher = pickerFetcher();
    let reads = 0;
    fetcher.mockImplementation(async (url) =>
      url === "/api/auth/me"
        ? session()
        : ++reads === 1
          ? pending.promise
          : listResponse([newerFood]),
    );
    await mount();
    await click("Load my foods");
    updateProps({ disabled: true });
    await hooks.settle();
    updateProps({ disabled: false });
    await hooks.settle();
    pending.resolve(listResponse());
    await hooks.settle();
    expect(addButtons()).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(0);
    await click("Load my foods");
    expect(addButton(newerFood)).toBeDefined();
  });

  it("rejects retained choices hidden by a newer loaded-name filter", async () => {
    pickerFetcher();
    await ready();
    const retained = addButton();
    await change("Filter loaded personal foods by name", "no matching food");
    invoke(retained, "onClick");
    expect(onAdd).not.toHaveBeenCalled();
    await click("Clear my foods filter");
    invoke(addButton(), "onClick");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(personalFood, "grams");
  });
});

describe("My foods management navigation", () => {
  it.each([
    { date: "2026-09-24", href: "/foods/custom?date=2026-09-24" },
    { date: undefined, href: "/foods/custom" },
    { date: "2026-02-30", href: "/foods/custom" },
  ])("links to management with the validated selected date: $date", async ({ date, href }) => {
    const fetcher = pickerFetcher();
    props = { ...props, ...(date === undefined ? {} : { date }) };
    await mount();
    const link = required(
      elements().find((node) => node.props.href !== undefined && text(node) === "Manage my foods"),
    );
    expect(link.props.href).toBe(href);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
