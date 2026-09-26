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
    replaceVerifiedSessionBeforeEffects(next: unknown) {
      const slot = slots.find(
        (candidate) =>
          candidate.value &&
          typeof candidate.value === "object" &&
          "user" in candidate.value &&
          "profile" in candidate.value,
      );
      if (!slot) throw new Error("No verified session state to replace.");
      slot.value = next;
      render(false);
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
const route = vi.hoisted(() => ({ date: "2026-08-15" as string | null }));
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
  useSearchParams: () => ({ get: () => route.date }),
}));

import {
  type DiaryGroup,
  defaultDiaryGroups,
  diaryDayOrderDigest,
  localDateInTimeZone,
  localTimeInTimeZone,
  type MealSlot,
  nutrientDisplay,
  parseDiaryCorrectionMutation,
  parseDiaryPage,
  parseSession,
} from "../../lib/diary";
import { CalmOverview } from "./CalmOverview";
import { DiaryClient } from "./DiaryClient";
import { DiaryDayNote } from "./DiaryDayNote";

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
  const found = elements().find(
    (node) =>
      node.type === "button" && (node.props["aria-label"] === label || text(node) === label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function group(meal: MealSlot): ElementNode {
  const found = elements().find(
    (node) => node.type === "section" && node.props["aria-labelledby"] === `meal-${meal}`,
  );
  if (!found) throw new Error(`Missing group: ${meal}`);
  return found;
}
function field(label: string): ElementNode {
  const found = elements().find(
    (node) => node.type === "label" && text(node).trim().startsWith(label),
  );
  const input =
    found &&
    (found.props.htmlFor
      ? elements().find((node) => node.props.id === found.props.htmlFor)
      : elements(found).find((node) =>
          ["input", "select", "textarea"].includes(String(node.type)),
        ));
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}
function invoke(node: ElementNode, action = "onClick", ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node);
  await hooks.settle();
}
async function change(label: string, value: string) {
  invoke(field(label), "onChange", { target: { value } });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const anotherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
const source = {
  code: "USDA_FDC",
  releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
  displayName: "USDA FoodData Central",
  licenseExpression: "CC0-1.0",
  attributionRequired: true,
  attributionText: "Data source: USDA FoodData Central",
};
const nutrient = {
  nutrientId: "1",
  code: "ENERGY_KCAL",
  name: "Energy",
  unit: "kcal",
  knownAmount: "125.500000000000",
  completeness: "partial",
  isExact: false,
  contributorCount: 2,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 1,
  unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
};
function entry(number: number, mealSlot: MealSlot = "breakfast", localDate = "2026-08-15") {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    revision: "3",
    entryKind: "food",
    foodVersionId: "202",
    recipeVersionId: null,
    portion: {
      kind: "serving",
      servingId: "303",
      amount: "1.250000",
      servingLabel: "medium apple",
    },
    food: { name: `Apple ${number}`, brandName: null },
    recipe: null,
    source,
    foodProvenance: { kind: "public", source },
    mealSlot,
    resolvedGrams: "227.500000",
    note: `Exact private note ${number}`,
    occurredAt: `${localDate}T13:30:00.000Z`,
    localDate,
    timeZone: "America/Chicago",
    localTime: "08:30:00",
    position: number,
    nutrients: [nutrient],
  };
}
function page(
  entries = [entry(0), entry(1, "lunch")],
  nextCursor: string | null = null,
  totalEntries = entries.length,
  localDate = "2026-08-15",
  revision = "8",
) {
  return {
    data: {
      id: "41b5f2ea-2274-4b98-8b13-96504d176917",
      localDate,
      timeZone: "America/Chicago",
      status: "open",
      revision,
      orderDigest: "a".repeat(64),
      entries,
      totals: [nutrient],
      updatedAt: `${localDate}T13:31:00.000Z`,
    },
    page: { nextCursor, totalEntries },
  };
}
function session(id = owner, groups: readonly DiaryGroup[] = defaultDiaryGroups, revision = "1") {
  return {
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
        revision,
        diaryGroups: groups,
      },
    },
  };
}
function fetcher(currentPage = page()) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/auth/me") return Response.json(session());
    if (url.startsWith("/api/diary?")) {
      const localDate =
        new URL(url, "https://app.example.test").searchParams.get("date") ?? "2026-08-15";
      return Response.json(
        localDate === currentPage.data.localDate
          ? currentPage
          : page([entry(2, "breakfast", localDate)], null, 1, localDate),
      );
    }
    return Response.json(
      { error: "Summary deliberately unavailable in this bounded diary fixture." },
      { status: 503 },
    );
  });
}
async function mount(fetch = fetcher(), view: "diary" | "overview" = "diary") {
  vi.stubGlobal("fetch", fetch);
  hooks.mount(() => DiaryClient({ view }));
  await hooks.settle();
  return fetch;
}
const detailLifecycle = {
  visibility: "visible",
  documentListeners: new Map<string, () => void>(),
  windowListeners: new Map<string, () => void>(),
};
beforeEach(() => {
  detailLifecycle.visibility = "visible";
  detailLifecycle.documentListeners.clear();
  detailLifecycle.windowListeners.clear();
  vi.stubGlobal("document", {
    get visibilityState() {
      return detailLifecycle.visibility;
    },
    addEventListener: (event: string, callback: () => void) =>
      detailLifecycle.documentListeners.set(event, callback),
    removeEventListener: (event: string) => detailLifecycle.documentListeners.delete(event),
  });
  route.date = "2026-08-15";
  vi.stubGlobal("window", {
    confirm: vi.fn(() => true),
    addEventListener: (event: string, callback: () => void) =>
      detailLifecycle.windowListeners.set(event, callback),
    removeEventListener: (event: string) => detailLifecycle.windowListeners.delete(event),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
});
afterEach(() => {
  hooks.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("actual diary meal visibility", () => {
  it("separates the saved serving multiplier from an intact source label", async () => {
    const originalEntry = entry(0);
    const fixture = page([
      {
        ...originalEntry,
        resolvedGrams: "59",
        portion: {
          ...originalEntry.portion,
          amount: "0.500000",
          servingLabel: "1 medium banana (118 g)",
        },
      },
    ]);
    const original = JSON.stringify(fixture);
    await mount(fetcher(fixture));
    const portion = "0.500000 × 1 medium banana (118 g)";
    expect(text(group("breakfast"))).toContain(portion);
    expect(nutrientControl(0).props["aria-label"]).toContain(portion);
    await toggleNutrients(0);
    expect(nutrientDetailText(0)).toContain(portion);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("starts expanded and hides only loaded rows while preserving all authoritative evidence and destinations", async () => {
    const fixture = page();
    const original = JSON.stringify(fixture);
    expect(() => parseDiaryPage(fixture)).not.toThrow();
    const fetch = await mount(fetcher(fixture));
    const initialRequests = fetch.mock.calls.length;
    const nutrition = () =>
      elements().find((node) => node.props["aria-labelledby"] === "nutrition-summary-title");
    const totals = text(nutrition());
    const rows = text(group("breakfast"));
    expect(
      defaultDiaryGroups.map((g) => button(`Collapse ${g.label}`).props["aria-expanded"]),
    ).toEqual([true, true, true, true]);
    await click("Collapse Breakfast");
    expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
    expect(button("Expand Breakfast").props["aria-controls"]).toBe("meal-entries-breakfast");
    expect(text(group("breakfast"))).toContain("Loaded entries hidden.");
    expect(text(group("breakfast"))).not.toContain("Apple 0");
    expect(text(group("lunch"))).toContain("Apple 1");
    expect(
      elements(group("breakfast")).some(
        (node) => node.props.href === "/foods?date=2026-08-15&meal=breakfast",
      ),
    ).toBe(true);
    expect(text()).toContain("2 of 2 entries loaded. Nutrition totals include all 2.");
    expect(text(nutrition())).toBe(totals);
    await click("Collapse Lunch");
    await click("Expand Breakfast");
    expect(text(group("breakfast"))).toBe(rows);
    expect(text(group("lunch"))).not.toContain("Apple 1");
    expect(fetch).toHaveBeenCalledTimes(initialRequests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("rejects duplicate and pre-collapse retained controls without requests or hidden edit activation", async () => {
    const fetch = await mount();
    const originalRequests = fetch.mock.calls.length;
    const collapse = button("Collapse Breakfast");
    const edit = button("Edit Apple 0");
    invoke(collapse);
    invoke(collapse);
    invoke(edit);
    await hooks.settle();
    expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
    expect(text(group("breakfast"))).not.toContain("Quantity");
    await click("Expand Breakfast");
    invoke(collapse);
    await hooks.settle();
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(originalRequests);
  });

  it("keeps the active original meal open through same-paint activation and unsaved editor changes", async () => {
    const fetch = await mount();
    const requestCount = fetch.mock.calls.length;
    const retained = button("Collapse Breakfast");
    invoke(button("Edit Apple 0"));
    invoke(retained);
    await hooks.settle();
    expect(button("Collapse Breakfast").props.disabled).toBe(true);
    await change("Quantity", "2.125000");
    await change("Private note", "  keep this unsaved note  ");
    await change("Meal", "dinner");
    invoke(button("Collapse Breakfast"));
    await hooks.settle();
    expect(field("Quantity").props.value).toBe("2.125000");
    expect(field("Private note").props.value).toBe("  keep this unsaved note  ");
    await click("Collapse Lunch");
    const raw = ["Quantity", "Private note", "Meal", "Local date", "Local time"].map(
      (label) => field(label).props.value,
    );
    await click("Expand all meals");
    expect(
      ["Quantity", "Private note", "Meal", "Local date", "Local time"].map(
        (label) => field(label).props.value,
      ),
    ).toEqual(raw);
    expect(button("Collapse Lunch").props["aria-expanded"]).toBe(true);
    expect(field("Quantity").props.value).toBe("2.125000");
    await click("Cancel editing Apple 0");
    await click("Collapse Breakfast");
    await click("Expand Breakfast");
    expect(text(group("breakfast"))).toContain("1.250000 × medium apple");
    expect(text(group("breakfast"))).toContain("Exact private note 0");
    expect(fetch).toHaveBeenCalledTimes(requestCount);
  });
});

describe("diary collapse paging and work in progress", () => {
  it("retains collapse across coherent pages while preserving total counts and not-yet-loaded meaning", async () => {
    const first = page(
      Array.from({ length: 20 }, (_, index) => entry(index)),
      "d1.next-page",
      22,
    );
    const second = page([entry(20, "lunch"), entry(21, "snacks")], null, 22);
    const pending = deferred<Response>();
    const base = fetcher(first);
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.includes("cursor=") ? pending.promise : base(url, init),
    );
    await mount(fetch);
    await click("Collapse Breakfast");
    await click("Collapse Lunch");
    expect(text(group("lunch"))).toContain("No entries loaded for this meal yet");
    expect(text(group("lunch"))).not.toContain("Loaded entries hidden.");
    const expand = button("Expand Breakfast"),
      expandAll = button("Expand all meals");
    invoke(button("Load more"));
    invoke(expand);
    invoke(expandAll);
    await hooks.settle();
    expect(button("Expand Breakfast").props.disabled).toBe(true);
    expect(button("Expand all meals").props.disabled).toBe(true);
    expect(text()).toContain("20 of 22 entries loaded. Nutrition totals include all 22.");
    pending.resolve(Response.json(second));
    await hooks.settle();
    expect(text()).toContain("22 of 22 entries loaded. Nutrition totals include all 22.");
    expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
    expect(button("Expand Lunch").props["aria-expanded"]).toBe(false);
    expect(text(group("lunch"))).toContain("Loaded entries hidden.");
    expect(text(group("snacks"))).toContain("Apple 21");
    expect(text(group("dinner"))).toContain("No entries");
    expect(text(group("dinner"))).not.toContain("loaded for this meal yet");
    await click("Expand Lunch");
    expect(text(group("lunch"))).toContain("Apple 20");
    const requests = fetch.mock.calls.length;
    await click("Expand all meals");
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    expect(text(group("breakfast"))).toContain("Apple 0");
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(fetch.mock.calls.filter(([url]) => url.includes("cursor="))).toHaveLength(1);
    expect(fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  it.each(["failure", "stale"] as const)(
    "preserves collapse through a %s page continuation and retry",
    async (outcome) => {
      const first = page(
        Array.from({ length: 20 }, (_, index) => entry(index)),
        "d1.next-page",
        21,
      );
      const base = fetcher(first);
      let continuations = 0;
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("cursor=")) {
          continuations += 1;
          if (continuations === 1)
            return Response.json(
              outcome === "stale" ? { code: "DIARY_PAGE_STALE" } : { error: "Page unavailable." },
              { status: outcome === "stale" ? 409 : 503 },
            );
          return Response.json(page([entry(20, "lunch")], null, 21));
        }
        return base(url, init);
      });
      await mount(fetch);
      await click("Collapse Breakfast");
      await click("Load more");
      expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
      expect(text()).toContain(
        outcome === "stale" ? "Page one was refreshed safely." : "Loaded entries remain available",
      );
      await click(outcome === "stale" ? "Load more" : "Retry load more");
      expect(text()).toContain("21 of 21 entries loaded");
      expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
      expect(text(group("lunch"))).toContain("Apple 20");
    },
  );

  it.each(["Repeat Apple 0 today", "Delete Apple 0"])(
    "reveals pending work started by a retained %s action and leaves retry behavior unchanged",
    async (action) => {
      const pending = deferred<Response>();
      const writes: RequestInit[] = [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) {
          writes.push(init);
          return writes.length === 1
            ? pending.promise
            : Response.json({ error: "Response unavailable." }, { status: 503 });
        }
        return base(url, init);
      });
      await mount(fetch);
      const write = button(action);
      await click("Collapse Breakfast");
      const staleToggle = button("Expand Breakfast");
      invoke(write);
      invoke(staleToggle);
      await hooks.settle();
      expect(button("Collapse Breakfast").props.disabled).toBe(true);
      expect(text(group("breakfast"))).toContain("Apple 0");
      expect(writes).toHaveLength(1);
      await toggleNutrients(0);
      await toggleNutrients(0);
      expect(writes).toHaveLength(1);
      pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
      await click("Expand Breakfast");
      await click(action);
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
        new Headers(writes[0]?.headers).get("idempotency-key"),
      );
      expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"3"');
    },
  );

  it("keeps an exact unsaved edit visible while saving and retries its unchanged bytes/key", async () => {
    const pending = deferred<Response>();
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(init);
        return writes.length === 1
          ? pending.promise
          : Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Edit Apple 0");
    await change("Quantity", "2.125000");
    await change("Private note", "New exact note");
    await click("Collapse Lunch");
    const expandAll = button("Expand all meals");
    const collapseBreakfast = button("Collapse Breakfast");
    invoke(button("Save changes to Apple 0"));
    invoke(collapseBreakfast);
    invoke(expandAll);
    await hooks.settle();
    expect(button("Expand all meals").props.disabled).toBe(true);
    expect(button("Collapse Breakfast").props.disabled).toBe(true);
    expect(button("Collapse Lunch").props.disabled).toBe(true);
    expect(field("Quantity").props.value).toBe("2.125000");
    expect(field("Private note").props.value).toBe("New exact note");
    await toggleNutrients(0);
    expect(nutrientDetailText(0)).toContain("1.250000 × medium apple");
    expect(nutrientDetailText(0)).toContain("Unsaved edits are not included.");
    expect(field("Quantity").props.value).toBe("2.125000");
    expect(field("Private note").props.value).toBe("New exact note");
    await toggleNutrients(0);
    pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
    await hooks.settle();
    const failureStatus = text(
      elements().find((node) => node.type === "p" && node.props.tabIndex === -1) ?? null,
    );
    const requestsBeforeDetails = fetch.mock.calls.length;
    expect(button("Expand Lunch").props["aria-expanded"]).toBe(false);
    await click("Expand all meals");
    expect(button("Collapse Lunch").props["aria-expanded"]).toBe(true);
    await toggleNutrients(0);
    await toggleNutrients(0);
    expect(
      text(elements().find((node) => node.type === "p" && node.props.tabIndex === -1) ?? null),
    ).toBe(failureStatus);
    expect(fetch.mock.calls).toHaveLength(requestsBeforeDetails);
    expect(field("Quantity").props.value).toBe("2.125000");
    expect(field("Private note").props.value).toBe("New exact note");
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toBe(
      '{"portion":{"kind":"serving","servingId":"303","amount":"2.125000"},"mealSlot":"breakfast","note":"New exact note"}',
    );
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
  });

  it("keeps a collapsed stable meal under renamed/reordered profile groups and protects pending profile work", async () => {
    const pending = deferred<Response>();
    let savedGroups = defaultDiaryGroups;
    let profile = session().data.profile;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        savedGroups = JSON.parse(String(init?.body)).diaryGroups;
        profile = { ...profile, diaryGroups: savedGroups, revision: "2" };
        return pending.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Collapse Breakfast");
    await click("Customize diary groups");
    await change("Group 1 label", "Morning meal with a long custom label");
    await click("Move group 1 down");
    const oldToggle = button("Expand Breakfast"),
      expandAll = button("Expand all meals");
    const form = elements().find(
      (node) => node.type === "form" && text(node).includes("Save groups"),
    );
    if (!form) throw new Error("Missing profile form");
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(oldToggle);
    invoke(expandAll);
    await hooks.settle();
    expect(button("Expand all meals").props.disabled).toBe(true);
    expect(button("Collapse Breakfast").props.disabled).toBe(true);
    expect(text(group("breakfast"))).toContain("Apple 0");
    pending.resolve(Response.json({ data: { profile } }));
    await hooks.settle();
    expect(savedGroups[0]?.mealSlot).toBe("lunch");
    expect(button("Expand Morning meal with a long custom label").props["aria-expanded"]).toBe(
      false,
    );
    expect(button("Collapse Lunch").props["aria-expanded"]).toBe(true);
    expect(
      elements()
        .filter(
          (node) =>
            node.type === "section" && String(node.props["aria-labelledby"]).startsWith("meal-"),
        )
        .map((node) => node.props["aria-labelledby"]),
    ).toEqual(["meal-lunch", "meal-breakfast", "meal-dinner", "meal-snacks"]);
    await click("Expand all meals");
    expect(button("Collapse Morning meal with a long custom label").props["aria-expanded"]).toBe(
      true,
    );
  });
});

describe("diary collapse private scope", () => {
  it("resets on a committed date and does not revive prior choices when returning", async () => {
    await mount();
    await click("Collapse Breakfast");
    const oldToggle = button("Expand Breakfast"),
      oldExpandAll = button("Expand all meals");
    invoke(button("Next day"));
    invoke(oldToggle);
    invoke(oldExpandAll);
    route.date = "2026-08-16";
    await hooks.settle();
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    expect(text(group("breakfast"))).toContain("Apple 2");
    await click("Collapse Breakfast");
    invoke(button("Previous day"));
    route.date = "2026-08-15";
    await hooks.settle();
    invoke(oldToggle);
    invoke(oldExpandAll);
    await hooks.settle();
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
  });

  it.each(["route-before-effects", "logout", "unmount", "effect-replay"] as const)(
    "rejects retained toggles after %s",
    async (transition) => {
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url === "/api/auth/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : base(url, init),
      );
      await mount(fetch);
      await click("Collapse Breakfast");
      const oldToggle = button("Expand Breakfast"),
        oldExpandAll = button("Expand all meals");
      if (transition === "route-before-effects") {
        route.date = "2026-08-16";
        hooks.renderWithoutEffects();
      } else if (transition === "logout") {
        await click("Sign out");
      } else if (transition === "unmount") {
        hooks.unmount();
      } else {
        hooks.replayEffects();
        await hooks.settle();
      }
      const requests = fetch.mock.calls.length;
      const before = text();
      invoke(oldToggle);
      invoke(oldExpandAll);
      if (transition !== "route-before-effects") await hooks.settle();
      expect(text()).toBe(before);
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(hooks.afterClose()).toBe(0);
      if (transition === "route-before-effects") {
        hooks.render();
        await hooks.settle();
        expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
      }
      if (transition === "effect-replay")
        expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    },
  );

  it("closes collapsed private content when a profile receipt discovers a different owner", async () => {
    const base = fetcher();
    let changedOwner = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        changedOwner = true;
        return Response.json({}, { status: 412 });
      }
      if (url === "/api/auth/me" && changedOwner) return Response.json(session(anotherOwner));
      return base(url, init);
    });
    await mount(fetch);
    await click("Collapse Breakfast");
    const oldToggle = button("Expand Breakfast"),
      oldExpandAll = button("Expand all meals");
    await click("Customize diary groups");
    await change("Group 1 label", "Morning");
    const form = elements().find(
      (node) => node.type === "form" && text(node).includes("Save groups"),
    );
    if (!form) throw new Error("Missing profile form");
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    const requests = fetch.mock.calls.length;
    invoke(oldToggle);
    invoke(oldExpandAll);
    await hooks.settle();
    expect(text()).not.toContain("Apple 0");
    expect(text()).not.toContain("Loaded entries hidden.");
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("preserves the completely empty day meaning without inventing hidden entry counts", async () => {
    const fetch = await mount(fetcher(page([], null, 0)));
    expect(text()).toContain("No foods logged for this local day.");
    expect(text()).toContain("Nothing logged");
    expect(text()).not.toContain("Loaded entries hidden.");
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Expand all meals"),
    ).toBe(false);
    expect(
      elements().some((node) => node.props["aria-controls"] === "meal-entries-breakfast"),
    ).toBe(false);
    expect(fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });
});

describe("diary collapse snapshot invariants", () => {
  it.each(["zero", "trace", "unknown", "partial"] as const)(
    "retains %s nutrient evidence through collapse",
    async (kind) => {
      const fixture = page();
      const amount =
        kind === "partial"
          ? nutrient
          : {
              ...nutrient,
              knownAmount: "0.000000000000",
              completeness: kind === "unknown" ? "unknown" : "complete",
              isExact: kind === "zero",
              contributorCount: 1,
              quantifiedCount: kind === "zero" ? 1 : 0,
              traceCount: kind === "trace" ? 1 : 0,
              unknownCount: kind === "unknown" ? 1 : 0,
              unknownReasonCounts: {
                not_reported: kind === "unknown" ? 1 : 0,
                not_analyzed: 0,
                not_applicable: 0,
                withheld: 0,
              },
            };
      fixture.data.totals = [amount];
      fixture.data.entries = fixture.data.entries.map((row) => ({ ...row, nutrients: [amount] }));
      const before = JSON.stringify(fixture);
      const fetch = await mount(fetcher(fixture));
      const requests = fetch.mock.calls.length;
      const totals = () =>
        text(
          elements().find((node) => node.props["aria-labelledby"] === "nutrition-summary-title"),
        );
      const renderedTotals = totals();
      const rowEvidence = text(group("breakfast"));
      await click("Collapse Breakfast");
      expect(totals()).toBe(renderedTotals);
      await click("Expand Breakfast");
      expect(text(group("breakfast"))).toBe(rowEvidence);
      expect(JSON.stringify(fixture)).toBe(before);
      expect(fetch).toHaveBeenCalledTimes(requests);
    },
  );

  it("reveals a retained reorder operation while preserving its complete-day permutation and retry key", async () => {
    const fixture = page([entry(0), entry(1)]);
    const parsed = parseDiaryPage(fixture);
    const orderGroup = (mealSlot: MealSlot) => ({
      mealSlot,
      entries: parsed.data.entries
        .filter((row) => row.mealSlot === mealSlot)
        .map((row) => ({
          entryId: row.id,
          entryRevision: row.revision,
          position: row.position,
        })),
    });
    fixture.data.orderDigest = await diaryDayOrderDigest(
      parsed.data.localDate,
      parsed.data.timeZone,
      [orderGroup("breakfast"), orderGroup("lunch"), orderGroup("dinner"), orderGroup("snacks")],
    );
    const pending = deferred<Response>();
    const writes: RequestInit[] = [];
    const base = fetcher(fixture);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(init);
        return writes.length === 1
          ? pending.promise
          : Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const move = button("Move Apple 0 down within Breakfast");
    await click("Collapse Breakfast");
    const expand = button("Expand Breakfast");
    invoke(move);
    invoke(expand);
    await hooks.settle();
    expect(button("Collapse Breakfast").props.disabled).toBe(true);
    expect(text(group("breakfast"))).toContain("Apple 0");
    expect(writes).toHaveLength(1);
    await toggleNutrients(0);
    await toggleNutrients(0);
    expect(writes).toHaveLength(1);
    pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
    await hooks.settle();
    await click("Expand Breakfast");
    await click("Move Apple 0 down within Breakfast");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toBe(
      '{"groups":{"breakfast":[1,0],"lunch":[],"dinner":[],"snacks":[]}}',
    );
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes[1]?.headers).get("x-expected-diary-order-digest")).toBe(
      fixture.data.orderDigest,
    );
  });

  it("rejects the old toggle while a replacement day fails, then permits a fresh loaded scope", async () => {
    const base = fetcher();
    let failNextDay = true;
    const pending = deferred<Response>();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?") && url.includes("2026-08-16") && failNextDay
        ? pending.promise
        : base(url, init),
    );
    await mount(fetch);
    await click("Collapse Breakfast");
    const oldToggle = button("Expand Breakfast"),
      oldExpandAll = button("Expand all meals");
    invoke(button("Next day"));
    route.date = "2026-08-16";
    await hooks.settle();
    invoke(oldToggle);
    invoke(oldExpandAll);
    await hooks.settle();
    expect(text()).not.toContain("Loaded entries hidden.");
    pending.resolve(Response.json({ error: "Day unavailable." }, { status: 503 }));
    await hooks.settle();
    invoke(oldToggle);
    invoke(oldExpandAll);
    await hooks.settle();
    expect(text()).toContain("Day unavailable.");
    failNextDay = false;
    await click("Retry");
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    await click("Collapse Breakfast");
    expect(text(group("breakfast"))).toContain("Loaded entries hidden.");
  });
});

function nutrientControl(number: number): ElementNode {
  const found = elements().find(
    (node) =>
      node.type === "button" &&
      node.props["aria-controls"] === `entry-nutrients-${entry(number).id}`,
  );
  if (!found) throw new Error(`Missing nutrient control for entry ${number}`);
  return found;
}
function nutrientDetail(number: number): ElementNode | undefined {
  return elements().find((node) => node.props.id === `entry-nutrients-${entry(number).id}`);
}
function nutrientDetailText(number: number): string {
  return text(nutrientDetail(number) ?? null);
}
async function toggleNutrients(number: number) {
  invoke(nutrientControl(number));
  await hooks.settle();
}
function detailsRows(number: number) {
  return elements(nutrientDetail(number))
    .filter((node) => node.type === "dt" || node.type === "dd")
    .map((node) => text(node));
}
function nutrientVector() {
  const quantified = {
    ...nutrient,
    contributorCount: 1,
    quantifiedCount: 1,
    unknownCount: 0,
    completeness: "complete",
    isExact: true,
    unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
  };
  return [
    { ...quantified, name: "Energy ".repeat(25).trim(), knownAmount: `1.${"2".repeat(198)}` },
    { ...quantified, nutrientId: "2", name: "Zero", unit: "g", knownAmount: "0.000000" },
    {
      ...quantified,
      nutrientId: "3",
      name: "Trace",
      unit: "mg",
      knownAmount: "0",
      quantifiedCount: 0,
      traceCount: 1,
      isExact: false,
    },
    { ...nutrient, nutrientId: "4", name: "Partial", unit: "g", knownAmount: "0.100000000000" },
    ...(["not_reported", "not_analyzed", "not_applicable", "withheld"] as const).map(
      (reason, index) => ({
        ...quantified,
        nutrientId: String(index + 5),
        name: reason,
        unit: "unknown-unit",
        knownAmount: "0",
        completeness: "unknown",
        quantifiedCount: 0,
        unknownCount: 1,
        isExact: false,
        unknownReasonCounts: { ...quantified.unknownReasonCounts, [reason]: 1 },
      }),
    ),
  ];
}

describe("logged portion nutrient details", () => {
  it("discloses every saved value/state/unit in order for food, private food and recipe without requests or total changes", async () => {
    const publicEntry = { ...entry(0), nutrients: nutrientVector() };
    const privateEntry = {
      ...entry(1, "lunch"),
      source: null,
      foodProvenance: {
        kind: "private_custom",
        customFoodId: "b8a7c76f-3c1d-445c-9160-152e57b29e42",
        customFoodVersionNumber: 3,
      },
      nutrients: nutrientVector(),
    };
    const { foodProvenance: _provenance, ...recipeBase } = entry(2, "dinner");
    const recipeEntry = {
      ...recipeBase,
      entryKind: "recipe",
      foodVersionId: null,
      recipeVersionId: "de1f6d0a-f7dc-4b25-b7b9-3eef1d44779a",
      portion: { kind: "serving", amount: "1.250000", servingLabel: "bowl" },
      food: null,
      source: null,
      sources: [source],
      recipe: {
        id: "df94a52f-e84a-4cd5-873e-227d1e213d62",
        name: "Saved stew",
        versionNumber: 2,
        yieldGrams: "800",
        yieldSource: "measured",
        servingCount: "4",
        servingLabel: "bowl",
        calculationVersion: "recipe-v1",
        retentionPolicy: {
          code: "identity-retention-default",
          version: "1",
          assumption: "No cooking-retention factor was applied.",
        },
        warnings: [],
      },
      nutrients: nutrientVector(),
    };
    const fixture = {
      ...page(),
      data: { ...page().data, entries: [publicEntry, privateEntry, recipeEntry] },
      page: { nextCursor: null, totalEntries: 3 },
    };
    const parsed = parseDiaryPage(fixture),
      original = JSON.stringify(fixture);
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?") ? Promise.resolve(Response.json(fixture)) : base(url, init),
    );
    await mount(fetch);
    const requests = fetch.mock.calls.length;
    const summary = text(elements().find((node) => node.props.className === "nutritionSummary"));
    const status = text(elements().find((node) => node.type === "p" && node.props.tabIndex === -1));
    for (const number of [0, 1, 2]) {
      expect(nutrientControl(number).props["aria-expanded"]).toBe(false);
      expect(nutrientControl(number).props.type).toBe("button");
      await toggleNutrients(number);
      expect(nutrientControl(number).props["aria-expanded"]).toBe(true);
      expect(nutrientDetailText(number)).toContain("Entry revision 3.");
      expect(detailsRows(number)).toEqual(
        parsed.data.entries[number]?.nutrients.flatMap((row) => {
          const display = nutrientDisplay(row);
          return [`${row.name} (${row.unit})`, `${display.amount}${display.qualification}`];
        }),
      );
    }
    expect(nutrientDetailText(2)).toContain("1.250000 × bowl");
    expect(nutrientDetailText(0)).toContain("Unknown0/1 contributions quantified");
    await toggleNutrients(1);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(2).props["aria-expanded"]).toBe(true);
    expect(text(elements().find((node) => node.props.className === "nutritionSummary"))).toBe(
      summary,
    );
    expect(text(elements().find((node) => node.type === "p" && node.props.tabIndex === -1))).toBe(
      status,
    );
    expect(text()).toContain("3 of 3 entries loaded. Nutrition totals include all 3.");
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps duplicate food names independent and every accepted repeated nutrient ID in source order", async () => {
    const sameName = { name: "Same food", brandName: null };
    const first = { ...entry(0), food: sameName };
    const second = {
      ...entry(1, "lunch"),
      food: sameName,
      localTime: "09:45:00",
      nutrients: [
        { ...nutrient, name: "First recorded value" },
        { ...nutrient, name: "Second recorded value", knownAmount: "3.000" },
      ],
    };
    const fixture = page([first, second]);
    parseDiaryPage(fixture);
    await mount(fetcher(fixture));
    expect(nutrientControl(0).props["aria-label"]).toContain(
      "Same food, 1.250000 × medium apple at 08:30",
    );
    expect(nutrientControl(1).props["aria-label"]).toContain(
      "Same food, 1.250000 × medium apple at 09:45",
    );
    await toggleNutrients(1);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
    expect(detailsRows(1)).toEqual([
      "First recorded value (kcal)",
      "≥ 125.500000000000 kcalPartial · 1/2 contributions quantified",
      "Second recorded value (kcal)",
      "≥ 3.000 kcalPartial · 1/2 contributions quantified",
    ]);
    const keys = elements(nutrientDetail(1))
      .filter((node) => String(node.props.className).startsWith("nutrientTotal"))
      .map((node) => (node as ElementNode & { key: string }).key);
    expect(keys).toEqual(["1:1", "1:2"]);
  });

  it.each([0, 256])("renders the explicit empty or complete %s-row snapshot", async (count) => {
    const first = entry(0);
    first.nutrients = Array.from({ length: count }, (_, index) => ({
      ...nutrient,
      nutrientId: String(index + 1),
      name: `Saved nutrient ${index + 1}`,
    }));
    await mount(fetcher(page([first])));
    await toggleNutrients(0);
    if (count === 0)
      expect(nutrientDetailText(0)).toContain(
        "Nutrient details are unavailable for this logged portion.",
      );
    else {
      expect(detailsRows(0)).toHaveLength(512);
      expect(detailsRows(0)[0]).toBe("Saved nutrient 1 (kcal)");
      expect(detailsRows(0)[510]).toBe("Saved nutrient 256 (kcal)");
    }
  });

  it("fences repeated and restored Show/Hide callbacks and rejects hidden meal actions before paint", async () => {
    const fetch = await mount();
    const firstShow = nutrientControl(0),
      secondShow = nutrientControl(1);
    invoke(firstShow);
    invoke(firstShow);
    invoke(secondShow);
    await hooks.settle();
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(1).props["aria-expanded"]).toBe(true);
    const oldHide = nutrientControl(0);
    await toggleNutrients(0);
    invoke(firstShow);
    invoke(oldHide);
    await hooks.settle();
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
    await toggleNutrients(0);
    const hiddenHide = nutrientControl(0);
    invoke(button("Collapse Breakfast"));
    invoke(hiddenHide);
    await hooks.settle();
    expect(nutrientDetail(0)).toBeUndefined();
    const requests = fetch.mock.calls.length;
    await click("Expand Breakfast");
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    invoke(hiddenHide);
    await hooks.settle();
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(fetch.mock.calls).toHaveLength(requests);
  });

  it("preserves a raw editor and saved portion while details change independently", async () => {
    const fetch = await mount();
    await click("Edit Apple 0");
    await change("Quantity", "2.000001");
    await change("Private note", "  Unsaved exact note  ");
    await change("Meal", "dinner");
    const raw = ["Quantity", "Private note", "Meal", "Local date", "Local time"].map(
      (label) => field(label).props.value,
    );
    const requests = fetch.mock.calls.length;
    await toggleNutrients(0);
    expect(nutrientDetailText(0)).toContain("1.250000 × medium apple");
    expect(nutrientDetailText(0)).toContain("Unsaved edits are not included.");
    await toggleNutrients(0);
    expect(
      ["Quantity", "Private note", "Meal", "Local date", "Local time"].map(
        (label) => field(label).props.value,
      ),
    ).toEqual(raw);
    expect(fetch.mock.calls).toHaveLength(requests);
  });

  it("preserves current choices through coherent append and failed append retry", async () => {
    const first = page(
      Array.from({ length: 20 }, (_, index) => entry(index)),
      "d1.next-page",
      21,
    );
    const pending = deferred<Response>();
    const base = fetcher(first);
    let calls = 0;
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.includes("cursor=")
        ? ++calls === 1
          ? pending.promise
          : Promise.resolve(Response.json(page([entry(20, "lunch")], null, 21)))
        : base(url, init),
    );
    await mount(fetch);
    await toggleNutrients(0);
    const oldHide = nutrientControl(0);
    await click("Load more");
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    pending.resolve(Response.json({ error: "Retry page" }, { status: 503 }));
    await hooks.settle();
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    await click("Retry load more");
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(20).props["aria-expanded"]).toBe(false);
    invoke(oldHide);
    await hooks.settle();
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
  });

  it.each(["success", "failure"])(
    "invalidates details at full-refresh start and stays closed through %s",
    async (outcome) => {
      const first = page(
        Array.from({ length: 20 }, (_, index) => entry(index)),
        "d1.next-page",
        21,
      );
      const pending = deferred<Response>();
      let reads = 0;
      const base = fetcher(first);
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("cursor="))
          return Promise.resolve(Response.json({ code: "DIARY_PAGE_STALE" }, { status: 409 }));
        if (url.startsWith("/api/diary?") && ++reads > 1) return pending.promise;
        return base(url, init);
      });
      await mount(fetch);
      await toggleNutrients(0);
      const oldHide = nutrientControl(0);
      await click("Load more");
      invoke(oldHide);
      expect(nutrientDetail(0)).toBeUndefined();
      const replacement = page(
        [{ ...entry(0), revision: "4", nutrients: [{ ...nutrient, knownAmount: "999.000" }] }],
        null,
        1,
        "2026-08-15",
        "9",
      );
      pending.resolve(
        outcome === "failure"
          ? Response.json({ error: "Full refresh failed" }, { status: 503 })
          : Response.json(replacement),
      );
      await hooks.settle();
      invoke(oldHide);
      await hooks.settle();
      if (outcome === "failure") expect(nutrientDetail(0)).toBeUndefined();
      else {
        expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
        await toggleNutrients(0);
        expect(nutrientDetailText(0)).toContain("Entry revision 4.");
        expect(nutrientDetailText(0)).toContain("999.000");
      }
    },
  );

  it.each(["owner", "time zone"] as const)(
    "hides an installed private snapshot before effects when verified %s context changes",
    async (change) => {
      const fetch = await mount();
      await toggleNutrients(0);
      const oldRepeat = button("Repeat Apple 0 today");
      const oldHide = nutrientControl(0),
        requests = fetch.mock.calls.length;
      const replacement = session(change === "owner" ? anotherOwner : owner);
      if (change === "time zone") replacement.data.profile.timeZone = "UTC";
      // Model an upstream verified context install before passive effects, not a new auth protocol.
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(replacement));
      expect(nutrientDetail(0)).toBeUndefined();
      invoke(oldHide);
      invoke(oldRepeat);
      expect(nutrientDetail(0)).toBeUndefined();
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session()));
      expect(nutrientDetail(0)).toBeUndefined();
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );

  it.each([
    "route",
    "date-return",
    "visibility",
    "pagehide",
    "unmount",
    "replay",
    "logout",
  ] as const)("closes details and fences retained controls across %s", async (transition) => {
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/logout"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : base(url, init),
    );
    await mount(fetch);
    await toggleNutrients(0);
    const oldHide = nutrientControl(0);
    const oldRepeat = button("Repeat Apple 0 today");
    if (transition === "route") {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    }
    if (transition === "date-return") {
      invoke(button("Next day"));
      route.date = "2026-08-16";
      await hooks.settle();
      invoke(button("Previous day"));
      route.date = "2026-08-15";
      await hooks.settle();
    }
    if (transition === "visibility") {
      detailLifecycle.visibility = "hidden";
      detailLifecycle.documentListeners.get("visibilitychange")?.();
      await hooks.settle();
    }
    if (transition === "pagehide") {
      detailLifecycle.windowListeners.get("pagehide")?.();
      await hooks.settle();
    }
    if (transition === "unmount") hooks.unmount();
    if (transition === "replay") {
      hooks.replayEffects();
      await hooks.settle();
    }
    if (transition === "logout") await click("Sign out");
    const requests = fetch.mock.calls.length,
      before = text();
    invoke(oldHide);
    invoke(oldRepeat);
    if (transition !== "route") await hooks.settle();
    expect(text()).toBe(before);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
    if (transition !== "unmount") expect(nutrientDetailText(0)).toBe("");
    if (transition === "visibility" || transition === "pagehide") {
      detailLifecycle.visibility = "visible";
      if (transition === "visibility")
        detailLifecycle.documentListeners.get("visibilitychange")?.();
      else detailLifecycle.windowListeners.get("pageshow")?.();
      await hooks.settle();
      expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
      invoke(oldHide);
      await hooks.settle();
      expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
      await toggleNutrients(0);
      expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    }
  });
});

describe("Expand all diary meals", () => {
  it("restores every loaded group and its nutrient choices without altering evidence or issuing effects", async () => {
    const fixture = page([entry(0), entry(1, "lunch"), entry(2, "dinner")], "d1.next-page", 24);
    const original = JSON.stringify(fixture),
      fetch = await mount(fetcher(fixture));
    await toggleNutrients(0);
    const groups = defaultDiaryGroups.map((item) => text(group(item.mealSlot)));
    const evidence = () =>
      elements()
        .filter(
          (node) =>
            node.props.id === "diary-page-count" ||
            node.props["aria-labelledby"] === "nutrition-summary-title",
        )
        .map((node) => text(node));
    const beforeEvidence = evidence(),
      message = text(elements().find((node) => node.props.role === "status") ?? null);
    const links = elements()
      .filter((node) => typeof node.props.href === "string")
      .map((node) => node.props.href);
    expect(links).toContain("/foods?date=2026-08-15&meal=breakfast");
    expect(links).toContain("/foods?date=2026-08-15&meal=lunch");
    await click("Collapse Breakfast");
    await click("Collapse Lunch");
    await click("Collapse Dinner");
    await click("Collapse Snacks");
    const requests = fetch.mock.calls.length,
      allocate = vi.fn();
    vi.stubGlobal("crypto", { randomUUID: allocate });
    const control = button("Expand all meals");
    expect(control.props.type).toBe("button");
    expect(control.props["aria-controls"]).toBe("diary-entry-groups");
    expect(control.props["aria-pressed"]).toBeUndefined();
    expect(control.props["aria-expanded"]).toBeUndefined();
    await click("Expand all meals");
    expect(defaultDiaryGroups.map((item) => text(group(item.mealSlot)))).toEqual(groups);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(1).props["aria-expanded"]).toBe(false);
    expect(evidence()).toEqual(beforeEvidence);
    expect(text()).toContain("3 of 24 entries loaded");
    expect(text(group("snacks"))).toContain("No entries loaded for this meal yet");
    expect(text(elements().find((node) => node.props.role === "status") ?? null)).toBe(message);
    expect(
      elements()
        .filter((node) => typeof node.props.href === "string")
        .map((node) => node.props.href),
    ).toEqual(links);
    expect(button("Load more").props.disabled).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(allocate).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps repeated empty membership a true no-op and rejects callbacks from before newer collapse choices", async () => {
    const fetch = await mount(),
      requests = fetch.mock.calls.length;
    const noop = button("Expand all meals"),
      collapse = button("Collapse Breakfast"),
      status = text();
    invoke(noop);
    invoke(noop);
    await hooks.settle();
    expect(button("Expand all meals").props.disabled).toBe(false);
    expect(text()).toBe(status);
    invoke(collapse);
    await hooks.settle();
    expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
    invoke(noop);
    await hooks.settle();
    expect(button("Expand Breakfast").props["aria-expanded"]).toBe(false);
    const changed = button("Expand all meals"),
      oldSingle = button("Expand Breakfast");
    invoke(changed);
    invoke(changed);
    invoke(oldSingle);
    await hooks.settle();
    expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
    const currentSingle = button("Collapse Lunch"),
      currentNoop = button("Expand all meals");
    invoke(currentNoop);
    invoke(currentNoop);
    invoke(currentSingle);
    await hooks.settle();
    expect(button("Expand Lunch").props["aria-expanded"]).toBe(false);
    invoke(changed);
    await hooks.settle();
    expect(button("Expand Lunch").props["aria-expanded"]).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
  });

  it("rejects a retained owner-A expansion before effects without clearing owner-B meal choices", async () => {
    const fetch = await mount();
    await click("Collapse Breakfast");
    const old = button("Expand all meals");
    hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    await click("Collapse Lunch");
    const before = text(),
      requests = fetch.mock.calls.length;
    invoke(old);
    await hooks.settle();
    expect(text()).toBe(before);
    expect(button("Expand Lunch").props["aria-expanded"]).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
  });
});

describe("actual Diary Repeat retry identity", () => {
  it.each([
    ["minute", "2026-08-15T18:00:59.000Z", "2026-08-15T18:01:01.000Z", "2026-08-15T18:00:00.000Z"],
    [
      "local midnight",
      "2026-08-16T04:59:59.000Z",
      "2026-08-16T05:00:01.000Z",
      "2026-08-16T04:59:00.000Z",
    ],
  ])(
    "pins unresolved Repeat across a %s boundary",
    async (_boundary, firstTime, retryTime, occurredAt) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(firstTime));
      if (_boundary === "local midnight") route.date = null;
      const writes: Array<{ url: string; body: string | null; headers: Record<string, string> }> =
        [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.includes("/repeat?")) {
          writes.push({
            url,
            body: typeof init.body === "string" ? init.body : null,
            headers: Object.fromEntries(new Headers(init.headers)),
          });
          return Response.json(
            { error: "The accepted response may have been lost." },
            { status: 503 },
          );
        }
        return base(url, init);
      });
      await mount(fetch);
      await click("Repeat Apple 0 today");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toBe(
        `/api/diary/entries/${entry(0).id}/repeat?date=2026-08-15&profileTimeZonePrecondition=v1`,
      );
      expect(writes[0]?.body).toBe(JSON.stringify({ occurredAt, mealSlot: "breakfast" }));
      expect(writes[0]?.headers["if-match"]).toBe('"3"');
      expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(text()).toContain(
        "Choose Repeat again to retry the same operation for 2026-08-15 safely.",
      );
      vi.setSystemTime(new Date(retryTime));
      await click("Repeat Apple 0 today");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
    },
  );
});

interface CapturedRepeat {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}
function captureRepeat(url: string, init: RequestInit): CapturedRepeat {
  if (typeof init.body !== "string") throw new Error("Repeat body must be serialized.");
  return { url, body: init.body, headers: Object.fromEntries(new Headers(init.headers)) };
}
function repeatReceipt(request: CapturedRepeat, resultNumber = 100) {
  const body = JSON.parse(request.body) as { occurredAt: string; mealSlot: MealSlot };
  const instant = new Date(body.occurredAt);
  const zone = request.headers["x-expected-profile-time-zone"] ?? "";
  const localDate = localDateInTimeZone(instant, zone);
  const sourceId = new URL(request.url, "https://app.example.test").pathname.split("/")[4];
  const result = {
    ...entry(resultNumber, body.mealSlot, localDate),
    revision: "1",
    occurredAt: body.occurredAt,
    timeZone: zone,
    localTime: localTimeInTimeZone(instant, zone),
  };
  const affectedDays = [{ localDate, revision: "9" }];
  const payload = {
    data: {
      replayed: true,
      entry: result,
      affectedDays,
      receipt: {
        protocol: "v1",
        operationId: request.headers["idempotency-key"],
        kind: "repeat",
        expectedSubjects: [
          { entryId: sourceId, revision: request.headers["if-match"]?.replaceAll('"', "") },
        ],
        resultSubjects: [{ entryId: result.id, revision: "1", state: "active" }],
        affectedDays,
      },
    },
  };
  expect(() => parseDiaryCorrectionMutation(payload)).not.toThrow();
  return payload;
}
async function visitDiaryDate(date: string) {
  route.date = date;
  hooks.render();
  await hooks.settle();
}

describe("Diary Repeat envelope lifecycle", () => {
  it("retains transport, generic conflict, malformed and mismatched results, then starts a new intent only after verified success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T04:59:59.000Z"));
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        if (writes.length === 1) throw new TypeError("Connection lost after sending the request.");
        if (writes.length === 2)
          return Response.json({ code: "UNCLASSIFIED_CONFLICT" }, { status: 409 });
        if (writes.length === 3) return Response.json({ data: { malformed: true } });
        const receipt = repeatReceipt(request);
        if (writes.length === 4) receipt.data.receipt.operationId = entry(999).id;
        return Response.json(receipt);
      }
      return base(url, init);
    });
    await mount(fetch);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) vi.setSystemTime(new Date(`2026-08-16T05:0${attempt}:01.000Z`));
      await click("Repeat Apple 0 today");
      if (attempt < 4) expect(text()).toContain("same operation for 2026-08-15 safely.");
    }
    expect(writes).toHaveLength(5);
    for (const request of writes.slice(1)) expect(request).toEqual(writes[0]);
    expect(text()).toContain("Pinned entry version repeated");
    vi.setSystemTime(new Date("2026-08-16T05:05:01.000Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(6);
    expect(writes[5]?.body).toBe(
      '{"occurredAt":"2026-08-16T05:05:00.000Z","mealSlot":"breakfast"}',
    );
    expect(writes[5]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
    expect(writes[5]?.url).toBe(writes[0]?.url);
  });

  it("keeps independent unresolved source entries separate and rejects same-paint concurrent Repeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
    const pending = deferred<Response>();
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        writes.push(captureRepeat(url, init));
        return writes.length === 1 ? pending.promise : Response.json({}, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const first = button("Repeat Apple 0 today"),
      second = button("Repeat Apple 1 today");
    invoke(first);
    invoke(first);
    invoke(second);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    pending.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    vi.setSystemTime(new Date("2026-08-15T18:01:01.000Z"));
    await click("Repeat Apple 1 today");
    vi.setSystemTime(new Date("2026-08-16T05:01:01.000Z"));
    await click("Repeat Apple 0 today");
    await click("Repeat Apple 1 today");
    expect(writes).toHaveLength(4);
    expect(writes[2]).toEqual(writes[0]);
    expect(writes[3]).toEqual(writes[1]);
    expect(writes[0]?.headers["idempotency-key"]).not.toBe(writes[1]?.headers["idempotency-key"]);
    expect(JSON.parse(writes[1]?.body ?? "{}").mealSlot).toBe("lunch");
  });

  it("retires verified success before failed readback and does not reuse its operation after explicit Retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
    const writes: CapturedRepeat[] = [];
    let failReadback = false;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        failReadback = writes.length === 1;
        return Response.json(repeatReceipt(request));
      }
      if (url.startsWith("/api/diary?") && failReadback) {
        failReadback = false;
        return Response.json({ error: "Readback unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 today");
    expect(text()).toContain(
      "The entry was repeated, but fresh diary data could not be confirmed.",
    );
    await click("Retry");
    vi.setSystemTime(new Date("2026-08-15T18:01:01.000Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
    expect(writes[1]?.body).toContain("2026-08-15T18:01:00.000Z");
  });

  it("retries the original envelope after a fresh same-owner source date, revision and zone change while rejecting old rendered controls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
    const writes: CapturedRepeat[] = [];
    let changedSource = false;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        return writes.length === 1
          ? Response.json({}, { status: 503 })
          : Response.json(repeatReceipt(request));
      }
      if (changedSource && url.startsWith("/api/diary?"))
        return Response.json(
          page(
            [{ ...entry(0, "dinner", "2026-08-16"), revision: "4" }],
            null,
            1,
            "2026-08-16",
            "9",
          ),
        );
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 today");
    const old = button("Repeat Apple 0 today");
    changedSource = true;
    await visitDiaryDate("2026-08-16");
    const beforeZone = button("Repeat Apple 0 today");
    const replacement = session();
    replacement.data.profile.timeZone = "UTC";
    hooks.replaceVerifiedSessionBeforeEffects(parseSession(replacement));
    const count = fetch.mock.calls.length;
    invoke(old);
    invoke(beforeZone);
    expect(fetch.mock.calls).toHaveLength(count);
    hooks.render();
    await hooks.settle();
    vi.setSystemTime(new Date("2026-08-16T06:05:01.000Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]?.url).toContain("date=2026-08-15&");
    expect(writes[1]?.headers["if-match"]).toBe('"3"');
    expect(writes[1]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
    expect(text()).toContain("Pinned entry version repeated");
  });

  it.each([412, 409])(
    "releases the captured intent only after definitive %s recovery",
    async (status) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
      const writes: CapturedRepeat[] = [];
      let recovered = false;
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.includes("/repeat?")) {
          writes.push(captureRepeat(url, init));
          if (writes.length === 1) {
            recovered = true;
            return Response.json(
              { code: status === 409 ? "DIARY_TIME_ZONE_CHANGED" : "ENTRY_PRECONDITION_FAILED" },
              { status },
            );
          }
          return Response.json({}, { status: 503 });
        }
        if (recovered && status === 409 && url === "/api/auth/me") {
          const replacement = session();
          replacement.data.profile.timeZone = "UTC";
          return Response.json(replacement);
        }
        if (recovered && url.startsWith("/api/diary?"))
          return Response.json(page([{ ...entry(0), revision: "4" }], null, 1));
        return base(url, init);
      });
      await mount(fetch);
      await click("Repeat Apple 0 today");
      expect(text()).toContain(
        status === 409 ? "Nothing was repeated" : "The source entry changed",
      );
      vi.setSystemTime(new Date("2026-08-15T18:02:01.000Z"));
      await click("Repeat Apple 0 today");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toContain("2026-08-15T18:02:00.000Z");
      expect(writes[1]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
      expect(writes[1]?.headers["if-match"]).toBe('"4"');
      expect(writes[1]?.headers["x-expected-profile-time-zone"]).toBe(
        status === 409 ? "UTC" : "America/Chicago",
      );
    },
  );

  it("does not let a late old receipt retire a newer unresolved slot or release its pending mutation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T05:01:01.000Z"));
    const oldResponse = deferred<Response>(),
      currentResponse = deferred<Response>();
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        if (writes.length === 1) return oldResponse.promise;
        if (writes.length === 2) return Response.json(repeatReceipt(request));
        if (writes.length === 3) return currentResponse.promise;
        return Response.json({}, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    invoke(button("Repeat Apple 0 today"));
    await hooks.settle();
    await visitDiaryDate("2026-08-16");
    await visitDiaryDate("2026-08-15");
    await click("Repeat Apple 0 today");
    expect(writes[1]).toEqual(writes[0]);
    vi.setSystemTime(new Date("2026-08-16T05:02:01.000Z"));
    invoke(button("Repeat Apple 0 today"));
    await hooks.settle();
    expect(writes).toHaveLength(3);
    expect(writes[2]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
    const oldRequest = writes[0];
    if (!oldRequest) throw new Error("Missing old request.");
    oldResponse.resolve(Response.json(repeatReceipt(oldRequest)));
    await hooks.settle();
    expect(button("Repeat Apple 0 today").props.disabled).toBe(true);
    expect(writes).toHaveLength(3);
    currentResponse.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    vi.setSystemTime(new Date("2026-08-16T05:03:01.000Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(4);
    expect(writes[3]).toEqual(writes[2]);
  });

  it("closes Repeat on current401 and rejects the retained control after private closure and unmount", async () => {
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        writes.push(captureRepeat(url, init));
        return Response.json({}, { status: 401 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const old = button("Repeat Apple 0 today");
    await click("Repeat Apple 0 today");
    expect(router.replace).toHaveBeenCalledWith("/login");
    const count = fetch.mock.calls.length;
    invoke(old);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
    hooks.unmount();
    invoke(old);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(hooks.afterClose()).toBe(0);
    expect(writes).toHaveLength(1);
  });
});

describe("Diary Repeat overlapping receipt publication", () => {
  it("publishes the current matching retry after an old-view matching response arrives first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
    const oldResponse = deferred<Response>(),
      retryResponse = deferred<Response>();
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        writes.push(captureRepeat(url, init));
        return writes.length === 1 ? oldResponse.promise : retryResponse.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    invoke(button("Repeat Apple 0 today"));
    await hooks.settle();
    await visitDiaryDate("2026-08-16");
    await visitDiaryDate("2026-08-15");
    vi.setSystemTime(new Date("2026-08-15T18:01:01.000Z"));
    invoke(button("Repeat Apple 0 today"));
    await hooks.settle();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    const request = writes[0];
    if (!request) throw new Error("Missing shared request.");
    const reads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?")).length;
    oldResponse.resolve(Response.json(repeatReceipt(request)));
    await hooks.settle();
    expect(button("Repeat Apple 0 today").props.disabled).toBe(true);
    retryResponse.resolve(Response.json(repeatReceipt(request)));
    await hooks.settle();
    expect(text()).toContain("Pinned entry version repeated");
    expect(button("Repeat Apple 0 today").props.disabled).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?")).length).toBe(
      reads + 1,
    );
  });
});

describe("independent day-note parent wiring", () => {
  it("mounts on empty diary days and fences old note callbacks before date effects without loading the diary", async () => {
    const fetch = await mount(fetcher(page([], null, 0)));
    const child = elements().find((node) => node.type === DiaryDayNote);
    if (!child) throw new Error("Missing independent day-note section");
    expect(child.props.localDate).toBe("2026-08-15");
    expect((child.props.isPrivateCurrent as () => boolean)()).toBe(true);
    expect((child.props.isViewCurrent as () => boolean)()).toBe(true);
    const before = fetch.mock.calls.length;
    route.date = "2026-08-16";
    hooks.renderWithoutEffects();
    expect((child.props.isViewCurrent as () => boolean)()).toBe(false);
    expect((child.props.isPrivateCurrent as () => boolean)()).toBe(true);
    expect(fetch.mock.calls.length).toBe(before);
  });
});

describe("web diary repeat destination", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T18:25:37.456Z"));
  });

  it("opens one local destination composer with configured groups and cancels without a request", async () => {
    const fetch = await mount();
    const requests = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    expect(field("Repeat date").props.value).toBe("2026-08-20");
    expect(field("Repeat meal").props.value).toBe("breakfast");
    expect(text()).toContain("Today uses the current time; another date uses noon");
    await change("Repeat date", "2026-08-21");
    await change("Repeat meal", "lunch");
    await click("Cancel repeat destination");
    expect(
      elements().some((node) => node.props["aria-label"] === "Repeat destination for Apple 0"),
    ).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it.each([
    ["2026-08-20", "2026-08-20T18:25:37.456Z"],
    ["2026-08-21", "2026-08-21T17:00:00.000Z"],
    ["2026-01-10", "2026-01-10T18:00:00.000Z"],
  ])(
    "repeats a pinned food to %s using the existing date policy and configured meal order",
    async (targetDate, occurredAt) => {
      const groups = [
        { mealSlot: "dinner" as const, label: "Evening" },
        { mealSlot: "breakfast" as const, label: "Morning" },
        { mealSlot: "snacks" as const, label: "Small meals" },
        { mealSlot: "lunch" as const, label: "Midday" },
      ];
      const writes: CapturedRepeat[] = [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return Response.json(session(owner, groups));
        if (init?.method === "POST" && url.includes("/repeat?")) {
          const request = captureRepeat(url, init);
          writes.push(request);
          return Response.json(repeatReceipt(request));
        }
        return base(url, init);
      });
      await mount(fetch);
      await click("Repeat Apple 0 to another day or meal");
      expect(
        elements(field("Repeat meal"))
          .filter((node) => node.type === "option")
          .map((node) => [node.props.value, text(node)]),
      ).toEqual(groups.map((group) => [group.mealSlot, group.label]));
      await change("Repeat date", targetDate);
      await change("Repeat meal", "lunch");
      await click("Confirm repeat destination");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toBe(JSON.stringify({ occurredAt, mealSlot: "lunch" }));
      expect(writes[0]?.headers["if-match"]).toBe('"3"');
      expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(writes[0]?.url).toBe(
        `/api/diary/entries/${entry(0).id}/repeat?date=2026-08-15&profileTimeZonePrecondition=v1`,
      );
      expect(text()).toContain(`Pinned entry version repeated in Midday for ${targetDate}.`);
      expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?")).length).toBe(1);
      const summary = elements().find(
        (node) => node.props["aria-labelledby"] === "nutrition-summary-title",
      );
      expect(text(summary)).toContain("≥ 125.500000000000 kcal");
      expect(text()).not.toContain("Pending repeat:");
    },
  );

  it("repeats a recipe from a locked source without reconstructing its snapshot", async () => {
    const { foodProvenance: _provenance, ...recipeBase } = entry(2, "dinner");
    const recipeEntry = {
      ...recipeBase,
      entryKind: "recipe",
      foodVersionId: null,
      recipeVersionId: "de1f6d0a-f7dc-4b25-b7b9-3eef1d44779a",
      portion: { kind: "serving", amount: "1.250000", servingLabel: "bowl" },
      food: null,
      source: null,
      sources: [source],
      recipe: {
        id: "df94a52f-e84a-4cd5-873e-227d1e213d62",
        name: "Saved stew",
        versionNumber: 2,
        yieldGrams: "800",
        yieldSource: "measured",
        servingCount: "4",
        servingLabel: "bowl",
        calculationVersion: "recipe-v1",
        retentionPolicy: {
          code: "identity-retention-default",
          version: "1",
          assumption: "No cooking-retention factor was applied.",
        },
        warnings: [],
      },
    };
    const fixture = {
      ...page(),
      data: { ...page().data, status: "locked", entries: [recipeEntry] },
      page: { nextCursor: null, totalEntries: 1 },
    };
    expect(() => parseDiaryPage(fixture)).not.toThrow();
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    await mount(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/diary?")) return Response.json(fixture);
        if (init?.method === "POST" && url.includes("/repeat?")) {
          writes.push(captureRepeat(url, init));
          return Response.json({ error: "Uncertain response" }, { status: 503 });
        }
        return base(url, init);
      }),
    );
    await click("Repeat Saved stew to another day or meal");
    await change("Repeat date", "2026-08-22");
    await click("Confirm repeat destination");
    expect(writes[0]?.url).toContain(recipeEntry.id);
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({
      occurredAt: "2026-08-22T17:00:00.000Z",
      mealSlot: "dinner",
    });
  });

  it.each([
    ["Repeat date", "2026-02-30"],
    ["Repeat date", ""],
    ["Repeat meal", "unconfigured"],
  ])("rejects invalid %s locally", async (label, value) => {
    const fetch = await mount();
    const count = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    await change(label, value);
    await click("Confirm repeat destination");
    expect(text()).toContain("Choose a valid repeat date and one of your configured meals.");
    expect(field(label).props.value).toBe(value);
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("keeps a valid-calendar skipped date local and explains the zone error", async () => {
    const apiaSession = session();
    apiaSession.data.profile.timeZone = "Pacific/Apia";
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/me" ? Promise.resolve(Response.json(apiaSession)) : base(url, init),
    );
    await mount(fetch);
    const count = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    await change("Repeat date", "2011-12-30");
    await click("Confirm repeat destination");
    expect(text()).toContain("That repeat date has no usable time in your profile time zone.");
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("fences retained coordinate, cancel, confirm and open controls before rerender", async () => {
    const fetch = await mount();
    const count = fetch.mock.calls.length;
    const oldOpen = button("Repeat Apple 0 to another day or meal");
    await click("Repeat Apple 0 to another day or meal");
    const oldConfirm = button("Confirm repeat destination");
    const oldCancel = button("Cancel repeat destination");
    const oldMeal = field("Repeat meal");
    invoke(field("Repeat date"), "onChange", { target: { value: "2026-08-24" } });
    invoke(oldConfirm);
    invoke(oldCancel);
    invoke(oldMeal, "onChange", { target: { value: "dinner" } });
    invoke(oldOpen);
    await hooks.settle();
    expect(field("Repeat date").props.value).toBe("2026-08-24");
    expect(field("Repeat meal").props.value).toBe("breakfast");
    const earlierConfirm = button("Confirm repeat destination");
    await click("Repeat Apple 1 to another day or meal");
    invoke(earlierConfirm);
    await hooks.settle();
    expect(
      elements().filter((node) =>
        node.props["aria-label"]?.toString().startsWith("Repeat destination for "),
      ),
    ).toHaveLength(1);
    expect(field("Repeat meal").props.value).toBe("lunch");
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it.each([
    "route",
    "date-return",
    "visibility",
    "pagehide",
    "unmount",
    "logout",
    "profile",
    "collapse",
    "edit",
  ] as const)(
    "retires the destination and rejects retained controls after %s",
    async (transition) => {
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url === "/api/auth/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : base(url, init),
      );
      await mount(fetch);
      await click("Repeat Apple 0 to another day or meal");
      const confirm = button("Confirm repeat destination"),
        cancel = button("Cancel repeat destination"),
        dateInput = field("Repeat date");
      if (transition === "route") {
        route.date = "2026-08-16";
        hooks.renderWithoutEffects();
      }
      if (transition === "date-return") {
        await visitDiaryDate("2026-08-16");
        await visitDiaryDate("2026-08-15");
      }
      if (transition === "visibility") {
        detailLifecycle.visibility = "hidden";
        detailLifecycle.documentListeners.get("visibilitychange")?.();
      }
      if (transition === "pagehide") detailLifecycle.windowListeners.get("pagehide")?.();
      if (transition === "unmount") hooks.unmount();
      if (transition === "logout") await click("Sign out");
      if (transition === "profile")
        hooks.replaceVerifiedSessionBeforeEffects(
          parseSession(session(owner, defaultDiaryGroups, "2")),
        );
      if (transition === "collapse") invoke(button("Collapse Breakfast"));
      if (transition === "edit") invoke(button("Edit Apple 0"));
      const count = fetch.mock.calls.length;
      invoke(confirm);
      invoke(cancel);
      invoke(dateInput, "onChange", { target: { value: "2026-09-01" } });
      if (transition !== "route") await hooks.settle();
      expect(fetch).toHaveBeenCalledTimes(count);
      expect(hooks.afterClose()).toBe(0);
      if (transition !== "unmount")
        expect(
          elements().some((node) => node.props["aria-label"] === "Repeat destination for Apple 0"),
        ).toBe(false);
      if (transition === "collapse") {
        await click("Expand Breakfast");
        expect(
          elements().some((node) => node.props["aria-label"] === "Repeat destination for Apple 0"),
        ).toBe(false);
      }
    },
  );

  it("shows the immutable custom destination and explicitly retries the exact envelope across midnight", async () => {
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        return writes.length === 1
          ? Response.json({ error: "Response lost" }, { status: 503 })
          : Response.json(repeatReceipt(request));
      }
      return base(url, init);
    });
    await mount(fetch);
    const oldToday = button("Repeat Apple 0 today");
    const oldOpen = button("Repeat Apple 0 to another day or meal");
    await click("Repeat Apple 0 to another day or meal");
    await change("Repeat date", "2026-10-04");
    await change("Repeat meal", "dinner");
    await click("Confirm repeat destination");
    expect(text()).toContain("Pending repeat: 2026-10-04 · Dinner · America/Chicago");
    expect(button("Repeat Apple 0 to another day or meal").props.disabled).toBe(true);
    expect(elements().some((node) => node.props["aria-label"] === "Repeat Apple 0 today")).toBe(
      false,
    );
    invoke(oldToday);
    invoke(oldOpen);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    const retry = button("Retry repeat for Apple 0");
    vi.setSystemTime(new Date("2026-08-22T03:00:00.001Z"));
    await click("Retry repeat for Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toBe(
      JSON.stringify({ occurredAt: "2026-10-04T17:00:00.000Z", mealSlot: "dinner" }),
    );
    expect(text()).not.toContain("Pending repeat:");
    invoke(retry);
    await hooks.settle();
    expect(writes).toHaveLength(2);
  });

  it("does not revive a cancelled destination from retained controls", async () => {
    const fetch = await mount();
    const count = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    const confirm = button("Confirm repeat destination"),
      oldDate = field("Repeat date");
    await click("Cancel repeat destination");
    invoke(confirm);
    invoke(oldDate, "onChange", { target: { value: "2026-10-01" } });
    await hooks.settle();
    expect(
      elements().some((node) => node.props["aria-label"] === "Repeat destination for Apple 0"),
    ).toBe(false);
    await click("Repeat Apple 0 to another day or meal");
    invoke(confirm);
    await hooks.settle();
    expect(field("Repeat date").props.value).toBe("2026-08-20");
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("reloads authoritative source-day totals after repeating into that same day", async () => {
    const updatedNutrient = { ...nutrient, knownAmount: "377.250000000000" };
    const base = fetcher();
    let reads = 0;
    const writes: CapturedRepeat[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/diary?")) {
        reads += 1;
        const value = page();
        if (reads > 1) {
          value.data.revision = "9";
          value.data.totals = [updatedNutrient];
        }
        return Response.json(value);
      }
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        return Response.json(repeatReceipt(request));
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 to another day or meal");
    await change("Repeat date", "2026-08-15");
    await change("Repeat meal", "lunch");
    await click("Confirm repeat destination");
    expect(reads).toBe(2);
    expect(writes[0]?.body).toBe(
      JSON.stringify({ occurredAt: "2026-08-15T17:00:00.000Z", mealSlot: "lunch" }),
    );
    expect(text()).toContain(
      "Pinned entry version repeated in Lunch with fresh authoritative totals.",
    );
    const summary = elements().find(
      (node) => node.props["aria-labelledby"] === "nutrition-summary-title",
    );
    expect(text(summary)).toContain("≥ 377.250000000000 kcal");
  });

  it("fences an explicit retry while its meal is collapsed and reuses it after expansion", async () => {
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    await mount(
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.includes("/repeat?")) {
          writes.push(captureRepeat(url, init));
          return Response.json({ error: "Response lost" }, { status: 503 });
        }
        return base(url, init);
      }),
    );
    await click("Repeat Apple 0 to another day or meal");
    await change("Repeat date", "2026-08-21");
    await click("Confirm repeat destination");
    const retry = button("Retry repeat for Apple 0");
    invoke(button("Collapse Breakfast"));
    invoke(retry);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    await click("Expand Breakfast");
    await click("Retry repeat for Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  it("retires a destination when route dates change and return before effects", async () => {
    const fetch = await mount();
    const count = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    const confirm = button("Confirm repeat destination");
    route.date = "2026-08-16";
    hooks.renderWithoutEffects();
    route.date = "2026-08-15";
    hooks.renderWithoutEffects();
    expect(
      elements().some((node) => node.props["aria-label"] === "Repeat destination for Apple 0"),
    ).toBe(false);
    invoke(confirm);
    await hooks.settle();
    expect(fetch).toHaveBeenCalledTimes(count);
  });
});

describe("dashboard overview composition", () => {
  it("uses the current whole-day snapshot without loading every entry or mounting diary tools", async () => {
    const fixture = page(
      Array.from({ length: 20 }, (_, index) => entry(index)),
      "d1.next-page",
      45,
    );
    const fetch = await mount(fetcher(fixture), "overview");
    const summary = elements().find((node) => node.type === CalmOverview);
    expect(summary?.props.totalEntries).toBe(45);
    expect(summary?.props.completeDayLoaded).toBe(false);
    expect(elements().some((node) => node.props["aria-label"] === "Dashboard actions")).toBe(false);
    expect((summary?.props.day as { totals: unknown })?.totals).toEqual(fixture.data.totals);
    expect(elements().filter((node) => node.type === DiaryDayNote)).toHaveLength(1);
    const noteDisclosure = elements().find(
      (node) => node.type === "details" && node.props.className === "calmNote",
    );
    expect(noteDisclosure).toBeDefined();
    expect(noteDisclosure?.props.open).toBeUndefined();
    expect(text()).toContain("View or edit note");
    expect(elements().some((node) => node.props.id === "diary-entry-groups")).toBe(false);
    expect(text()).not.toContain("Customize diary groups");
    expect(text()).not.toContain("Load more");
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(1);
  });

  it("keeps date navigation on overview and removes the old summary while the next day loads", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?date=2026-08-16") ? pending.promise : base(url, init),
    );
    await mount(fetch, "overview");
    expect(elements().some((node) => node.type === CalmOverview)).toBe(true);
    invoke(button("Next day"));
    route.date = "2026-08-16";
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/overview?date=2026-08-16", { scroll: false });
    expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
    pending.resolve(Response.json(page([entry(2, "breakfast", route.date)], null, 1, route.date)));
    await hooks.settle();
    expect(elements().find((node) => node.type === CalmOverview)?.props.totalEntries).toBe(1);
  });

  it("clears the summary when the existing unauthorized path closes private UI", async () => {
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?date=2026-08-16")
        ? Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }))
        : base(url, init),
    );
    await mount(fetch, "overview");
    expect(elements().some((node) => node.type === CalmOverview)).toBe(true);
    invoke(button("Next day"));
    route.date = "2026-08-16";
    await hooks.settle();
    expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/login");
  });
});
