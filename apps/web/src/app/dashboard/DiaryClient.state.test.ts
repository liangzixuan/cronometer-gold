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
  moveDiaryGroup,
  nutrientDisplay,
  parseDiaryCorrectionMutation,
  parseDiaryPage,
  parseSession,
} from "../../lib/diary";
import { CalmOverview } from "./CalmOverview";
import { DiaryClient } from "./DiaryClient";
import { DiaryDayNote } from "./DiaryDayNote";
import { DiaryEntryEditorForm } from "./DiaryEntryEditorForm";
import { TodayOverviewCards } from "./TodayOverviewCards";

interface ElementNode {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function elements(value: unknown = hooks.tree()): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item ?? null));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ElementNode;
  if (node.type === DiaryEntryEditorForm)
    return elements(
      DiaryEntryEditorForm(node.props as unknown as Parameters<typeof DiaryEntryEditorForm>[0]),
    );
  return [node, ...elements(node.props.children ?? null)];
}
function text(value: unknown = hooks.tree()): string {
  if (Array.isArray(value)) return value.map((item) => text(item ?? null)).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  const node = value as ElementNode;
  if (node.type === DiaryEntryEditorForm)
    return text(
      DiaryEntryEditorForm(node.props as unknown as Parameters<typeof DiaryEntryEditorForm>[0]),
    );
  return text(node.props.children ?? null);
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
      occurredAt: "2026-08-15T14:45:00.000Z",
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
      "≥ 125 kcalPartial · 1/2 contributions quantified",
      "Second recorded value (kcal)",
      "≥ 3 kcalPartial · 1/2 contributions quantified",
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
        expect(nutrientDetailText(0)).toContain("≥ 999 kcal");
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
    ["minute", "2026-08-15T18:00:59.000Z", "2026-08-15T18:01:01.000Z", "2026-08-15T18:00:59.000Z"],
    [
      "local midnight",
      "2026-08-16T04:59:59.000Z",
      "2026-08-16T05:00:01.000Z",
      "2026-08-16T04:59:59.000Z",
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
      '{"occurredAt":"2026-08-16T05:05:01.000Z","mealSlot":"breakfast"}',
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
    expect(writes[1]?.body).toContain("2026-08-15T18:01:01.000Z");
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
      expect(writes[1]?.body).toContain("2026-08-15T18:02:01.000Z");
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
      expect(text(summary)).toContain("≥ 125 kcal");
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
    expect(text(summary)).toContain("≥ 377 kcal");
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

const saveLockFields = ["Quantity", "Meal", "Local date", "Local time", "Private note"] as const;
function editorField(label: string): ElementNode {
  const editor = elements().find((node) => node.props.className === "entryEditor");
  const labelled = elements(editor).find(
    (node) => node.type === "label" && text(node).trim().startsWith(label),
  );
  const input = elements(labelled).find((node) =>
    ["input", "select", "textarea"].includes(String(node.type)),
  );
  if (!input) throw new Error(`Missing editor field: ${label}`);
  return input;
}
async function changeEditorField(label: string, value: string) {
  invoke(editorField(label), "onChange", { target: { value } });
  await hooks.settle();
}
function editorValues() {
  return saveLockFields.map((label) => editorField(label).props.value);
}
async function prepareSaveLockDraft() {
  await click("Edit Apple 0");
  await changeEditorField("Quantity", "2.125000");
  await changeEditorField("Meal", "dinner");
  await changeEditorField("Local time", "09:45");
  await changeEditorField("Private note", "  Keep this exact draft\nincluding spacing  ");
}
function retainedEditorControls() {
  return {
    fields: saveLockFields.map((label) => editorField(label)),
    clear: button("Clear note field for Apple 0"),
    cancel: button("Cancel editing Apple 0"),
    save: button("Save changes to Apple 0"),
    open: button("Edit Apple 1"),
  };
}
function invokeEditorControls(controls: ReturnType<typeof retainedEditorControls>) {
  const replacements = ["8.5000", "lunch", "2026-08-20", "11:22", "stale replacement"];
  controls.fields.forEach((node, index) => {
    invoke(node, "onChange", { target: { value: replacements[index] } });
  });
  invoke(controls.clear);
  invoke(controls.cancel);
  invoke(controls.save);
  invoke(controls.open);
}

function captureEditorSave(url: string, init: RequestInit) {
  if (typeof init.body !== "string") throw new Error("Expected a serialized editor save.");
  return { url, body: init.body, headers: Object.fromEntries(new Headers(init.headers)) };
}
function editorSaveReceipt(request: ReturnType<typeof captureEditorSave>, original = entry(0)) {
  const body = JSON.parse(request.body) as {
    portion: { kind: "serving"; servingId: string; amount: string };
    mealSlot: MealSlot;
    note?: string;
    occurredAt?: string;
  };
  const occurredAt = body.occurredAt ?? original.occurredAt;
  const zone = request.headers["x-expected-profile-time-zone"] ?? original.timeZone;
  const instant = new Date(occurredAt);
  const localDate = localDateInTimeZone(instant, zone);
  const result = {
    ...original,
    revision: "4",
    portion: { ...original.portion, ...body.portion },
    mealSlot: body.mealSlot,
    note: body.note === undefined ? original.note : body.note,
    occurredAt,
    localDate,
    localTime: localTimeInTimeZone(instant, zone),
    timeZone: zone,
  };
  const affectedDays = [{ localDate, revision: "9" }];
  const payload = {
    data: {
      replayed: false,
      entry: result,
      affectedDays,
      receipt: {
        protocol: "v1",
        operationId: request.headers["idempotency-key"],
        kind: "update",
        expectedSubjects: [{ entryId: original.id, revision: "3" }],
        resultSubjects: [{ entryId: original.id, revision: "4", state: "active" }],
        affectedDays,
      },
    },
  };
  expect(() => parseDiaryCorrectionMutation(payload)).not.toThrow();
  return payload;
}
describe("Diary save lock", () => {
  it.each([...saveLockFields, "Clear", "Cancel", "Save"] as const)(
    "rejects the retained %s callback synchronously once saving starts",
    async (action) => {
      const pending = deferred<Response>();
      const writes: RequestInit[] = [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          writes.push(init);
          return pending.promise;
        }
        return base(url, init);
      });
      await mount(fetch);
      await prepareSaveLockDraft();
      const raw = editorValues();
      const control = saveLockFields.includes(action as (typeof saveLockFields)[number])
        ? editorField(action)
        : button(
            action === "Clear"
              ? "Clear note field for Apple 0"
              : action === "Cancel"
                ? "Cancel editing Apple 0"
                : "Save changes to Apple 0",
          );
      invoke(button("Save changes to Apple 0"));
      if (action === "Clear" || action === "Cancel" || action === "Save") invoke(control);
      else invoke(control, "onChange", { target: { value: "stale replacement" } });
      await hooks.settle();
      expect(writes).toHaveLength(1);
      expect(editorValues()).toEqual(raw);
      pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
    },
  );

  it("disables the pending editor and other Edit controls while keeping saved nutrients available", async () => {
    const pending = deferred<Response>();
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(init);
        return pending.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    await prepareSaveLockDraft();
    const raw = editorValues();
    const oldOpen = button("Edit Apple 1");
    invoke(button("Save changes to Apple 0"));
    invoke(oldOpen);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(editorValues()).toEqual(raw);
    const pendingControls = retainedEditorControls();
    for (const node of [
      ...pendingControls.fields,
      pendingControls.clear,
      pendingControls.cancel,
      pendingControls.save,
      pendingControls.open,
    ]) {
      expect(node.props.disabled).toBe(true);
    }
    invokeEditorControls(pendingControls);
    await hooks.settle();
    expect(editorValues()).toEqual(raw);
    expect(writes).toHaveLength(1);
    await toggleNutrients(0);
    expect(nutrientDetailText(0)).toContain("1.250000 × medium apple");
    expect(nutrientDetailText(0)).toContain("Unsaved edits are not included.");
    expect(editorValues()).toEqual(raw);
    pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
    await hooks.settle();
  });

  it("accepts the submitted draft and closes normally after its verified receipt and readback", async () => {
    const pending = deferred<Response>();
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    const base = fetcher();
    let saved: ReturnType<typeof editorSaveReceipt> | null = null;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(captureEditorSave(url, init));
        return pending.promise;
      }
      if (saved && url.startsWith("/api/diary?")) {
        return Response.json(
          page([saved.data.entry, entry(1, "lunch")], null, 2, "2026-08-15", "9"),
        );
      }
      return base(url, init);
    });
    await mount(fetch);
    await prepareSaveLockDraft();
    const raw = editorValues();
    const retained = retainedEditorControls();
    invoke(retained.save);
    invokeEditorControls(retained);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(editorValues()).toEqual(raw);
    const request = writes[0];
    if (!request) throw new Error("Missing save request.");
    saved = editorSaveReceipt(request);
    pending.resolve(Response.json(saved));
    await hooks.settle();
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    expect(text()).toContain("Diary entry saved in Dinner with fresh totals.");
    expect(text(group("dinner"))).toContain("2.125000 × medium apple");
    expect(text(group("dinner"))).toContain("Keep this exact draft");
    const requests = fetch.mock.calls.length;
    invokeEditorControls(retained);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    await click("Edit Apple 0");
    expect(editorValues()).toEqual(raw);
  });

  it.each(["newer edit", "edit-restore", "cancel-reopen", "another editor"] as const)(
    "rejects the old editor callbacks after %s even when raw values return",
    async (transition) => {
      const fetch = await mount();
      await prepareSaveLockDraft();
      const old = retainedEditorControls();
      if (transition === "newer edit") await changeEditorField("Quantity", "4.000001");
      if (transition === "edit-restore") {
        await changeEditorField("Quantity", "4.000001");
        await changeEditorField("Quantity", "2.125000");
      }
      if (transition === "cancel-reopen") {
        await click("Cancel editing Apple 0");
        await prepareSaveLockDraft();
      }
      if (transition === "another editor") await click("Edit Apple 1");
      const raw = editorValues();
      const before = text();
      const requests = fetch.mock.calls.length;
      invokeEditorControls(old);
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      expect(text()).toBe(before);
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );

  it.each([
    "route-before-effects",
    "route-return",
    "owner",
    "logout",
    "unmount",
    "effect-replay",
  ] as const)("rejects retained editor fields and actions after %s", async (transition) => {
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/logout"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : base(url, init),
    );
    await mount(fetch);
    await prepareSaveLockDraft();
    const old = retainedEditorControls();
    if (transition === "route-before-effects") {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    }
    if (transition === "route-return") {
      await visitDiaryDate("2026-08-16");
      await visitDiaryDate("2026-08-15");
      await prepareSaveLockDraft();
    }
    if (transition === "owner")
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    if (transition === "logout") await click("Sign out");
    if (transition === "unmount") hooks.unmount();
    if (transition === "effect-replay") {
      hooks.replayEffects();
      await hooks.settle();
    }
    const requests = fetch.mock.calls.length;
    const before = text();
    invokeEditorControls(old);
    if (transition === "route-before-effects" || transition === "owner")
      hooks.renderWithoutEffects();
    else await hooks.settle();
    expect(text()).toBe(before);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
  });

  it.each(["503", "network", "malformed receipt", "mismatched receipt"] as const)(
    "retains the exact timestamp-changing request after %s and fences both earlier generations during retry",
    async (failure) => {
      const firstReady = deferred<void>();
      const retry = deferred<Response>();
      const writes: ReturnType<typeof captureEditorSave>[] = [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method !== "PATCH") return base(url, init);
        const request = captureEditorSave(url, init);
        writes.push(request);
        if (writes.length === 1) {
          await firstReady.promise;
          if (failure === "network") throw new Error("Connection lost.");
          if (failure === "malformed receipt") return Response.json({ data: {} });
          if (failure === "mismatched receipt") {
            const receipt = editorSaveReceipt(request);
            receipt.data.receipt.operationId = "07e634de-cd94-4f81-b290-e708901e217f";
            return Response.json(receipt);
          }
          return Response.json({ error: "Response unavailable." }, { status: 503 });
        }
        if (writes.length === 2) return retry.promise;
        return Response.json({ error: "Response unavailable." }, { status: 503 });
      });
      await mount(fetch);
      await prepareSaveLockDraft();
      const raw = editorValues();
      const preSave = retainedEditorControls();
      invoke(preSave.save);
      await hooks.settle();
      const whilePending = retainedEditorControls();
      firstReady.resolve();
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      for (const label of saveLockFields) expect(editorField(label).props.disabled).not.toBe(true);
      const failedStatus = text();
      invokeEditorControls(preSave);
      invokeEditorControls(whilePending);
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      expect(text()).toBe(failedStatus);
      expect(writes).toHaveLength(1);
      invoke(button("Save changes to Apple 0"));
      invokeEditorControls(preSave);
      invokeEditorControls(whilePending);
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[0]?.url).toBe(
        `/api/diary/entries/${entry(0).id}?date=2026-08-15&profileTimeZonePrecondition=v1`,
      );
      expect(writes[0]?.body).toBe(
        JSON.stringify({
          portion: { kind: "serving", servingId: "303", amount: "2.125000" },
          mealSlot: "dinner",
          note: "  Keep this exact draft\nincluding spacing  ",
          occurredAt: "2026-08-15T14:45:00.000Z",
        }),
      );
      expect(writes[0]?.headers["if-match"]).toBe('"3"');
      expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(writes[0]?.headers["idempotency-key"]).toBeTruthy();
      expect(button("Save changes to Apple 0").props.disabled).toBe(true);
      expect(button("Edit Apple 1").props.disabled).toBe(true);
      retry.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      await click("Save changes to Apple 0");
      expect(writes).toHaveLength(3);
      expect(writes[2]).toEqual(writes[0]);
    },
  );

  it("allows fresh editing, Clear, Cancel and Open after failure while old controls stay inert", async () => {
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Response.json({ error: "Response unavailable." }, { status: 503 })
        : base(url, init),
    );
    await mount(fetch);
    await prepareSaveLockDraft();
    const old = retainedEditorControls();
    await click("Save changes to Apple 0");
    const requests = fetch.mock.calls.length;
    await changeEditorField("Quantity", "3.500000");
    await changeEditorField("Meal", "lunch");
    await changeEditorField("Local date", "2026-08-16");
    await changeEditorField("Local time", "17:01");
    await changeEditorField("Private note", "A fresh draft");
    const raw = editorValues();
    invokeEditorControls(old);
    await hooks.settle();
    expect(editorValues()).toEqual(raw);
    await click("Clear note field for Apple 0");
    expect(editorField("Private note").props.value).toBe("");
    await click("Cancel editing Apple 0");
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    await click("Edit Apple 1");
    expect(editorField("Private note").props.value).toBe("Exact private note 1");
    expect(fetch.mock.calls).toHaveLength(requests);
  });

  it("does not let a superseded failed save unlock or replace the newer pending editor", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(captureEditorSave(url, init));
        return writes.length === 1 ? first.promise : second.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    await prepareSaveLockDraft();
    const old = retainedEditorControls();
    invoke(old.save);
    await hooks.settle();
    await visitDiaryDate("2026-08-16");
    await visitDiaryDate("2026-08-15");
    await prepareSaveLockDraft();
    await changeEditorField("Quantity", "4.000001");
    const raw = editorValues();
    invoke(button("Save changes to Apple 0"));
    await hooks.settle();
    const pendingStatus = text();
    const requests = fetch.mock.calls.length;
    first.resolve(Response.json({ error: "Old response unavailable." }, { status: 503 }));
    await hooks.settle();
    invokeEditorControls(old);
    await hooks.settle();
    expect(editorValues()).toEqual(raw);
    expect(text()).toBe(pendingStatus);
    expect(button("Save changes to Apple 0").props.disabled).toBe(true);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
    second.resolve(Response.json({ error: "Current response unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(editorValues()).toEqual(raw);
    expect(button("Save changes to Apple 0").props.disabled).toBe(false);
  });

  it("keeps a locked diary entry unavailable even when its disabled Edit callback is invoked", async () => {
    const locked = page();
    locked.data.status = "locked";
    const fetch = await mount(fetcher(locked));
    const requests = fetch.mock.calls.length;
    const edit = button("Edit Apple 0");
    expect(edit.props.disabled).toBe(true);
    invoke(edit);
    await hooks.settle();
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
  });
});

describe("Diary session recovery", () => {
  for (const view of ["diary", "overview"] as const) {
    for (const dateKind of ["explicit", "absent", "invalid"] as const) {
      it.each(["503", "network", "malformed"] as const)(
        `recovers ${view} with ${dateKind} date after initial %s without reading an unverified day`,
        async (failure) => {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-08-16T01:30:00.000Z"));
          route.date =
            dateKind === "explicit" ? "2026-08-14" : dateKind === "invalid" ? "2026-02-30" : null;
          let healthy = false;
          const base = fetcher();
          const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === "/api/auth/me" && !healthy) {
              if (failure === "network") throw new Error("Connection unavailable.");
              if (failure === "malformed") return Response.json({ data: {} });
              return Response.json({ error: "Session unavailable." }, { status: 503 });
            }
            return base(url, init);
          });
          await mount(fetch, view);
          expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(0);
          expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
          expect(text()).not.toContain("Apple 0");
          expect(text()).not.toContain("No entries");
          expect(button("Retry session").props.disabled).not.toBe(true);
          healthy = true;
          vi.setSystemTime(new Date("2026-08-17T01:30:00.000Z"));
          await click("Retry session");
          const expectedDate = dateKind === "explicit" ? "2026-08-14" : "2026-08-16";
          expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
          const dayReads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"));
          expect(dayReads).toHaveLength(1);
          expect(
            new URL(String(dayReads[0]?.[0]), "https://app.example.test").searchParams.get("date"),
          ).toBe(expectedDate);
          expect(field("Local date").props.value).toBe(expectedDate);
          expect(
            elements().some((node) => node.type === "button" && text(node) === "Retry session"),
          ).toBe(false);
          if (view === "overview") {
            const summary = elements().find((node) => node.type === CalmOverview);
            expect(summary?.props.day).toMatchObject({ localDate: expectedDate });
            expect(summary?.props.totalEntries).toBe(1);
          } else expect(text()).toContain("Apple 2");
        },
      );
    }
  }
});

describe("Diary session retry lifecycle", () => {
  it("keeps repeated failures retryable and rejects duplicate and obsolete retry callbacks", async () => {
    const pending = deferred<Response>();
    let authCalls = 0;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") {
        authCalls += 1;
        if (authCalls === 1) return Response.json({}, { status: 503 });
        if (authCalls === 2) return pending.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    const old = button("Retry session");
    invoke(old);
    invoke(old);
    await hooks.settle();
    expect(authCalls).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(0);
    pending.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    expect(button("Retry session").props.disabled).not.toBe(true);
    invoke(old);
    await hooks.settle();
    expect(authCalls).toBe(2);
    await click("Retry session");
    expect(authCalls).toBe(3);
    expect(text()).toContain("Apple 0");
    const count = fetch.mock.calls.length;
    invoke(old);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it.each(["success", "error", "401", "JSON"] as const)(
    "rejects an old %s response after a route change before effects and loads only the latest day",
    async (outcome) => {
      const oldResponse = deferred<Response>();
      const oldJson = deferred<unknown>();
      const json = vi.fn(() => oldJson.promise);
      let authCalls = 0;
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          if (authCalls === 1) return Response.json({}, { status: 503 });
          if (authCalls === 2)
            return outcome === "JSON"
              ? ({ ok: true, status: 200, json } as unknown as Response)
              : oldResponse.promise;
        }
        return base(url, init);
      });
      await mount(fetch);
      const oldRetry = button("Retry session");
      invoke(oldRetry);
      await hooks.settle();
      if (outcome === "JSON") expect(json).toHaveBeenCalledOnce();
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
      invoke(oldRetry);
      expect(authCalls).toBe(2);
      if (outcome === "JSON") oldJson.resolve(session(anotherOwner));
      else
        oldResponse.resolve({
          ok: outcome === "success",
          status: outcome === "success" ? 200 : outcome === "401" ? 401 : 503,
          json: vi.fn(async () =>
            outcome === "success" ? session(anotherOwner) : { error: "Old auth error." },
          ),
        } as unknown as Response);
      hooks.render();
      await hooks.settle();
      expect(authCalls).toBe(3);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
      expect(text()).not.toContain("Old auth error");
      expect(text()).toContain("Apple 2");
      const reads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"));
      expect(reads).toHaveLength(1);
      expect(reads[0]?.[0]).toContain("date=2026-08-16");
    },
  );

  it("does not let an old finally release a newer retry, including a restored route", async () => {
    const old = deferred<Response>();
    const newest = deferred<Response>();
    let authCalls = 0;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") {
        authCalls += 1;
        if (authCalls === 1 || authCalls === 3) return Response.json({}, { status: 503 });
        if (authCalls === 2) return old.promise;
        if (authCalls === 4) return newest.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    invoke(button("Retry session"));
    await hooks.settle();
    route.date = "2026-08-16";
    hooks.renderWithoutEffects();
    route.date = "2026-08-15";
    hooks.renderWithoutEffects();
    hooks.render();
    await hooks.settle();
    expect(authCalls).toBe(3);
    const currentRetry = button("Retry session");
    invoke(currentRetry);
    await hooks.settle();
    const json = vi.fn();
    old.resolve({ status: 401, ok: false, json } as unknown as Response);
    await hooks.settle();
    invoke(currentRetry);
    await hooks.settle();
    expect(authCalls).toBe(4);
    expect(json).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    newest.resolve(Response.json(session()));
    await hooks.settle();
    expect(text()).toContain("Apple 0");
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(1);
  });

  it.each(["success", "error", "401", "JSON"] as const)(
    "ignores late %s and retained retry after unmount",
    async (outcome) => {
      const pending = deferred<Response>();
      const pendingJson = deferred<unknown>();
      const json = vi.fn(() => pendingJson.promise);
      let authCalls = 0;
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          if (authCalls === 1) return Response.json({}, { status: 503 });
          return outcome === "JSON"
            ? ({ status: 200, ok: true, json } as unknown as Response)
            : pending.promise;
        }
        return base(url, init);
      });
      await mount(fetch);
      const oldRetry = button("Retry session");
      invoke(oldRetry);
      await hooks.settle();
      hooks.unmount();
      const count = fetch.mock.calls.length;
      invoke(oldRetry);
      if (outcome === "JSON") pendingJson.resolve(session());
      else
        pending.resolve({
          status: outcome === "success" ? 200 : outcome === "401" ? 401 : 503,
          ok: outcome === "success",
          json,
        } as unknown as Response);
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(count);
      expect(json).toHaveBeenCalledTimes(outcome === "JSON" ? 1 : 0);
      expect(hooks.afterClose()).toBe(0);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    },
  );

  it("handles a current401 before JSON and keeps explicit closure closed through effect replay", async () => {
    const json = vi.fn(async () => {
      throw new Error("Unauthorized body must not be consumed.");
    });
    let authCalls = 0;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") {
        authCalls += 1;
        return authCalls === 1
          ? Response.json({}, { status: 503 })
          : ({ status: 401, ok: false, json } as unknown as Response);
      }
      return base(url, init);
    });
    await mount(fetch);
    const retry = button("Retry session");
    await click("Retry session");
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(json).not.toHaveBeenCalled();
    const count = fetch.mock.calls.length;
    invoke(retry);
    hooks.replayEffects();
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
  });

  it("replays an in-progress bootstrap without letting its aborted401 close the current session", async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    let authCalls = 0;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") return ++authCalls === 1 ? old.promise : current.promise;
      return base(url, init);
    });
    await mount(fetch);
    hooks.replayEffects();
    await hooks.settle();
    expect(authCalls).toBe(2);
    const json = vi.fn();
    old.resolve({ status: 401, ok: false, json } as unknown as Response);
    await hooks.settle();
    expect(json).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    current.resolve(Response.json(session()));
    await hooks.settle();
    expect(text()).toContain("Apple 0");
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(1);
  });

  it.each(["confirmed", "503", "network"] as const)(
    "invalidates pending bootstrap on %s logout and leaves a fresh retry only when logout is unconfirmed",
    async (outcome) => {
      const old = deferred<Response>();
      let authCalls = 0;
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          if (authCalls === 1) return Response.json({}, { status: 503 });
          if (authCalls === 2) return old.promise;
        }
        if (url === "/api/auth/logout") {
          if (outcome === "network") throw new Error("Connection unavailable.");
          return new Response(null, { status: outcome === "confirmed" ? 204 : 503 });
        }
        return base(url, init);
      });
      await mount(fetch);
      const oldRetry = button("Retry session");
      invoke(oldRetry);
      await hooks.settle();
      await click("Sign out");
      const json = vi.fn(async () => session());
      old.resolve({ status: 200, ok: true, json } as unknown as Response);
      await hooks.settle();
      invoke(oldRetry);
      await hooks.settle();
      expect(json).not.toHaveBeenCalled();
      expect(authCalls).toBe(2);
      expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(0);
      if (outcome === "confirmed") {
        expect(router.replace).toHaveBeenCalledWith("/login");
        hooks.replayEffects();
        await hooks.settle();
        expect(authCalls).toBe(2);
      } else {
        expect(router.replace).not.toHaveBeenCalledWith("/login");
        expect(button("Retry session").props.disabled).not.toBe(true);
        await click("Retry session");
        expect(authCalls).toBe(3);
        expect(text()).toContain("Apple 0");
      }
    },
  );
});

describe("Diary recovery preserves day and save ownership", () => {
  it.each(["diary", "overview"] as const)(
    "retries only the failed %s day and accepts a genuinely empty result after verified auth",
    async (view) => {
      let healthy = false;
      const base = fetcher(page([], null, 0));
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/diary?") && !healthy)
          return Response.json({ error: "Day unavailable." }, { status: 503 });
        return base(url, init);
      });
      await mount(fetch, view);
      expect(text()).toContain("Day unavailable.");
      expect(text()).not.toContain("No foods logged");
      expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
      expect(
        elements().some((node) => node.type === "button" && text(node) === "Retry session"),
      ).toBe(false);
      healthy = true;
      await click("Retry");
      expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(1);
      expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(2);
      if (view === "overview")
        expect(elements().find((node) => node.type === CalmOverview)?.props.totalEntries).toBe(0);
      else expect(text()).toContain("No foods logged for this local day.");
      expect(text()).not.toContain("Day unavailable.");
    },
  );

  it("keeps a retained session retry inert during and after an ambiguous Save without rebinding its exact retry", async () => {
    const pending = deferred<Response>();
    let authCalls = 0;
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/me" && ++authCalls === 1) return Response.json({}, { status: 503 });
      if (init?.method === "PATCH") {
        writes.push(captureEditorSave(url, init));
        return writes.length === 1 ? pending.promise : Response.json({}, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const staleRetry = button("Retry session");
    await click("Retry session");
    await prepareSaveLockDraft();
    const raw = editorValues();
    invoke(button("Save changes to Apple 0"));
    await hooks.settle();
    const count = fetch.mock.calls.length;
    invoke(staleRetry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(editorValues()).toEqual(raw);
    expect(button("Save changes to Apple 0").props.disabled).toBe(true);
    pending.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    const failedStatus = text();
    invoke(staleRetry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(text()).toBe(failedStatus);
    expect(editorValues()).toEqual(raw);
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(authCalls).toBe(2);
  });

  it("repairs a failed readback after an accepted Save with GET only and keeps the accepted status distinct", async () => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    let saved: ReturnType<typeof editorSaveReceipt> | null = null;
    let repairAllowed = false;
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const request = captureEditorSave(url, init);
        writes.push(request);
        saved = editorSaveReceipt(request);
        return Response.json(saved);
      }
      if (saved && url.startsWith("/api/diary?")) {
        return repairAllowed
          ? Response.json(page([saved.data.entry, entry(1, "lunch")], null, 2, "2026-08-15", "9"))
          : Response.json({ error: "Readback unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    await prepareSaveLockDraft();
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    expect(text()).toContain(
      "The entry was saved, but fresh diary data could not be confirmed. Choose Retry.",
    );
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    repairAllowed = true;
    await click("Retry");
    expect(writes).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(3);
    expect(text(group("dinner"))).toContain("2.125000 × medium apple");
    expect(text(group("dinner"))).toContain("Keep this exact draft");
  });
});

it("rejects a retained day-only Retry after unmount without requests or state publication", async () => {
  const base = fetcher();
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith("/api/diary?")
      ? Response.json({ error: "Day unavailable." }, { status: 503 })
      : base(url, init),
  );
  await mount(fetch);
  const retry = button("Retry");
  hooks.unmount();
  const count = fetch.mock.calls.length;
  invoke(retry);
  await hooks.settle();
  expect(fetch.mock.calls).toHaveLength(count);
  expect(hooks.afterClose()).toBe(0);
});

type RecoveryOverviewProps = Parameters<typeof CalmOverview>[0] & { onReloadDay: () => void };
function recoveryOverviewProps(): RecoveryOverviewProps {
  const summary = elements().find((node) => node.type === CalmOverview);
  expect(summary).toBeDefined();
  expect(summary?.props.onReloadDay).toBeTypeOf("function");
  return summary?.props as unknown as RecoveryOverviewProps;
}
function recoveryProgress(revision = "9") {
  return {
    data: {
      localDate: "2026-08-15",
      timeZone: "America/Chicago",
      diaryRevision: revision,
      goal: null,
      energy: null,
      nutrients: [],
      notice: "General wellness estimate; not medical advice.",
    },
  };
}

describe("Dashboard saved-target day recovery", () => {
  it("offers Reload day on the actual revision error while Retry targets remains isolated", async () => {
    const onReloadDay = vi.fn();
    const fetch = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? Response.json(session()) : Response.json(recoveryProgress()),
    );
    vi.stubGlobal("fetch", fetch);
    let props: RecoveryOverviewProps = {
      day: parseDiaryPage(page()).data,
      totalEntries: 2,
      completeDayLoaded: true,
      session: parseSession(session()),
      isCurrent: () => true,
      onUnauthorized: vi.fn(),
      onReloadDay,
    };
    hooks.mount(() => CalmOverview(props));
    await hooks.settle();
    expect(text()).toContain("Your diary changed. Reload this day to see matching targets.");
    expect(button("Reload day")).toBeDefined();
    await click("Retry targets");
    expect(onReloadDay).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/goals/progress?"))).toHaveLength(
      2,
    );
    expect(
      fetch.mock.calls.every(
        ([url]) => url === "/api/auth/me" || url.startsWith("/api/goals/progress?"),
      ),
    ).toBe(true);
    await click("Reload day");
    expect(onReloadDay).toHaveBeenCalledTimes(1);
    props = { ...props, day: parseDiaryPage(page(undefined, null, 2, "2026-08-15", "9")).data };
    hooks.render();
    await hooks.settle();
    expect(text()).not.toContain("Your diary changed.");
    expect(text()).toContain("No saved goal for this day.");
    expect(elements().some((node) => node.type === "button" && text(node) === "Reload day")).toBe(
      false,
    );
  });

  it("reloads only the applied day once before paint and installs its new revision", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    let reads = 0;
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?") && ++reads > 1 ? pending.promise : base(url, init),
    );
    await mount(fetch, "overview");
    const props = recoveryOverviewProps();
    const note = elements().find((node) => node.type === DiaryDayNote);
    const otherCalls = fetch.mock.calls.filter(([url]) => !url.startsWith("/api/diary?")).length;
    props.onReloadDay();
    props.onReloadDay();
    expect(reads).toBe(2);
    await hooks.settle();
    expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
    expect(elements().find((node) => node.type === DiaryDayNote)?.props.localDate).toBe(
      note?.props.localDate,
    );
    pending.resolve(Response.json(page(undefined, null, 2, "2026-08-15", "9")));
    await hooks.settle();
    expect(recoveryOverviewProps().day.revision).toBe("9");
    expect(recoveryOverviewProps().day.localDate).toBe("2026-08-15");
    expect(fetch.mock.calls.filter(([url]) => !url.startsWith("/api/diary?"))).toHaveLength(
      otherCalls,
    );
    expect(router.replace).not.toHaveBeenCalled();
    const count = fetch.mock.calls.length;
    props.onReloadDay();
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it.each([
    "hidden",
    "pagehide",
    "unmount",
    "date",
    "route",
    "profile",
    "owner",
    "unauthorized",
  ] as const)("rejects a retained day reload after %s retirement", async (reason) => {
    const fetch = await mount(fetcher(), "overview");
    const props = recoveryOverviewProps();
    if (reason === "hidden") {
      detailLifecycle.visibility = "hidden";
      detailLifecycle.documentListeners.get("visibilitychange")?.();
    } else if (reason === "pagehide") {
      detailLifecycle.windowListeners.get("pagehide")?.();
    } else if (reason === "unmount") {
      hooks.unmount();
    } else if (reason === "date") {
      invoke(button("Next day"));
    } else if (reason === "route") {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    } else if (reason === "profile" || reason === "owner") {
      hooks.replaceVerifiedSessionBeforeEffects(
        parseSession(session(reason === "owner" ? anotherOwner : owner, defaultDiaryGroups, "2")),
      );
    } else {
      props.onUnauthorized();
    }
    const count = fetch.mock.calls.length;
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
    if (reason === "unmount") expect(hooks.afterClose()).toBe(0);
  });

  it("does not cancel pending logout and retires its callback even after ambiguous settlement", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/logout" ? pending.promise : base(url, init),
    );
    await mount(fetch, "overview");
    const props = recoveryOverviewProps();
    invoke(button("Sign out"));
    const count = fetch.mock.calls.length;
    const signal = fetch.mock.calls.find(([url]) => url === "/api/auth/logout")?.[1]?.signal;
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(signal?.aborted).not.toBe(true);
    pending.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
    recoveryOverviewProps().onReloadDay();
    await hooks.settle();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/logout")).toHaveLength(1);
  });
});

describe("Dashboard saved-target day recovery controls", () => {
  it("keeps healthy water/activity cards and the selected note mounted through day recovery", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    let reads = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/diary?") && ++reads > 1) return pending.promise;
      const common = {
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        revision: "2",
        entries: [],
        updatedAt: "2026-08-15T13:05:02.000Z",
      };
      if (url.startsWith("/api/hydration?"))
        return Response.json({ data: { ...common, totalMilliliters: 0 } });
      if (url.startsWith("/api/activities?"))
        return Response.json({ data: { ...common, totalDurationMinutes: 0 } });
      return base(url, init);
    });
    await mount(fetch, "overview");
    const cards = () =>
      elements().find((node) => "hydration" in node.props && "activity" in node.props);
    expect(cards()?.props.hydration).toEqual({ status: "empty", count: 0, total: 0 });
    expect(cards()?.props.activity).toEqual({ status: "empty", count: 0, total: 0 });
    const cardProps = cards()?.props;
    const noteKey = elements().find((node) => node.type === DiaryDayNote)?.props.localDate;
    recoveryOverviewProps().onReloadDay();
    await hooks.settle();
    expect(cards()?.props.hydration).toEqual(cardProps?.hydration);
    expect(cards()?.props.activity).toEqual(cardProps?.activity);
    expect(elements().find((node) => node.type === DiaryDayNote)?.props.localDate).toBe(noteKey);
    pending.resolve(Response.json(page(undefined, null, 2, "2026-08-15", "9")));
    await hooks.settle();
    expect(cards()?.props.hydration).toEqual(cardProps?.hydration);
    expect(cards()?.props.activity).toEqual(cardProps?.activity);
    expect(
      fetch.mock.calls.filter(
        ([url]) => url.startsWith("/api/hydration?") || url.startsWith("/api/activities?"),
      ),
    ).toHaveLength(2);
  });

  it.each(["503", "401"] as const)(
    "keeps the maintained current %s day-load outcome",
    async (status) => {
      const base = fetcher();
      let reads = 0;
      const fetch = vi.fn(async (url: string, init?: RequestInit) =>
        url.startsWith("/api/diary?") && ++reads > 1
          ? Response.json({ error: "Reload unavailable." }, { status: Number(status) })
          : base(url, init),
      );
      await mount(fetch, "overview");
      recoveryOverviewProps().onReloadDay();
      await hooks.settle();
      expect(elements().some((node) => node.type === CalmOverview)).toBe(false);
      if (status === "401") expect(router.replace).toHaveBeenCalledWith("/login");
      else {
        expect(text()).toContain("Reload unavailable.");
        expect(button("Retry")).toBeDefined();
        expect(router.replace).not.toHaveBeenCalled();
      }
    },
  );

  it("retires an old callback through hidden then visible without waiting for paint", async () => {
    const fetch = await mount(fetcher(), "overview");
    const props = recoveryOverviewProps();
    detailLifecycle.visibility = "hidden";
    detailLifecycle.documentListeners.get("visibilitychange")?.();
    detailLifecycle.visibility = "visible";
    detailLifecycle.documentListeners.get("visibilitychange")?.();
    const count = fetch.mock.calls.length;
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
    await hooks.settle();
    recoveryOverviewProps().onReloadDay();
    await hooks.settle();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(2);
  });

  it("rejects a retained overview callback after the view route changes before effects", async () => {
    const fetch = fetcher();
    let view: "overview" | "diary" = "overview";
    vi.stubGlobal("fetch", fetch);
    hooks.mount(() => DiaryClient({ view }));
    await hooks.settle();
    const props = recoveryOverviewProps();
    view = "diary";
    hooks.renderWithoutEffects();
    const count = fetch.mock.calls.length;
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it("does not interrupt a profile write started before leaving the diary", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/profile" ? pending.promise : base(url, init),
    );
    let view: "overview" | "diary" = "diary";
    vi.stubGlobal("fetch", fetch);
    hooks.mount(() => DiaryClient({ view }));
    await hooks.settle();
    await click("Customize diary groups");
    await change("Group 1 label", "Morning meal");
    const form = elements().find(
      (node) => node.type === "form" && text(node).includes("Save groups"),
    );
    if (!form) throw new Error("Missing profile form");
    invoke(form, "onSubmit", { preventDefault() {} });
    view = "overview";
    hooks.render();
    await hooks.settle();
    const props = recoveryOverviewProps();
    const count = fetch.mock.calls.length;
    expect(fetch.mock.calls.filter(([url]) => url === "/api/profile")).toHaveLength(1);
    props.onReloadDay();
    expect(fetch.mock.calls).toHaveLength(count);
    expect(fetch.mock.calls.find(([url]) => url === "/api/profile")?.[1]?.signal?.aborted).toBe(
      false,
    );
    pending.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    recoveryOverviewProps().onReloadDay();
    await hooks.settle();
    expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/profile")).toHaveLength(1);
  });

  it("keeps target-service retry local and still rejects a changed profile", async () => {
    let healthy = false;
    const onReloadDay = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return Response.json(session(owner, defaultDiaryGroups, "2"));
      return healthy ? Response.json(recoveryProgress("8")) : Response.json({}, { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    const props: RecoveryOverviewProps = {
      day: parseDiaryPage(page()).data,
      totalEntries: 2,
      completeDayLoaded: true,
      session: parseSession(session()),
      isCurrent: () => true,
      onUnauthorized: vi.fn(),
      onReloadDay,
    };
    hooks.mount(() => CalmOverview(props));
    await hooks.settle();
    expect(text()).toContain("Saved targets could not be loaded.");
    healthy = true;
    await click("Retry targets");
    expect(text()).toContain("Your profile changed. Reload this day to see saved targets.");
    expect(onReloadDay).not.toHaveBeenCalled();
    expect(
      fetch.mock.calls.every(
        ([url]) => url === "/api/auth/me" || url.startsWith("/api/goals/progress?"),
      ),
    ).toBe(true);
  });
});

describe("Diary cross-entry editor protection", () => {
  function successfulActions() {
    let entries = [entry(0), entry(1, "lunch")];
    let reads = 0;
    const writes: Array<{
      url: string;
      method: string;
      body: string | null;
      headers: Record<string, string>;
    }> = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/diary?")) {
        reads += 1;
        return Response.json(page(entries, null, entries.length, "2026-08-15", String(7 + reads)));
      }
      if (init?.method) {
        writes.push({
          url,
          method: init.method,
          body: typeof init.body === "string" ? init.body : null,
          headers: Object.fromEntries(new Headers(init.headers)),
        });
        if (init.method === "POST") {
          const receipt = repeatReceipt(captureRepeat(url, init));
          entries = [...entries, receipt.data.entry];
          return Response.json(receipt);
        }
        if (init.method === "PATCH") {
          const receipt = editorSaveReceipt(captureEditorSave(url, init));
          entries = entries.map((value) =>
            value.id === receipt.data.entry.id ? receipt.data.entry : value,
          );
          return Response.json(receipt);
        }
        if (init.method === "DELETE") {
          const original = entry(1, "lunch");
          const affectedDays = [{ localDate: "2026-08-15", revision: "9" }];
          const receipt = {
            data: {
              replayed: false,
              entry: null,
              affectedDays,
              receipt: {
                protocol: "v1",
                operationId: new Headers(init.headers).get("idempotency-key"),
                kind: "delete",
                expectedSubjects: [{ entryId: original.id, revision: "3" }],
                resultSubjects: [{ entryId: original.id, revision: "4", state: "deleted" }],
                affectedDays,
              },
            },
          };
          expect(() => parseDiaryCorrectionMutation(receipt)).not.toThrow();
          entries = entries.filter((value) => value.id !== original.id);
          return Response.json(receipt);
        }
        throw new Error(`Unexpected mutation: ${init.method}`);
      }
      return base(url, init);
    });
    return { fetch, writes, reads: () => reads };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:00.000Z"));
  });

  it.each(["Repeat Apple 1 today", "Delete Apple 1"])(
    "protects the raw draft from the ordinary other-entry %s control",
    async (action) => {
      const fixture = successfulActions();
      await mount(fixture.fetch);
      await prepareSaveLockDraft();
      await changeEditorField("Local date", "2026-08-16");
      const raw = editorValues();
      const requests = fixture.fetch.mock.calls.length;
      const control = button(action);
      // Follow the rendered control: an enabled action reaches a real accepted
      // receipt and readback on the original source, which discards the draft.
      if (control.props.disabled !== true) invoke(control);
      await hooks.settle();
      expect({
        mutationCount: fixture.writes.length,
        diaryReads: fixture.reads(),
        editorPresent: elements().some((node) => node.props.className === "entryEditor"),
      }).toEqual({ mutationCount: 0, diaryReads: 1, editorPresent: true });
      expect(editorValues()).toEqual(raw);
      expect(fixture.fetch.mock.calls).toHaveLength(requests);
      expect(button(action).props.disabled).toBe(true);
      expect(window.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(["Repeat Apple 1 today", "Delete Apple 1"])(
    "rejects the retained %s callback immediately when an editor opens",
    async (action) => {
      const fixture = successfulActions();
      await mount(fixture.fetch);
      const retained = button(action);
      const requests = fixture.fetch.mock.calls.length;
      invoke(button("Edit Apple 0"));
      invoke(retained);
      await hooks.settle();
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.fetch.mock.calls).toHaveLength(requests);
      expect(editorField("Quantity").props.value).toBe("1.250000");
      expect(window.confirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Cancel", "Repeat Apple 1 today"],
    ["Cancel", "Delete Apple 1"],
    ["Save", "Repeat Apple 1 today"],
    ["Save", "Delete Apple 1"],
  ])("allows %s followed by the normal %s action", async (close, action) => {
    const fixture = successfulActions();
    await mount(fixture.fetch);
    await prepareSaveLockDraft();
    await click(close === "Cancel" ? "Cancel editing Apple 0" : "Save changes to Apple 0");
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    const writes = fixture.writes.length;
    const reads = fixture.reads();
    await click(action);
    expect(fixture.writes).toHaveLength(writes + 1);
    expect(fixture.reads()).toBe(reads + 1);
    expect(text()).toContain(
      action.startsWith("Repeat")
        ? "Pinned entry version repeated in Lunch with fresh authoritative totals."
        : "Apple 1 deleted from Lunch and totals refreshed.",
    );
    if (close === "Save") {
      expect(text(group("dinner"))).toContain("2.125000 × medium apple");
      expect(text(group("dinner"))).toContain("Keep this exact draft");
    }
  });

  it.each(["today", "custom destination"] as const)(
    "preserves the uncertain %s repeat envelope through an intervening editor",
    async (destination) => {
      const writes: CapturedRepeat[] = [];
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.includes("/repeat?")) {
          const request = captureRepeat(url, init);
          writes.push(request);
          return writes.length === 1
            ? Response.json({ error: "The response may have been lost." }, { status: 503 })
            : Response.json(repeatReceipt(request));
        }
        return base(url, init);
      });
      await mount(fetch);
      if (destination === "custom destination") {
        await click("Repeat Apple 1 to another day or meal");
        await change("Repeat date", "2026-08-20");
        await change("Repeat meal", "dinner");
        await click("Confirm repeat destination");
      } else {
        await click("Repeat Apple 1 today");
      }
      expect(writes).toHaveLength(1);
      const label = destination === "today" ? "Repeat Apple 1 today" : "Retry repeat for Apple 1";
      const retained = button(label);
      await prepareSaveLockDraft();
      const raw = editorValues();
      const requests = fetch.mock.calls.length;
      expect(button(label).props.disabled).toBe(true);
      invoke(retained);
      invoke(button(label));
      await hooks.settle();
      expect(writes).toHaveLength(1);
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(editorValues()).toEqual(raw);
      await click("Cancel editing Apple 0");
      vi.setSystemTime(new Date("2026-08-16T19:20:00.000Z"));
      await click(label);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[1]?.headers["if-match"]).toBe('"3"');
      expect(writes[1]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(text()).toContain("Pinned entry version repeated");
    },
  );
});

const occurrenceDate = "2026-11-01";
const earlierDiaryOccurrence = "Edit diary Earlier occurrence · UTC−05:00";
const laterDiaryOccurrence = "Edit diary Later occurrence · UTC−06:00";
function repeatedMinuteEntry() {
  return {
    ...entry(0, "breakfast", occurrenceDate),
    occurredAt: "2026-11-01T07:30:45.123Z",
    localTime: "01:30:45",
  };
}
async function mountOccurrenceEditor(
  writes: ReturnType<typeof captureEditorSave>[],
  respond?: (request: ReturnType<typeof captureEditorSave>) => Promise<Response>,
) {
  route.date = occurrenceDate;
  const base = fetcher(
    page([repeatedMinuteEntry(), entry(1, "lunch", occurrenceDate)], null, 2, occurrenceDate),
  );
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const request = captureEditorSave(url, init);
      writes.push(request);
      return respond ? respond(request) : Response.json({ error: "Unavailable." }, { status: 503 });
    }
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    return base(url, init);
  });
  await mount(fetch);
  await click("Edit Apple 0");
  return fetch;
}

describe("Diary repeated correction time", () => {
  it("requires a deliberate occurrence before dispatching a changed repeated minute", async () => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await changeEditorField("Local time", "01:31");
    const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
    vi.stubGlobal("crypto", { randomUUID: allocate });
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(0);
    expect(allocate).not.toHaveBeenCalled();
    expect(text()).toContain("Choose an occurrence for this repeated local time before saving.");
    expect(editorField("Local time").props.value).toBe("01:31");
  });

  it.each([
    [earlierDiaryOccurrence, "2026-11-01T06:31:00.000Z"],
    [laterDiaryOccurrence, "2026-11-01T07:31:00.000Z"],
  ])("sends the exact changed-minute choice from %s", async (label, instant) => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await changeEditorField("Local time", "01:31");
    await click(label);
    expect(button(label).props["aria-pressed"]).toBe(true);
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "").occurredAt).toBe(instant);
    expect(writes[0]?.url).toContain("profileTimeZonePrecondition=v1");
    expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
  });

  it.each([
    [earlierDiaryOccurrence, "2026-11-01T06:30:00.000Z"],
    [laterDiaryOccurrence, "2026-11-01T07:30:00.000Z"],
  ])("applies the timezone contract to explicit same-minute %s", async (label, instant) => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes, async (request) =>
      Response.json(editorSaveReceipt(request, repeatedMinuteEntry())),
    );
    expect(text()).toContain("seconds become zero");
    await click(label);
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "").occurredAt).toBe(instant);
    expect(writes[0]?.url).toBe(
      `/api/diary/entries/${entry(0).id}?date=${occurrenceDate}&profileTimeZonePrecondition=v1`,
    );
    expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
    expect(text()).toContain("Diary entry saved in Breakfast with fresh totals.");
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
  });

  it("keeps the precise second occurrence when only quantity and note change", async () => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await changeEditorField("Quantity", "2.500000");
    await changeEditorField("Private note", "  exact note  ");
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "")).not.toHaveProperty("occurredAt");
    expect(writes[0]?.url).not.toContain("profileTimeZonePrecondition");
    expect(writes[0]?.headers).not.toHaveProperty("x-expected-profile-time-zone");
    expect(repeatedMinuteEntry().occurredAt).toBe("2026-11-01T07:30:45.123Z");
  });

  it.each(["Local date", "Local time"])(
    "clears the choice on a real %s change and rejects its held control",
    async (fieldName) => {
      const writes: ReturnType<typeof captureEditorSave>[] = [];
      await mountOccurrenceEditor(writes);
      await click(laterDiaryOccurrence);
      const oldChoice = button(earlierDiaryOccurrence);
      const nextValue = fieldName === "Local date" ? "2026-11-02" : "01:31";
      invoke(editorField(fieldName), "onChange", { target: { value: nextValue } });
      invoke(oldChoice);
      await hooks.settle();
      if (fieldName === "Local date") await changeEditorField("Local date", occurrenceDate);
      expect(button(laterDiaryOccurrence).props["aria-pressed"]).toBe(false);
      expect(button(earlierDiaryOccurrence).props["aria-pressed"]).toBe(false);
      if (fieldName === "Local time") {
        await click("Save changes to Apple 0");
        expect(writes).toHaveLength(0);
      }
    },
  );

  it("retains an occurrence across unrelated edits and identical coordinate events", async () => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await click(laterDiaryOccurrence);
    await changeEditorField("Quantity", "2.500000");
    await changeEditorField("Private note", "Kept");
    await changeEditorField("Local date", occurrenceDate);
    await changeEditorField("Local time", "01:30");
    expect(button(laterDiaryOccurrence).props["aria-pressed"]).toBe(true);
    await click("Save changes to Apple 0");
    expect(JSON.parse(writes[0]?.body ?? "").occurredAt).toBe("2026-11-01T07:30:00.000Z");
  });

  it.each([
    ["2026-03-08", "02:30", "does not exist"],
    [occurrenceDate, "25:00", "valid local date and time"],
  ])("rejects invalid or nonexistent coordinates %s %s", async (date, time, message) => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await changeEditorField("Local date", date);
    await changeEditorField("Local time", time);
    const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
    vi.stubGlobal("crypto", { randomUUID: allocate });
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(0);
    expect(allocate).not.toHaveBeenCalled();
    expect(text()).toContain(message);
  });

  it("still sends an ordinary unique minute without an occurrence choice", async () => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    await changeEditorField("Local time", "02:31");
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "").occurredAt).toBe("2026-11-01T08:31:00.000Z");
  });

  it.each(["503", "network", "malformed receipt", "mismatched receipt"])(
    "retains the exact selected request after %s and locks held choices during retry",
    async (failure) => {
      const writes: ReturnType<typeof captureEditorSave>[] = [];
      const pending = deferred<Response>();
      await mountOccurrenceEditor(writes, async (request) => {
        if (writes.length === 2) return pending.promise;
        if (failure === "network") throw new Error("Connection lost.");
        if (failure === "malformed receipt") return Response.json({ data: {} });
        if (failure === "mismatched receipt") {
          const receipt = editorSaveReceipt(request, repeatedMinuteEntry());
          receipt.data.entry.timeZone = "America/New_York";
          return Response.json(receipt);
        }
        return Response.json({ error: "Unavailable." }, { status: 503 });
      });
      await changeEditorField("Local time", "01:31");
      await click(laterDiaryOccurrence);
      const beforeSave = button(earlierDiaryOccurrence);
      await click("Save changes to Apple 0");
      expect(button(laterDiaryOccurrence).props["aria-pressed"]).toBe(true);
      const beforeRetry = button(earlierDiaryOccurrence);
      invoke(button("Save changes to Apple 0"));
      invoke(beforeSave);
      invoke(beforeRetry);
      await hooks.settle();
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(button(laterDiaryOccurrence).props["aria-pressed"]).toBe(true);
      expect(button(earlierDiaryOccurrence).props.disabled).toBe(true);
      expect(button(laterDiaryOccurrence).props.disabled).toBe(true);
      pending.resolve(Response.json({ error: "Unavailable." }, { status: 503 }));
      await hooks.settle();
      await click("Save changes to Apple 0");
      expect(writes).toHaveLength(3);
      expect(writes[2]).toEqual(writes[0]);
    },
  );

  it.each([
    "coordinates",
    "cancel-reopen",
    "another editor",
    "route-before-effects",
    "profile",
    "logout",
    "unmount",
  ])("rejects a held occurrence callback after %s", async (transition) => {
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    await mountOccurrenceEditor(writes);
    const held = button(laterDiaryOccurrence);
    if (transition === "coordinates") await changeEditorField("Local time", "01:31");
    if (transition === "cancel-reopen") {
      await click("Cancel editing Apple 0");
      await click("Edit Apple 0");
    }
    if (transition === "another editor") await click("Edit Apple 1");
    if (transition === "route-before-effects") {
      route.date = "2026-11-02";
      hooks.renderWithoutEffects();
    }
    if (transition === "profile") {
      const next = session();
      next.data.profile.timeZone = "America/New_York";
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(next));
    }
    if (transition === "logout") await click("Sign out");
    if (transition === "unmount") hooks.unmount();
    const before = text();
    invoke(held);
    if (transition === "route-before-effects" || transition === "profile")
      hooks.renderWithoutEffects();
    else await hooks.settle();
    expect(text()).toBe(before);
    expect(writes).toHaveLength(0);
    expect(hooks.afterClose()).toBe(0);
  });
});

describe("Diary write unauthorized response ownership", () => {
  async function pendingWrite(method: "PATCH" | "DELETE") {
    const pending = deferred<Response>();
    const base = fetcher();
    const writes: { url: string; body: string | null; headers: Record<string, string> }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "DELETE") {
        writes.push({
          url,
          body: typeof init.body === "string" ? init.body : null,
          headers: Object.fromEntries(new Headers(init.headers)),
        });
        return writes.length === 1
          ? pending.promise
          : Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      return base(url, init);
    });
    await mount(fetch);
    const logoutControl = button("Sign out");
    if (method === "PATCH") {
      await prepareSaveLockDraft();
      invoke(button("Save changes to Apple 0"));
    } else invoke(button("Delete Apple 0"));
    await hooks.settle();
    expect(writes).toHaveLength(1);
    return { pending, writes, fetch, logoutControl };
  }

  function unauthorized() {
    const response = new Response(null, { status: 401 });
    const read = vi.spyOn(response, "json");
    return { response, read };
  }

  for (const method of ["PATCH", "DELETE"] as const) {
    it.each([
      "route",
      "route-return",
      "route-before-effects",
      "profile-before-effects",
      "logout",
      "unmount",
      "effect-replay",
    ] as const)(
      `keeps an obsolete ${method}401 from closing the diary after %s`,
      async (transition) => {
        const { pending, writes, fetch, logoutControl } = await pendingWrite(method);
        if (transition === "route") await visitDiaryDate("2026-08-16");
        if (transition === "route-return") {
          await visitDiaryDate("2026-08-16");
          await visitDiaryDate("2026-08-15");
          await click("Edit Apple 0");
          await changeEditorField("Private note", "New current draft");
        }
        if (transition === "route-before-effects") {
          route.date = "2026-08-16";
          hooks.renderWithoutEffects();
        }
        if (transition === "profile-before-effects") {
          const next = session();
          next.data.profile.timeZone = "America/New_York";
          hooks.replaceVerifiedSessionBeforeEffects(parseSession(next));
        }
        if (transition === "logout") {
          invoke(logoutControl);
          await hooks.settle();
        }
        if (transition === "unmount") hooks.unmount();
        if (transition === "effect-replay") {
          hooks.replayEffects();
          await hooks.settle();
        }
        const routes = router.replace.mock.calls.slice();
        const refreshes = router.refresh.mock.calls.length;
        const requests = fetch.mock.calls.length;
        const before = text();
        const { response, read } = unauthorized();
        pending.resolve(response);
        if (transition === "route-before-effects" || transition === "profile-before-effects") {
          await new Promise((resolve) => setTimeout(resolve, 0));
          hooks.renderWithoutEffects();
        } else await hooks.settle();
        expect(router.replace.mock.calls).toEqual(routes);
        expect(router.refresh).toHaveBeenCalledTimes(refreshes);
        expect(fetch).toHaveBeenCalledTimes(requests);
        expect(read).not.toHaveBeenCalled();
        expect(writes).toHaveLength(1);
        expect(hooks.afterClose()).toBe(0);
        if (transition === "route-return") {
          expect(text()).toBe(before);
          expect(editorField("Private note").props.value).toBe("New current draft");
        }
      },
    );

    it(`still closes the current ${method}401 before parsing its body`, async () => {
      const { pending, writes } = await pendingWrite(method);
      const { response, read } = unauthorized();
      pending.resolve(response);
      await hooks.settle();
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(read).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
      expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
      expect(text()).not.toContain("Exact private note 0");
    });

    it(`keeps a newer pending Save and its exact retry after an old ${method}401`, async () => {
      const old = deferred<Response>();
      const current = deferred<Response>();
      const base = fetcher();
      const writes: ReturnType<typeof captureEditorSave>[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH" || init?.method === "DELETE") {
          writes.push({
            url,
            body: typeof init.body === "string" ? init.body : "",
            headers: Object.fromEntries(new Headers(init.headers)),
          });
          if (writes.length === 1) return old.promise;
          if (writes.length === 2) return current.promise;
          return Response.json({ error: "Still unavailable." }, { status: 503 });
        }
        return base(url, init);
      });
      await mount(fetch);
      if (method === "PATCH") {
        await prepareSaveLockDraft();
        invoke(button("Save changes to Apple 0"));
      } else invoke(button("Delete Apple 0"));
      await hooks.settle();
      await visitDiaryDate("2026-08-16");
      await visitDiaryDate("2026-08-15");
      await prepareSaveLockDraft();
      await changeEditorField("Private note", "Newer exact draft");
      const raw = editorValues();
      invoke(button("Save changes to Apple 0"));
      await hooks.settle();
      expect(writes).toHaveLength(2);
      const { response, read } = unauthorized();
      old.resolve(response);
      await hooks.settle();
      expect(router.replace).not.toHaveBeenCalledWith("/login");
      expect(editorValues()).toEqual(raw);
      expect(button("Save changes to Apple 0").props.disabled).toBe(true);
      expect(read).not.toHaveBeenCalled();
      current.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(editorValues()).toEqual(raw);
      await click("Save changes to Apple 0");
      expect(writes).toHaveLength(3);
      expect(writes[2]).toEqual(writes[1]);
    });
  }
});

describe("Diary Delete admission", () => {
  async function deletionFixture() {
    const pending = deferred<Response>();
    const writes: { url: string; headers: Record<string, string> }[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        writes.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
        return writes.length === 1
          ? pending.promise
          : Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      return base(url, init);
    });
    await mount(fetch);
    return { pending, writes, fetch };
  }

  it.each(["same row", "another row"])(
    "rejects a retained %s Delete immediately while another Delete owns the lock",
    async (target) => {
      const { pending, writes } = await deletionFixture();
      const retained = button(target === "same row" ? "Delete Apple 0" : "Delete Apple 1");
      invoke(button("Delete Apple 0"));
      const uuid = vi.spyOn(crypto, "randomUUID");
      const confirmations = vi.mocked(window.confirm).mock.calls.length;
      invoke(retained);
      await hooks.settle();
      expect(writes).toHaveLength(1);
      expect(window.confirm).toHaveBeenCalledTimes(confirmations);
      expect(uuid).not.toHaveBeenCalled();
      expect(button("Delete Apple 0").props.disabled).toBe(true);
      pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
      await hooks.settle();
      await click("Delete Apple 0");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
    },
  );

  it.each([
    "route-before-effects",
    "route-ABA-before-effects",
    "profile-before-effects",
    "effect-replay",
    "hidden",
    "logout",
    "unmount",
    "settled-mutation",
  ] as const)(
    "rejects a held Delete after %s before confirmation or ID allocation",
    async (transition) => {
      const { pending, writes, fetch } = await deletionFixture();
      const retained = button("Delete Apple 0");
      if (transition === "route-before-effects" || transition === "route-ABA-before-effects") {
        route.date = "2026-08-16";
        hooks.renderWithoutEffects();
        if (transition === "route-ABA-before-effects") {
          route.date = "2026-08-15";
          hooks.renderWithoutEffects();
        }
      }
      if (transition === "profile-before-effects") {
        const next = session();
        next.data.profile.timeZone = "America/New_York";
        hooks.replaceVerifiedSessionBeforeEffects(parseSession(next));
      }
      if (transition === "effect-replay") {
        hooks.replayEffects();
        await hooks.settle();
      }
      if (transition === "hidden")
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      if (transition === "logout") await click("Sign out");
      if (transition === "unmount") hooks.unmount();
      if (transition === "settled-mutation") {
        invoke(button("Delete Apple 1"));
        pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
        await hooks.settle();
        writes.length = 0;
        vi.mocked(window.confirm).mockClear();
      }
      const uuid = vi.spyOn(crypto, "randomUUID");
      const requests = fetch.mock.calls.length;
      const before = text();
      invoke(retained);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (transition.includes("before-effects")) hooks.renderWithoutEffects();
      else await hooks.settle();
      expect(writes).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(window.confirm).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
      expect(text()).toBe(before);
      expect(hooks.afterClose()).toBe(0);
    },
  );

  it.each(["route", "editor", "profile"] as const)(
    "rechecks Delete admission when confirmation changes the %s",
    async (transition) => {
      const { writes, fetch } = await deletionFixture();
      const edit = button("Edit Apple 0");
      vi.mocked(window.confirm).mockImplementationOnce(() => {
        if (transition === "route") {
          route.date = "2026-08-16";
          hooks.renderWithoutEffects();
        }
        if (transition === "editor") invoke(edit);
        if (transition === "profile")
          hooks.replaceVerifiedSessionBeforeEffects(parseSession(session()));
        return true;
      });
      const uuid = vi.spyOn(crypto, "randomUUID");
      const requests = fetch.mock.calls.length;
      invoke(button("Delete Apple 0"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      hooks.renderWithoutEffects();
      expect(writes).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(uuid).not.toHaveBeenCalled();
      if (transition === "editor") expect(editorField("Quantity").props.value).toBe("1.250000");
    },
  );

  it("keeps an ordinary cancelled Delete free of writes and operation IDs", async () => {
    const { writes } = await deletionFixture();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const uuid = vi.spyOn(crypto, "randomUUID");
    await click("Delete Apple 0");
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete Apple 0, 1.250000 × medium apple, from Breakfast on 2026-08-15 at 08:30:00 GMT-05:00 in America/Chicago?",
    );
    expect(writes).toHaveLength(0);
    expect(uuid).not.toHaveBeenCalled();
    expect(button("Delete Apple 0").props.disabled).toBe(false);
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects the disabled Delete on a locked day before confirmation", async () => {
    const fixture = page();
    fixture.data.status = "locked";
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    const uuid = vi.spyOn(crypto, "randomUUID");
    expect(button("Delete Apple 0").props.disabled).toBe(true);
    invoke(button("Delete Apple 0"));
    await hooks.settle();
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
  });

  it("allows a current held Delete after cancelling an unchanged editor", async () => {
    const { pending, writes } = await deletionFixture();
    const retained = button("Delete Apple 0");
    await click("Edit Apple 0");
    await click("Cancel editing Apple 0");
    invoke(retained);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe(`/api/diary/entries/${entry(0).id}?date=2026-08-15`);
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
    expect(writes[0]?.headers.accept).toBe("application/json");
    expect(writes[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    pending.resolve(Response.json({ error: "Response unavailable." }, { status: 503 }));
    await hooks.settle();
  });
});

function recordedDiaryTimes() {
  return elements().filter((node) => node.type === "time");
}
function recordedDiaryEntry(
  number: number,
  occurredAt: string,
  timeZone: string,
  localTime: string,
) {
  return { ...entry(number, "breakfast", "2026-11-01"), occurredAt, timeZone, localTime };
}
describe("Diary saved clock precision", () => {
  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00"],
    ["2026-11-01T12:30:45.000Z", "UTC", "12:30:45 GMT+00:00"],
  ])("shows saved %s in %s with its offset", async (instant, zone, clock) => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
    const fixture = page([saved], null, 1, "2026-11-01"),
      original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    expect(text()).toContain("Apple 0");
    expect(recordedDiaryTimes()).toHaveLength(1);
    expect(recordedDiaryTimes()[0]?.props.dateTime).toBe(instant);
    expect(text(recordedDiaryTimes()[0])).toBe(clock);
    expect(text(group("breakfast"))).toContain(zone);
    hooks.render();
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });
  it("distinguishes simultaneous loaded Earlier and Later rows with the same local minute", async () => {
    route.date = "2026-11-01";
    const early = recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00");
    const late = recordedDiaryEntry(1, "2026-11-01T07:30:00.000Z", "America/Chicago", "01:30:00");
    await mount(fetcher(page([early, late], null, 2, "2026-11-01")));
    expect(text()).toContain("Apple 0");
    expect(text()).toContain("Apple 1");
    expect(recordedDiaryTimes().map((node) => node.props.dateTime)).toEqual([
      early.occurredAt,
      late.occurredAt,
    ]);
    expect(recordedDiaryTimes().map(text)).toEqual(["01:30:00 GMT-05:00", "01:30:00 GMT-06:00"]);
  });
  it("keeps private-food and recipe snapshot instants and zones without changing diary data", async () => {
    route.date = "2026-11-01";
    const privateFood = {
      ...recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00"),
      source: null,
      foodProvenance: {
        kind: "private_custom",
        customFoodId: "b8a7c76f-3c1d-445c-9160-152e57b29e42",
        customFoodVersionNumber: 3,
      },
    };
    const { foodProvenance: _provenance, ...recipeBase } = recordedDiaryEntry(
      1,
      "2026-11-01T07:30:00.000Z",
      "America/Chicago",
      "01:30:00",
    );
    const recipe = {
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
    const base = page([], null, 0, "2026-11-01");
    const fixture = {
      ...base,
      data: { ...base.data, entries: [privateFood, recipe] },
      page: { nextCursor: null, totalEntries: 2 },
    };
    const parsed = parseDiaryPage(fixture),
      original = JSON.stringify(fixture),
      baseFetch = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/diary?")
        ? Promise.resolve(Response.json(fixture))
        : baseFetch(url, init),
    );
    await mount(fetch);
    const requests = fetch.mock.calls.length;
    expect(text()).toContain("Apple 0");
    expect(text()).toContain("Saved stew");
    expect(recordedDiaryTimes().map((node) => node.props.dateTime)).toEqual(
      parsed.data.entries.map((entry) => entry.occurredAt),
    );
    expect(recordedDiaryTimes().map(text)).toEqual(["01:30:00 GMT-05:00", "01:30:00 GMT-06:00"]);
    hooks.render();
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary saved-time nutrient control names", () => {
  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00"],
  ])("names the nutrient control and section with saved %s in %s", async (instant, zone, clock) => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
    const fixture = page([saved], null, 1, "2026-11-01");
    const parsed = parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    const context = `Apple 0, 1.250000 × medium apple at ${clock} in ${zone}`;
    expect(text()).toContain("Apple 0");
    expect(nutrientControl(0).props["aria-label"]).toBe(`Show nutrients for ${context}`);
    expect(nutrientControl(0).props["aria-controls"]).toBe(`entry-nutrients-${saved.id}`);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
    expect(
      elements().filter(
        (node) =>
          node.type === "section" && node.props["aria-label"] === `Logged nutrients for ${context}`,
      ),
    ).toHaveLength(1);
    await toggleNutrients(0);
    expect(nutrientControl(0).props["aria-label"]).toBe(`Hide nutrients for ${context}`);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(0).props["aria-controls"]).toBe(nutrientDetail(0)?.props.id);
    expect(
      elements().filter(
        (node) =>
          node.type === "section" && node.props["aria-label"] === `Logged nutrients for ${context}`,
      ),
    ).toHaveLength(1);
    expect(detailsRows(0)).toEqual(
      parsed.data.entries[0]?.nutrients.flatMap((row) => {
        const display = nutrientDisplay(row);
        return [`${row.name} (${row.unit})`, `${display.amount}${display.qualification}`];
      }),
    );
    await toggleNutrients(0);
    expect(nutrientControl(0).props["aria-label"]).toBe(`Show nutrients for ${context}`);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("distinguishes duplicate nutrient controls for Earlier and Later without linking their state", async () => {
    route.date = "2026-11-01";
    const sameName = { name: "Same food", brandName: null };
    const early = {
      ...recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const late = {
      ...recordedDiaryEntry(1, "2026-11-01T07:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const fixture = page([early, late], null, 2, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    const contexts = ["GMT-05:00", "GMT-06:00"].map(
      (offset) => `Same food, 1.250000 × medium apple at 01:30:00 ${offset} in America/Chicago`,
    );
    expect(text(group("breakfast"))).toContain("Same food");
    expect([0, 1].map((number) => nutrientControl(number).props["aria-label"])).toEqual(
      contexts.map((context) => `Show nutrients for ${context}`),
    );
    for (const context of contexts) {
      expect(
        elements().filter(
          (node) =>
            node.type === "section" &&
            node.props["aria-label"] === `Logged nutrients for ${context}`,
        ),
      ).toHaveLength(1);
    }
    await toggleNutrients(0);
    expect(nutrientControl(0).props["aria-label"]).toBe(`Hide nutrients for ${contexts[0]}`);
    expect(nutrientControl(1).props["aria-label"]).toBe(`Show nutrients for ${contexts[1]}`);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(true);
    expect(nutrientControl(1).props["aria-expanded"]).toBe(false);
    expect(nutrientControl(0).props["aria-controls"]).toBe(`entry-nutrients-${early.id}`);
    expect(nutrientControl(1).props["aria-controls"]).toBe(`entry-nutrients-${late.id}`);
    await toggleNutrients(1);
    await toggleNutrients(0);
    expect(nutrientControl(0).props["aria-expanded"]).toBe(false);
    expect(nutrientControl(1).props["aria-expanded"]).toBe(true);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary Repeat today actual instant", () => {
  it.each([
    ["Earlier", "2026-11-01T06:30:45.123Z", "America/Chicago", "2026-11-01"],
    ["Later", "2026-11-01T07:30:45.456Z", "America/Chicago", "2026-11-01"],
    ["half-hour Later", "2026-04-04T15:15:45.789Z", "Australia/Lord_Howe", "2026-04-05"],
    ["profile-local midnight", "2026-11-01T15:00:00.001Z", "Asia/Tokyo", "2026-11-02"],
  ])(
    "uses the full click instant at %s and a fresh instant for a later action",
    async (_case, instant, zone, targetDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(instant));
      const verified = session();
      verified.data.profile.timeZone = zone;
      const fixture = page([entry(0)]);
      fixture.data.timeZone = zone;
      const original = JSON.stringify(fixture);
      const writes: CapturedRepeat[] = [];
      const base = fetcher(fixture);
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return Response.json(verified);
        if (init?.method === "POST" && url.includes("/repeat?")) {
          const request = captureRepeat(url, init);
          writes.push(request);
          return Response.json(repeatReceipt(request));
        }
        return base(url, init);
      });
      await mount(fetch);
      expect(text()).toContain("Apple 0");
      const initialReads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?")).length;
      await click("Repeat Apple 0 today");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toBe(JSON.stringify({ occurredAt: instant, mealSlot: "breakfast" }));
      expect(writes[0]?.headers["x-expected-profile-time-zone"]).toBe(zone);
      expect(writes[0]?.headers["if-match"]).toBe('"3"');
      expect(writes[0]?.url).toBe(
        `/api/diary/entries/${entry(0).id}/repeat?date=2026-08-15&profileTimeZonePrecondition=v1`,
      );
      expect(text()).toContain(`Pinned entry version repeated in Breakfast for ${targetDate}.`);
      const nextInstant = new Date(Date.parse(instant) + 500).toISOString();
      vi.setSystemTime(new Date(nextInstant));
      await click("Repeat Apple 0 today");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toBe(
        JSON.stringify({ occurredAt: nextInstant, mealSlot: "breakfast" }),
      );
      expect(writes[1]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
      expect(writes[1]?.url).toBe(writes[0]?.url);
      expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?")).length).toBe(
        initialReads,
      );
      expect(JSON.stringify(fixture)).toBe(original);
    },
  );

  it("keeps an uncertain Earlier instant across Later and a local-day boundary, then starts a fresh repeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const earlier = "2026-11-01T06:30:45.123Z";
    vi.setSystemTime(new Date(earlier));
    const writes: CapturedRepeat[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        const request = captureRepeat(url, init);
        writes.push(request);
        return writes.length < 3
          ? Response.json({ error: "Response unavailable." }, { status: 503 })
          : Response.json(repeatReceipt(request));
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe(JSON.stringify({ occurredAt: earlier, mealSlot: "breakfast" }));
    expect(text()).toContain("same operation for 2026-11-01 safely.");
    vi.setSystemTime(new Date("2026-11-01T07:30:45.987Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    const tomorrow = "2026-11-02T06:00:00.789Z";
    vi.setSystemTime(new Date(tomorrow));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual(writes[0]);
    expect(text()).toContain("Pinned entry version repeated in Breakfast for 2026-11-01.");
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(4);
    expect(writes[3]?.body).toBe(JSON.stringify({ occurredAt: tomorrow, mealSlot: "breakfast" }));
    expect(writes[3]?.headers["idempotency-key"]).not.toBe(writes[0]?.headers["idempotency-key"]);
    expect(text()).toContain("Pinned entry version repeated in Breakfast for 2026-11-02.");
  });
});

describe("Diary saved-time More disclosure names", () => {
  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00"],
  ])("identifies unopened More actions by saved %s in %s", async (instant, zone, clock) => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
    const fixture = page([saved], null, 1, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    expect(text()).toContain("Apple 0");
    const disclosures = elements().filter(
      (node) => node.type === "details" && node.props.className === "ledgerMore",
    );
    expect(disclosures).toHaveLength(1);
    const summary = elements(disclosures[0]).find((node) => node.type === "summary");
    expect(summary?.props["aria-label"]).toBe(
      `More actions and details for Apple 0, 1.250000 × medium apple at ${clock} in ${zone}`,
    );
    expect(text(summary)).toBe("More");
    expect(disclosures[0]?.props.open).toBeUndefined();
    hooks.render();
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps duplicate Earlier and Later disclosures attached to their own repeat destination", async () => {
    route.date = "2026-11-01";
    const sameName = { name: "Same food", brandName: null };
    const early = {
      ...recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const late = {
      ...recordedDiaryEntry(1, "2026-11-01T07:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const fixture = page([early, late], null, 2, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    const disclosures = () =>
      elements().filter((node) => node.type === "details" && node.props.className === "ledgerMore");
    const names = () =>
      disclosures().map(
        (detail) => elements(detail).find((node) => node.type === "summary")?.props["aria-label"],
      );
    const expected = ["GMT-05:00", "GMT-06:00"].map(
      (offset) =>
        `More actions and details for Same food, 1.250000 × medium apple at 01:30:00 ${offset} in America/Chicago`,
    );
    expect(disclosures()).toHaveLength(2);
    expect(names()).toEqual(expected);
    const laterAction = elements(disclosures()[1]).find(
      (node) =>
        node.type === "button" &&
        node.props["aria-label"] === "Repeat Same food to another day or meal",
    );
    expect(laterAction).toBeDefined();
    if (!laterAction) throw new Error("Missing Later repeat action");
    invoke(laterAction);
    await hooks.settle();
    expect(disclosures().map((node) => node.props.open)).toEqual([undefined, true]);
    expect(names()).toEqual(expected);
    expect(
      elements(disclosures()[0]).some(
        (node) =>
          node.type === "section" &&
          node.props["aria-label"] === "Repeat destination for Same food",
      ),
    ).toBe(false);
    expect(
      elements(disclosures()[1]).some(
        (node) =>
          node.type === "section" &&
          node.props["aria-label"] === "Repeat destination for Same food",
      ),
    ).toBe(true);
    await click("Cancel repeat destination");
    expect(disclosures().map((node) => node.props.open)).toEqual([undefined, undefined]);
    expect(names()).toEqual(expected);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary deletion saved context", () => {
  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00", "1.250000"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00", "2.500000"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00", "1.250000"],
  ])(
    "confirms saved %s in %s before allocating a deletion",
    async (instant, zone, clock, amount) => {
      route.date = "2026-11-01";
      const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
      saved.portion.amount = amount;
      const fixture = page([saved], null, 1, "2026-11-01");
      parseDiaryPage(fixture);
      const original = JSON.stringify(fixture);
      const fetch = await mount(fetcher(fixture));
      const requests = fetch.mock.calls.length;
      expect(text()).toContain("Apple 0");
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      const uuid = vi.spyOn(crypto, "randomUUID");
      await click("Delete Apple 0");
      expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
        `Delete Apple 0, ${amount} × medium apple, from Breakfast on 2026-11-01 at ${clock} in ${zone}?`,
      );
      expect(uuid).not.toHaveBeenCalled();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(button("Delete Apple 0").props.disabled).toBe(false);
      expect(JSON.stringify(fixture)).toBe(original);
      uuid.mockRestore();
    },
  );

  it("distinguishes duplicate Earlier and Later confirmations and keeps the selected retry exact", async () => {
    route.date = "2026-11-01";
    const sameName = { name: "Same food", brandName: null };
    const early = {
      ...recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const late = {
      ...recordedDiaryEntry(1, "2026-11-01T07:30:00.000Z", "America/Chicago", "01:30:00"),
      food: sameName,
    };
    const fixture = page([early, late], null, 2, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const writes: { url: string; headers: Record<string, string> }[] = [];
    const base = fetcher(fixture);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        writes.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
        return Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const requests = fetch.mock.calls.length;
    const controls = () =>
      elements().filter(
        (node) => node.type === "button" && node.props["aria-label"] === "Delete Same food",
      );
    const prompts = ["GMT-05:00", "GMT-06:00"].map(
      (offset) =>
        `Delete Same food, 1.250000 × medium apple, from Breakfast on 2026-11-01 at 01:30:00 ${offset} in America/Chicago?`,
    );
    const invokeControl = (index: number) => {
      const control = controls()[index];
      if (!control) throw new Error("Expected the selected deletion control.");
      invoke(control);
    };
    expect(controls()).toHaveLength(2);
    for (const index of [0, 1]) {
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      invokeControl(index);
      await hooks.settle();
      expect(window.confirm).toHaveBeenLastCalledWith(prompts[index]);
    }
    expect(writes).toHaveLength(0);
    expect(fetch.mock.calls).toHaveLength(requests);
    invokeControl(1);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe(`/api/diary/entries/${late.id}?date=2026-11-01`);
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
    expect(writes[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.confirm).toHaveBeenLastCalledWith(prompts[1]);
    invokeControl(1);
    await hooks.settle();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(window.confirm).toHaveBeenLastCalledWith(prompts[1]);
    expect(fetch.mock.calls).toHaveLength(requests + 2);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary editor saved context", () => {
  function savedContext(id: string) {
    const section = elements().find(
      (node) =>
        node.type === "section" && node.props["aria-describedby"] === `entry-edit-saved-${id}`,
    );
    if (!section) throw new Error("Missing saved entry context in the editor.");
    const summary = elements(section).find(
      (node) => node.type === "p" && node.props.id === `entry-edit-saved-${id}`,
    );
    if (!summary) throw new Error("Missing visible saved entry summary.");
    return { section, summary };
  }

  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00"],
  ])("keeps saved %s in %s visible when editing", async (instant, zone, clock) => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
    const fixture = page([saved], null, 1, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    await click("Edit Apple 0");
    const { section, summary } = savedContext(saved.id);
    expect(section.props["aria-label"]).toBe("Edit saved entry for Apple 0");
    expect(text(summary)).toBe(
      `Editing Apple 0, 1.250000 × medium apple, logged on 2026-11-01 at ${clock} in ${zone}. Unsaved changes are below.`,
    );
    const time = elements(summary).find((node) => node.type === "time");
    expect(time?.props.dateTime).toBe(instant);
    expect(text(time ?? null)).toBe(clock);
    expect(section.props["aria-live"]).toBeUndefined();
    expect(summary.props.role).toBeUndefined();
    expect(editorField("Quantity").props.value).toBe("1.250000");
    expect(fetch.mock.calls).toHaveLength(requests);
    await click("Cancel editing Apple 0");
    expect(elements().some((node) => node.props.id === `entry-edit-saved-${saved.id}`)).toBe(false);
    expect(button("Edit Apple 0").props.disabled).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps saved context through draft changes and uncertain exact retries", async () => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(
      0,
      "2026-11-01T07:30:45.123456Z",
      "America/Chicago",
      "01:30:45",
    );
    const fixture = page([saved], null, 1, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const writes: { url: string; body: string; headers: Record<string, string> }[] = [];
    const base = fetcher(fixture);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push({
          url,
          body: String(init.body),
          headers: Object.fromEntries(new Headers(init.headers)),
        });
        return Response.json({ error: "Response unavailable." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    const requests = fetch.mock.calls.length;
    await click("Edit Apple 0");
    const summary = text(savedContext(saved.id).summary);
    await changeEditorField("Quantity", "2.250000");
    await changeEditorField("Private note", "Draft note");
    expect(text(savedContext(saved.id).summary)).toBe(summary);
    await click("Save changes to Apple 0");
    expect(text(savedContext(saved.id).summary)).toBe(summary);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe(`/api/diary/entries/${saved.id}?date=2026-11-01`);
    expect(JSON.parse(writes[0]?.body ?? "null")).toEqual({
      portion: { kind: "serving", servingId: "303", amount: "2.250000" },
      mealSlot: "breakfast",
      note: "Draft note",
    });
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
    expect(writes[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    await changeEditorField("Meal", "lunch");
    await changeEditorField("Local date", "2026-11-02");
    await changeEditorField("Local time", "11:45");
    expect(text(savedContext(saved.id).summary)).toBe(summary);
    expect(editorField("Local date").props.value).toBe("2026-11-02");
    expect(editorField("Local time").props.value).toBe("11:45");
    expect(editorField("Meal").props.value).toBe("lunch");
    expect(fetch.mock.calls).toHaveLength(requests + 2);
    await click("Cancel editing Apple 0");
    expect(button("Edit Apple 0").props.disabled).toBe(false);
    expect(elements().some((node) => node.props.id === `entry-edit-saved-${saved.id}`)).toBe(false);
    expect(fetch.mock.calls).toHaveLength(requests + 2);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary logout closed-page ownership", () => {
  it.each(["unmount", "confirmed closure"] as const)(
    "ignores a retained sign-out action after %s",
    async (transition) => {
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url === "/api/auth/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : base(url, init),
      );
      await mount(fetch);
      const retained = button("Sign out");
      if (transition === "unmount") hooks.unmount();
      else await click("Sign out");
      const requests = fetch.mock.calls.length;
      const routes = router.replace.mock.calls.slice();
      const refreshes = router.refresh.mock.calls.length;
      const before = text();
      invoke(retained);
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(router.replace.mock.calls).toEqual(routes);
      expect(router.refresh).toHaveBeenCalledTimes(refreshes);
      expect(text()).toBe(before);
      expect(hooks.afterClose()).toBe(0);
    },
  );

  it.each([204, 401, 503])("ignores a pending logout %s after unmount", async (status) => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/logout" ? pending.promise : base(url, init),
    );
    await mount(fetch);
    invoke(button("Sign out"));
    await hooks.settle();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/logout")).toHaveLength(1);
    hooks.unmount();
    const requests = fetch.mock.calls.length;
    const routes = router.replace.mock.calls.slice();
    const refreshes = router.refresh.mock.calls.length;
    pending.resolve(new Response(null, { status }));
    await hooks.settle();
    expect(router.replace.mock.calls).toEqual(routes);
    expect(router.refresh).toHaveBeenCalledTimes(refreshes);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
  });

  it("retires a prior logout receipt on effect replay and lets a fresh current logout close once", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    let logouts = 0;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/auth/logout") {
        logouts += 1;
        return logouts === 1
          ? pending.promise
          : Promise.resolve(new Response(null, { status: 204 }));
      }
      return base(url, init);
    });
    await mount(fetch);
    invoke(button("Sign out"));
    await hooks.settle();
    hooks.replayEffects();
    await hooks.settle();
    expect(text()).toContain("Apple 0");
    expect(button("Sign out").props.disabled).not.toBe(true);
    const requests = fetch.mock.calls.length;
    const routes = router.replace.mock.calls.slice();
    const refreshes = router.refresh.mock.calls.length;
    pending.resolve(new Response(null, { status: 204 }));
    await hooks.settle();
    expect(router.replace.mock.calls).toEqual(routes);
    expect(router.refresh).toHaveBeenCalledTimes(refreshes);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(text()).toContain("Apple 0");
    expect(button("Sign out").props.disabled).not.toBe(true);
    await click("Sign out");
    expect(logouts).toBe(2);
    expect(router.replace).toHaveBeenLastCalledWith("/login");
    expect(router.refresh).toHaveBeenCalledTimes(refreshes + 1);
    expect(text()).not.toContain("Apple 0");
    expect(hooks.afterClose()).toBe(0);
  });
});

describe("Diary repeat saved source context", () => {
  function savedContext(id: string) {
    const section = elements().find(
      (node) =>
        node.type === "section" && node.props["aria-describedby"] === `entry-repeat-source-${id}`,
    );
    if (!section) throw new Error("Missing saved source context in Repeat destination.");
    const summary = elements(section).find(
      (node) => node.type === "p" && node.props.id === `entry-repeat-source-${id}`,
    );
    if (!summary) throw new Error("Missing visible repeat source summary.");
    return { section, summary };
  }

  it.each([
    ["2026-11-01T06:30:45.123456Z", "America/Chicago", "01:30:45 GMT-05:00"],
    ["2026-11-01T07:30:45.123Z", "America/Chicago", "01:30:45 GMT-06:00"],
    ["2026-11-01T12:30:45.000Z", "Asia/Tokyo", "21:30:45 GMT+09:00"],
  ])("keeps saved %s in %s visible through destination changes", async (instant, zone, clock) => {
    route.date = "2026-11-01";
    const saved = recordedDiaryEntry(0, instant, zone, clock.slice(0, 8));
    const fixture = page([saved], null, 1, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    await click("Repeat Apple 0 to another day or meal");
    const { section, summary } = savedContext(saved.id);
    const expected = `Repeating Apple 0, 1.250000 × medium apple, logged on 2026-11-01 at ${clock} in ${zone}. Choose the destination below.`;
    expect(section.props["aria-label"]).toBe("Repeat destination for Apple 0");
    expect(text(summary)).toBe(expected);
    const time = elements(summary).find((node) => node.type === "time");
    expect(time?.props.dateTime).toBe(instant);
    expect(text(time ?? null)).toBe(clock);
    expect(section.props["aria-live"]).toBeUndefined();
    expect(summary.props.role).toBeUndefined();
    await change("Repeat date", "2026-11-02");
    await change("Repeat meal", "lunch");
    expect(field("Repeat date").props.value).toBe("2026-11-02");
    expect(field("Repeat meal").props.value).toBe("lunch");
    expect(text(savedContext(saved.id).summary)).toBe(expected);
    expect(fetch.mock.calls).toHaveLength(requests);
    await click("Cancel repeat destination");
    expect(elements().some((node) => node.props.id === `entry-repeat-source-${saved.id}`)).toBe(
      false,
    );
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps identical Earlier and Later sources distinct when switching repeat forms", async () => {
    route.date = "2026-11-01";
    const early = {
      ...recordedDiaryEntry(0, "2026-11-01T06:30:00.000Z", "America/Chicago", "01:30:00"),
      food: { name: "Same food", brandName: null },
    };
    const late = {
      ...recordedDiaryEntry(1, "2026-11-01T07:30:00.000Z", "America/Chicago", "01:30:00"),
      food: { name: "Same food", brandName: null },
    };
    const fixture = page([early, late], null, 2, "2026-11-01");
    parseDiaryPage(fixture);
    const original = JSON.stringify(fixture);
    const fetch = await mount(fetcher(fixture));
    const requests = fetch.mock.calls.length;
    for (const [index, saved, offset] of [
      [0, early, "GMT-05:00"],
      [1, late, "GMT-06:00"],
    ] as const) {
      const actions = elements().filter(
        (node) =>
          node.type === "button" &&
          node.props["aria-label"] === "Repeat Same food to another day or meal",
      );
      expect(actions).toHaveLength(2);
      const action = actions[index];
      if (!action) throw new Error("Missing source repeat action.");
      invoke(action);
      await hooks.settle();
      const { summary } = savedContext(saved.id);
      expect(text(summary)).toBe(
        `Repeating Same food, 1.250000 × medium apple, logged on 2026-11-01 at 01:30:00 ${offset} in America/Chicago. Choose the destination below.`,
      );
      expect(elements(summary).find((node) => node.type === "time")?.props.dateTime).toBe(
        saved.occurredAt,
      );
      expect(
        elements().filter(
          (node) => node.type === "p" && String(node.props.id).startsWith("entry-repeat-source-"),
        ),
      ).toHaveLength(1);
      await click("Cancel repeat destination");
      expect(elements().some((node) => node.props.id === `entry-repeat-source-${saved.id}`)).toBe(
        false,
      );
    }
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(JSON.stringify(fixture)).toBe(original);
  });
});

describe("Diary pagination owns current page", () => {
  function firstPage(total = 21) {
    const fixture = page(
      Array.from({ length: 20 }, (_, index) => entry(index)),
      "d1.next-page",
      total,
    );
    parseDiaryPage(fixture);
    return fixture;
  }

  it.each(["unmount", "confirmed closure"] as const)(
    "ignores retained Load more after %s",
    async (transition) => {
      const base = fetcher(firstPage());
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url === "/api/auth/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : base(url, init),
      );
      await mount(fetch);
      const old = button("Load more");
      if (transition === "unmount") hooks.unmount();
      else await click("Sign out");
      const requests = fetch.mock.calls.length;
      const before = text();
      const routes = router.replace.mock.calls.slice();
      invoke(old);
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(text()).toBe(before);
      expect(router.replace.mock.calls).toEqual(routes);
      expect(hooks.afterClose()).toBe(0);
    },
  );

  it.each(["route", "owner"] as const)(
    "rejects old Load more after %s replacement before effects",
    async (transition) => {
      const fetch = await mount(fetcher(firstPage()));
      const old = button("Load more");
      if (transition === "route") {
        route.date = "2026-08-16";
        hooks.renderWithoutEffects();
      } else hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
      const requests = fetch.mock.calls.length;
      const before = text();
      invoke(old);
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(text()).toBe(before);
    },
  );

  it("retires old callbacks after failure and append while fresh cursor retries keep working", async () => {
    const base = fetcher(firstPage(41));
    let calls = 0;
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("cursor=")) {
        urls.push(url);
        calls += 1;
        if (calls === 1) return Response.json({ error: "Retry page." }, { status: 503 });
        return Response.json(
          calls === 2
            ? page(
                Array.from({ length: 20 }, (_, index) => entry(index + 20)),
                "d1.last-page",
                41,
              )
            : page([entry(40)], null, 41),
        );
      }
      return base(url, init);
    });
    await mount(fetch);
    const old = button("Load more");
    await click("Load more");
    expect(text()).toContain("Loaded entries remain available");
    invoke(old);
    await hooks.settle();
    expect(calls).toBe(1);
    const retry = button("Retry load more");
    await click("Retry load more");
    expect(text()).toContain("40 of 41 entries loaded");
    invoke(retry);
    invoke(old);
    await hooks.settle();
    expect(calls).toBe(2);
    await click("Load more");
    expect(calls).toBe(3);
    expect(urls[1]).toBe(urls[0]);
    expect(new URL(urls[2] ?? "", "https://app.example.test").searchParams.get("cursor")).toBe(
      "d1.last-page",
    );
    expect(text()).toContain("41 of 41 entries loaded");
    expect(text()).toContain("Apple 40");
  });

  it.each([200, 401])(
    "ignores pending continuation %s after owner replacement before effects",
    async (status) => {
      const pending = deferred<Response>();
      const base = fetcher(firstPage());
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url.includes("cursor=") ? pending.promise : base(url, init),
      );
      await mount(fetch);
      await click("Load more");
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
      const before = text();
      const routes = router.replace.mock.calls.slice();
      pending.resolve(
        status === 200
          ? Response.json(page([entry(20)], null, 21))
          : new Response(null, { status: 401 }),
      );
      await hooks.settle();
      expect(text()).toBe(before);
      expect(router.replace.mock.calls).toEqual(routes);
      expect(fetch.mock.calls.filter(([url]) => url.includes("cursor="))).toHaveLength(1);
    },
  );

  it("does not let retained Load more interrupt a pending correction", async () => {
    const pending = deferred<Response>();
    const base = fetcher(firstPage());
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? pending.promise : base(url, init),
    );
    await mount(fetch);
    const old = button("Load more");
    await click("Edit Apple 0");
    await changeEditorField("Quantity", "2.250000");
    await click("Save changes to Apple 0");
    const requests = fetch.mock.calls.length;
    invoke(old);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(editorField("Quantity").props.value).toBe("2.250000");
    pending.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(editorField("Quantity").props.value).toBe("2.250000");
    expect(button("Save changes to Apple 0").props.disabled).toBe(false);
  });
});

describe("Diary group save lifecycle ownership", () => {
  function settingsForm() {
    const form = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!form) throw new Error("Missing diary group form.");
    return form;
  }
  function submit(form = settingsForm()) {
    invoke(form, "onSubmit", { preventDefault() {} });
  }
  async function editGroups() {
    await click("Customize diary groups");
    await change("Group 1 label", "Morning meal");
    expect(button("Save groups").props.disabled).toBe(false);
    return settingsForm();
  }
  const groups = defaultDiaryGroups.map((group) =>
    group.mealSlot === "breakfast" ? { ...group, label: "Morning meal" } : group,
  );

  it.each(["unmount", "confirmed closure"] as const)(
    "ignores retained Save groups after %s",
    async (transition) => {
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url === "/api/auth/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : base(url, init),
      );
      await mount(fetch);
      const retained = await editGroups();
      if (transition === "unmount") hooks.unmount();
      else await click("Sign out");
      const requests = fetch.mock.calls.length;
      const routes = router.replace.mock.calls.slice();
      const before = text();
      submit(retained);
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(router.replace.mock.calls).toEqual(routes);
      expect(text()).toBe(before);
      expect(hooks.afterClose()).toBe(0);
    },
  );

  it("rejects a retained form after owner replacement before effects", async () => {
    const fetch = await mount(fetcher());
    const retained = await editGroups();
    hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    const requests = fetch.mock.calls.length;
    const before = text();
    submit(retained);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(text()).toBe(before);
  });

  it("retires an old form on effect replay while fresh settings retain exact retry preconditions", async () => {
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        if (!init) throw new Error("Missing profile request.");
        writes.push(init);
        return writes.length === 1
          ? Response.json({ error: "Try saving again." }, { status: 503 })
          : Response.json({ data: { profile: session(owner, groups, "2").data.profile } });
      }
      return base(url, init);
    });
    await mount(fetch);
    const retained = await editGroups();
    hooks.replayEffects();
    await hooks.settle();
    const requests = fetch.mock.calls.length;
    submit(retained);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(writes).toHaveLength(0);
    await change("Group 1 label", "Morning meal");
    expect(button("Save groups").props.disabled).toBe(false);
    submit();
    await hooks.settle();
    expect(text()).toContain("Try saving again.");
    expect(field("Group 1 label").props.value).toBe("Morning meal");
    expect(button("Save groups").props.disabled).toBe(false);
    submit();
    await hooks.settle();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toBe(
      JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: groups }),
    );
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
    expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
    expect(text()).toContain("Diary group names and order saved everywhere you log food.");
    expect(button("Collapse Morning meal").props["aria-expanded"]).toBe(true);
  });

  it.each([200, 401])("ignores a pending profile %s after unmount", async (status) => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/profile" ? pending.promise : base(url, init),
    );
    await mount(fetch);
    await editGroups();
    submit();
    await hooks.settle();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/profile")).toHaveLength(1);
    hooks.unmount();
    const requests = fetch.mock.calls.length;
    const routes = router.replace.mock.calls.slice();
    pending.resolve(
      status === 200
        ? Response.json({ data: { profile: session(owner, groups, "2").data.profile } })
        : new Response(null, { status }),
    );
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(router.replace.mock.calls).toEqual(routes);
    expect(hooks.afterClose()).toBe(0);
  });

  it("clears only the retired profile busy state on replay and preserves a fresh save from the late response", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    let writes = 0;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        writes += 1;
        return writes === 1
          ? pending.promise
          : Promise.resolve(
              Response.json({ data: { profile: session(owner, groups, "2").data.profile } }),
            );
      }
      return base(url, init);
    });
    await mount(fetch);
    await editGroups();
    submit();
    await hooks.settle();
    expect(writes).toBe(1);
    expect(button("Saving…").props.disabled).toBe(true);
    hooks.replayEffects();
    await hooks.settle();
    expect(field("Group 1 label").props.disabled).toBe(false);
    await change("Group 1 label", "Morning meal");
    expect(button("Save groups").props.disabled).toBe(false);
    submit();
    await hooks.settle();
    expect(writes).toBe(2);
    expect(button("Collapse Morning meal").props["aria-expanded"]).toBe(true);
    const requests = fetch.mock.calls.length;
    const before = text();
    const routes = router.replace.mock.calls.slice();
    pending.resolve(new Response(null, { status: 401 }));
    await hooks.settle();
    expect(text()).toBe(before);
    expect(router.replace.mock.calls).toEqual(routes);
    expect(fetch.mock.calls).toHaveLength(requests);
  });
});

describe("Diary meal-group draft pending save", () => {
  function form() {
    const found = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!found) throw new Error("Missing meal-group settings form.");
    return found;
  }
  function fields() {
    return elements(form())
      .filter((node) => node.type === "input")
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  function action(kind: string) {
    return kind === "rename" ? field("Group 1 label") : button(kind);
  }
  function act(kind: string, node: ElementNode) {
    if (kind === "rename") invoke(node, "onChange", { target: { value: "Changed morning" } });
    else invoke(node);
  }

  it.each(["rename", "Move group 2 up", "Move group 1 down", "Reset defaults", "Cancel"])(
    "keeps submitted groups through retained %s and permits a fresh action after failure",
    async (kind) => {
      const pending = deferred<Response>();
      const base = fetcher();
      const writes: RequestInit[] = [];
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/profile") {
          if (!init) throw new Error("Missing profile request.");
          writes.push(init);
          return writes.length === 1
            ? pending.promise
            : Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
        }
        return base(url, init);
      });
      await mount(fetch);
      await click("Customize diary groups");
      await change("Group 1 label", "Submitted morning");
      const before = fields();
      const retained = action(kind);
      expect(retained.props.disabled).toBe(false);
      invoke(form(), "onSubmit", { preventDefault() {} });
      expect(writes).toHaveLength(1);
      act(kind, retained);
      await hooks.settle();
      expect(fields()).toEqual(before);
      expect(form().props["aria-busy"]).toBe(true);
      expect(button("Saving…").props.disabled).toBe(true);
      expect(action(kind).props.disabled).toBe(true);
      expect(writes).toHaveLength(1);
      expect(text()).toContain("Saving your diary group names and order");
      pending.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(fields()).toEqual(before);
      expect(form().props["aria-busy"]).toBe(false);
      expect(button("Save groups").props.disabled).toBe(false);
      invoke(form(), "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(writes).toHaveLength(2);
      const expectedGroups = defaultDiaryGroups.map((group) =>
        group.mealSlot === "breakfast" ? { ...group, label: "Submitted morning" } : group,
      );
      expect(writes[0]?.body).toBe(
        JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: expectedGroups }),
      );
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
      expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
      expect(fields()).toEqual(before);
      const fresh = action(kind);
      expect(fresh.props.disabled).toBe(false);
      const requests = fetch.mock.calls.length;
      act(kind, fresh);
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests);
      if (kind === "Cancel") {
        expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(false);
        expect(button("Customize diary groups").props.disabled).toBe(false);
      } else if (kind === "rename") {
        expect(field("Group 1 label").props.value).toBe("Changed morning");
      } else if (kind === "Reset defaults") {
        expect(fields()).toEqual(
          defaultDiaryGroups.map((group) => ({
            id: `diary-group-${group.mealSlot}`,
            value: group.label,
          })),
        );
      } else {
        expect(fields()).toEqual([before[1], before[0], before[2], before[3]]);
      }
    },
  );
});

describe("Diary meal-group matched save confirmation", () => {
  function form() {
    const found = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!found) throw new Error("Missing meal-group form.");
    return found;
  }
  function draft() {
    return elements(form())
      .filter((node) => node.type === "input")
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  async function submit() {
    expect(button("Save groups").props.disabled).toBe(false);
    invoke(form(), "onSubmit", { preventDefault() {} });
    await hooks.settle();
  }
  const renamed = defaultDiaryGroups.map((group) =>
    group.mealSlot === "breakfast" ? { ...group, label: "Morning meal" } : group,
  );
  const reordered = moveDiaryGroup(renamed, 0, 1);

  it.each(["label", "order"] as const)(
    "rejects a parsed different %s and confirms only the matching retry",
    async (mismatch) => {
      const wrong =
        mismatch === "label"
          ? reordered.map((group) =>
              group.mealSlot === "breakfast" ? { ...group, label: "Other morning" } : group,
            )
          : renamed;
      parseSession(session(owner, wrong, "2"));
      parseSession(session(owner, reordered, "2"));
      const base = fetcher();
      const writes: RequestInit[] = [];
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/profile") {
          if (!init) throw new Error("Missing profile write.");
          writes.push(init);
          return Promise.resolve(
            Response.json({
              data: {
                profile: session(owner, writes.length === 1 ? wrong : reordered, "2").data.profile,
              },
            }),
          );
        }
        return base(url, init);
      });
      await mount(fetch);
      await click("Customize diary groups");
      await change("Group 1 label", "Morning meal");
      await click("Move group 1 down");
      const submitted = draft();
      await submit();
      expect(text()).not.toContain("Diary group names and order saved everywhere");
      expect(text()).toContain(
        "The returned diary groups did not match your changes. Your edits are still here; try saving again.",
      );
      expect(draft()).toEqual(submitted);
      expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
      expect(writes).toHaveLength(1);
      await submit();
      expect(writes).toHaveLength(2);
      expect(writes[0]?.body).toBe(
        JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: reordered }),
      );
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
      expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
      expect(text()).toContain("Diary group names and order saved everywhere you log food.");
      expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(false);
      expect(button("Collapse Morning meal").props["aria-expanded"]).toBe(true);
      expect(
        elements()
          .filter(
            (node) =>
              node.type === "section" && String(node.props["aria-labelledby"]).startsWith("meal-"),
          )
          .map((node) => node.props["aria-labelledby"]),
      ).toEqual(["meal-lunch", "meal-breakfast", "meal-dinner", "meal-snacks"]);
    },
  );

  it("accepts normalized labels matching the prepared request rather than raw draft text", async () => {
    const normalized = defaultDiaryGroups.map((group) =>
      group.mealSlot === "breakfast" ? { ...group, label: "Morning" } : group,
    );
    parseSession(session(owner, normalized, "2"));
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        if (!init) throw new Error("Missing profile write.");
        writes.push(init);
        return Promise.resolve(
          Response.json({ data: { profile: session(owner, normalized, "2").data.profile } }),
        );
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Customize diary groups");
    await change("Group 1 label", "  Ｍorning  ");
    expect(field("Group 1 label").props.value).toBe("  Ｍorning  ");
    await submit();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe(
      JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: normalized }),
    );
    expect(text()).toContain("Diary group names and order saved everywhere you log food.");
    expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(false);
    expect(button("Collapse Morning").props["aria-expanded"]).toBe(true);
  });

  it("keeps normal412 recovery and uses the refreshed revision on the next explicit save", async () => {
    const freshGroups = defaultDiaryGroups.map((group) =>
      group.mealSlot === "dinner" ? { ...group, label: "Evening" } : group,
    );
    const nextGroups = freshGroups.map((group) =>
      group.mealSlot === "breakfast" ? { ...group, label: "Fresh morning" } : group,
    );
    parseSession(session(owner, freshGroups, "2"));
    parseSession(session(owner, nextGroups, "3"));
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        if (!init) throw new Error("Missing profile write.");
        writes.push(init);
        return Promise.resolve(
          writes.length === 2
            ? Response.json({}, { status: 412 })
            : Response.json({
                data: {
                  profile: session(
                    owner,
                    writes.length === 1 ? freshGroups : nextGroups,
                    writes.length === 1 ? "2" : "3",
                  ).data.profile,
                },
              }),
        );
      }
      if (url === "/api/auth/me" && writes.length === 2)
        return Promise.resolve(Response.json(session(owner, freshGroups, "2")));
      return base(url, init);
    });
    await mount(fetch);
    await click("Customize diary groups");
    await change("Group 1 label", "Morning meal");
    await submit();
    expect(field("Group 1 label").props.value).toBe("Morning meal");
    expect(text()).not.toContain("Diary group names and order saved everywhere");
    await submit();
    expect(text()).toContain(
      "Your profile changed elsewhere. Fresh diary group settings were loaded.",
    );
    expect(field("Group 1 label").props.value).toBe("Breakfast");
    expect(field("Group 3 label").props.value).toBe("Evening");
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
    await change("Group 1 label", "Fresh morning");
    await submit();
    expect(writes).toHaveLength(3);
    expect(new Headers(writes[2]?.headers).get("if-match")).toBe('"2"');
    expect(writes[2]?.body).toBe(
      JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: nextGroups }),
    );
    expect(text()).toContain("Diary group names and order saved everywhere you log food.");
    expect(button("Collapse Fresh morning").props["aria-expanded"]).toBe(true);
  });
});

describe("Diary meal-group busy admission", () => {
  function form() {
    const found = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!found) throw new Error("Missing meal-group form.");
    return found;
  }
  function fields() {
    return elements(form())
      .filter((node) => node.type === "input")
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  const submittedGroups = defaultDiaryGroups.map((group) =>
    group.mealSlot === "breakfast" ? { ...group, label: "Submitted morning" } : group,
  );

  it.each(["open", "close"] as const)(
    "retains the submitted draft through an old %s launcher during profile save",
    async (kind) => {
      const pending = deferred<Response>();
      const base = fetcher();
      const writes: RequestInit[] = [];
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/profile") {
          if (!init) throw new Error("Missing profile request.");
          writes.push(init);
          return writes.length === 1
            ? pending.promise
            : Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
        }
        return base(url, init);
      });
      await mount(fetch);
      const opening = button("Customize diary groups");
      await click("Customize diary groups");
      await change("Group 1 label", "Submitted morning");
      const retained = kind === "open" ? opening : button("Close diary group settings");
      const before = fields();
      invoke(form(), "onSubmit", { preventDefault() {} });
      expect(writes).toHaveLength(1);
      invoke(retained);
      await hooks.settle();
      expect(fields()).toEqual(before);
      expect(form().props["aria-busy"]).toBe(true);
      expect(button("Close diary group settings").props.disabled).toBe(true);
      expect(writes).toHaveLength(1);
      pending.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(fields()).toEqual(before);
      invoke(form(), "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(writes).toHaveLength(2);
      expect(writes[0]?.body).toBe(
        JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: submittedGroups }),
      );
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
      expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
      expect(button("Close diary group settings").props.disabled).toBe(false);
      const requests = fetch.mock.calls.length;
      await click("Close diary group settings");
      expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(false);
      await click("Customize diary groups");
      expect(field("Group 1 label").props.value).toBe("Breakfast");
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );

  it.each(["open", "close"] as const)(
    "ignores an old %s launcher during a pending diary deletion",
    async (kind) => {
      const pending = deferred<Response>();
      const base = fetcher();
      const writes: RequestInit[] = [];
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          writes.push(init);
          return writes.length === 1
            ? pending.promise
            : Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
        }
        return base(url, init);
      });
      await mount(fetch);
      if (kind === "close") {
        await click("Customize diary groups");
        await change("Group 1 label", "Submitted morning");
      }
      const label = kind === "open" ? "Customize diary groups" : "Close diary group settings";
      const retained = button(label);
      const before = kind === "close" ? fields() : null;
      invoke(button("Delete Apple 0"));
      expect(writes).toHaveLength(1);
      invoke(retained);
      await hooks.settle();
      expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(
        kind === "close",
      );
      if (before) expect(fields()).toEqual(before);
      expect(button(label).props.disabled).toBe(true);
      pending.resolve(Response.json({ error: "Delete unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(button(label).props.disabled).toBe(false);
      if (before) expect(fields()).toEqual(before);
      await click("Delete Apple 0");
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(Object.fromEntries(new Headers(writes[1]?.headers))).toEqual(
        Object.fromEntries(new Headers(writes[0]?.headers)),
      );
      const requests = fetch.mock.calls.length;
      await click(label);
      expect(elements().some((node) => node.props.id === "diary-group-settings")).toBe(
        kind === "open",
      );
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );

  it("keeps a retained meal-group submit from overlapping an active diary deletion", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const profileWrites: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return pending.promise;
      if (url === "/api/profile") {
        if (!init) throw new Error("Missing profile request.");
        profileWrites.push(init);
        return Promise.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
      }
      return base(url, init);
    });
    await mount(fetch);
    await click("Customize diary groups");
    await change("Group 1 label", "Submitted morning");
    const retained = form();
    const before = fields();
    invoke(button("Delete Apple 0"));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    invoke(retained, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(profileWrites).toHaveLength(0);
    expect(fields()).toEqual(before);
    expect(button("Save groups").props.disabled).toBe(true);
    pending.resolve(Response.json({ error: "Delete unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(button("Save groups").props.disabled).toBe(false);
    invoke(form(), "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(profileWrites).toHaveLength(1);
    expect(profileWrites[0]?.body).toBe(
      JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: submittedGroups }),
    );
    expect(new Headers(profileWrites[0]?.headers).get("if-match")).toBe('"1"');
    expect(fields()).toEqual(before);
  });
});

describe("Diary stable meal-group moves", () => {
  function form() {
    const found = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!found) throw new Error("Missing meal-group form.");
    return found;
  }
  function fields() {
    return elements(form())
      .filter((node) => node.type === "input")
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  const cases = [
    {
      direction: "down",
      target: "breakfast",
      initialIndex: 1,
      boundaryIndex: 4,
      opposite: "up",
      label: "Morning meal",
      twice: ["lunch", "dinner", "breakfast", "snacks"],
      boundary: ["lunch", "dinner", "snacks", "breakfast"],
    },
    {
      direction: "up",
      target: "snacks",
      initialIndex: 4,
      boundaryIndex: 1,
      opposite: "down",
      label: "Small meals",
      twice: ["breakfast", "snacks", "lunch", "dinner"],
      boundary: ["snacks", "breakfast", "lunch", "dinner"],
    },
  ] as const;

  for (const scenario of cases) {
    it.each(["before-paint", "after-paint"] as const)(
      `moves the same ${scenario.target} group ${scenario.direction} with retained actions %s`,
      async (timing) => {
        const base = fetcher();
        const writes: RequestInit[] = [];
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url === "/api/profile") {
            if (!init) throw new Error("Missing profile request.");
            writes.push(init);
            return Promise.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
          }
          return base(url, init);
        });
        await mount(fetch);
        await click("Customize diary groups");
        await change(`Group ${scenario.initialIndex} label`, scenario.label);
        const retained = button(`Move group ${scenario.initialIndex} ${scenario.direction}`);
        expect(retained.props.disabled).toBe(false);
        const requests = fetch.mock.calls.length;
        invoke(retained);
        if (timing === "after-paint") await hooks.settle();
        invoke(retained);
        await hooks.settle();
        const expectedGroups = (slots: readonly MealSlot[]) =>
          slots.map((mealSlot) => {
            const original = defaultDiaryGroups.find((group) => group.mealSlot === mealSlot);
            if (!original) throw new Error("Missing stable meal slot.");
            return {
              mealSlot,
              label: mealSlot === scenario.target ? scenario.label : original.label,
            };
          });
        const expectedFields = (slots: readonly MealSlot[]) =>
          expectedGroups(slots).map((group) => ({
            id: `diary-group-${group.mealSlot}`,
            value: group.label,
          }));
        expect(fields()).toEqual(expectedFields(scenario.twice));
        expect(fetch.mock.calls).toHaveLength(requests);
        invoke(retained);
        if (timing === "after-paint") await hooks.settle();
        invoke(retained);
        await hooks.settle();
        expect(fields()).toEqual(expectedFields(scenario.boundary));
        expect(
          button(`Move group ${scenario.boundaryIndex} ${scenario.direction}`).props.disabled,
        ).toBe(true);
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(fields()).toEqual(expectedFields(scenario.boundary));
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(writes).toHaveLength(2);
        expect(writes[0]?.body).toBe(
          JSON.stringify({
            expectedOwnerUserId: owner,
            diaryGroups: expectedGroups(scenario.boundary),
          }),
        );
        expect(writes[1]?.body).toBe(writes[0]?.body);
        expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
        expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
        const fresh = button(`Move group ${scenario.boundaryIndex} ${scenario.opposite}`);
        expect(fresh.props.disabled).toBe(false);
        const afterRetry = fetch.mock.calls.length;
        invoke(fresh);
        await hooks.settle();
        expect(fields()).toEqual(expectedFields(scenario.twice));
        expect(fetch.mock.calls).toHaveLength(afterRetry);
      },
    );
  }
});

describe("Diary group control lifecycle ownership", () => {
  const actions = [
    "rename",
    "Move group 2 up",
    "Move group 1 down",
    "Reset defaults",
    "Cancel",
    "Close diary group settings",
  ];
  function retainedAction(name: string) {
    const node = name === "rename" ? field("Group 1 label") : button(name);
    return () =>
      name === "rename"
        ? invoke(node, "onChange", { target: { value: "Retired label" } })
        : invoke(node);
  }
  function snapshot() {
    return {
      text: text(),
      fields: elements()
        .filter((node) => node.type === "input" && String(node.props.id).startsWith("diary-group-"))
        .map((node) => ({ id: node.props.id, value: node.props.value })),
    };
  }
  async function openDraft() {
    await click("Customize diary groups");
    await change("Group 1 label", "Morning meal");
  }
  for (const transition of ["unmount", "owner replacement"] as const) {
    it.each(actions)(`rejects retained %s after ${transition}`, async (name) => {
      const fetch = await mount(fetcher());
      await openDraft();
      const act = retainedAction(name);
      if (transition === "unmount") hooks.unmount();
      else hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
      const before = snapshot();
      const requests = fetch.mock.calls.length;
      const routes = router.replace.mock.calls.slice();
      act();
      if (transition === "owner replacement") hooks.renderWithoutEffects();
      expect(snapshot()).toEqual(before);
      expect(hooks.afterClose()).toBe(0);
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(router.replace.mock.calls).toEqual(routes);
    });
  }
  it("retires settings controls on effect replay and keeps fresh exact save retries", async () => {
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/profile") {
        if (!init) throw new Error("Missing profile request.");
        writes.push(init);
        return Promise.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
      }
      return base(url, init);
    });
    await mount(fetch);
    await openDraft();
    const retired = actions.map(retainedAction);
    hooks.replayEffects();
    await hooks.settle();
    const before = snapshot();
    const requests = fetch.mock.calls.length;
    for (const act of retired) {
      act();
      await hooks.settle();
      expect(snapshot()).toEqual(before);
    }
    expect(fetch.mock.calls).toHaveLength(requests);
    await change("Group 1 label", "Fresh morning");
    expect(field("Group 1 label").props.value).toBe("Fresh morning");
    const form = elements().find(
      (node) =>
        node.type === "form" &&
        elements(node).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!form) throw new Error("Missing group settings form.");
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toBe(
      JSON.stringify({
        expectedOwnerUserId: owner,
        diaryGroups: defaultDiaryGroups.map((group) =>
          group.mealSlot === "breakfast" ? { ...group, label: "Fresh morning" } : group,
        ),
      }),
    );
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"1"');
    expect(new Headers(writes[1]?.headers).get("if-match")).toBe('"1"');
    expect(field("Group 1 label").props.value).toBe("Fresh morning");
    expect(button("Save groups").props.disabled).toBe(false);
  });
  it("keeps confirmed sign-out closed through retained settings controls", async () => {
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url === "/api/auth/logout"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : base(url, init),
    );
    await mount(fetch);
    const opening = button("Customize diary groups");
    await openDraft();
    const retired = actions.map(retainedAction);
    await click("Sign out");
    const before = snapshot();
    const requests = fetch.mock.calls.length;
    const routes = router.replace.mock.calls.slice();
    for (const act of [() => invoke(opening), ...retired]) {
      act();
      await hooks.settle();
      expect(snapshot()).toEqual(before);
    }
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(router.replace.mock.calls).toEqual(routes);
  });
});

describe("Diary timezone refresh lifecycle ownership", () => {
  async function startRefresh(pending: Promise<Response>) {
    const base = fetcher();
    let conflict = false;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        conflict = true;
        return Promise.resolve(Response.json({ code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 }));
      }
      if (conflict && url === "/api/auth/me") return pending;
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 today");
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
    return fetch;
  }
  function lateResponse(kind: string) {
    return kind === "expired"
      ? Response.json({}, { status: 401 })
      : Response.json(session(anotherOwner));
  }
  for (const transition of ["unmount", "effect replay", "owner replacement"] as const) {
    it.each(["expired", "foreign owner"])(
      `ignores a late %s timezone refresh after ${transition}`,
      async (kind) => {
        const pending = deferred<Response>();
        const fetch = await startRefresh(pending.promise);
        if (transition === "unmount") hooks.unmount();
        else if (transition === "effect replay") {
          hooks.replayEffects();
          await hooks.settle();
        } else hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
        const before = text();
        const requests = fetch.mock.calls.length;
        const routes = router.replace.mock.calls.slice();
        pending.resolve(lateResponse(kind));
        if (transition === "owner replacement") {
          for (let pass = 0; pass < 12; pass += 1) await Promise.resolve();
          hooks.renderWithoutEffects();
        } else await hooks.settle();
        expect(router.replace.mock.calls).toEqual(routes);
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(text()).toBe(before);
        expect(hooks.afterClose()).toBe(0);
      },
    );
  }
  it("retires a timezone refresh while its response body is decoding", async () => {
    const body = deferred<ReturnType<typeof session>>();
    const response = Response.json({});
    const decode = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const fetch = await startRefresh(Promise.resolve(response));
    expect(decode).toHaveBeenCalledTimes(1);
    hooks.unmount();
    const requests = fetch.mock.calls.length;
    const routes = router.replace.mock.calls.slice();
    body.resolve(session(anotherOwner));
    await hooks.settle();
    expect(router.replace.mock.calls).toEqual(routes);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
  });
  it.each(["expired", "foreign owner"])(
    "closes the current diary for a %s timezone refresh",
    async (kind) => {
      const pending = deferred<Response>();
      const fetch = await startRefresh(pending.promise);
      const requests = fetch.mock.calls.length;
      pending.resolve(lateResponse(kind));
      await hooks.settle();
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(text()).toContain("Closing your private diary");
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );
});

describe("Diary entry reorder lifecycle ownership", () => {
  async function fixture() {
    const value = page([entry(0), entry(1)]);
    const orderGroup = (mealSlot: MealSlot) => ({
      mealSlot,
      entries: value.data.entries
        .filter((row) => row.mealSlot === mealSlot)
        .map((row) => ({
          entryId: row.id,
          entryRevision: row.revision,
          position: row.position,
        })),
    });
    value.data.orderDigest = await diaryDayOrderDigest(value.data.localDate, value.data.timeZone, [
      orderGroup("breakfast"),
      orderGroup("lunch"),
      orderGroup("dinner"),
      orderGroup("snacks"),
    ]);
    return value;
  }
  async function start(pending: Promise<Response>, begin = true) {
    const value = await fixture();
    const base = fetcher(value);
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(init);
        return writes.length === 1
          ? pending
          : Promise.resolve(Response.json({ error: "Fresh move unavailable." }, { status: 503 }));
      }
      return base(url, init);
    });
    await mount(fetch);
    if (begin) {
      await click("Move Apple 0 down within Breakfast");
      expect(writes).toHaveLength(1);
    }
    return { fetch, writes, value };
  }
  async function saved(value: Awaited<ReturnType<typeof fixture>>, write: RequestInit | undefined) {
    const operationId = new Headers(write?.headers).get("idempotency-key");
    if (!operationId) throw new Error("Missing reorder operation id.");
    const groups = [
      {
        mealSlot: "breakfast",
        entries: [
          { entryId: entry(1).id, entryRevision: "4", position: 0 },
          { entryId: entry(0).id, entryRevision: "4", position: 1 },
        ],
      },
      { mealSlot: "lunch", entries: [] },
      { mealSlot: "dinner", entries: [] },
      { mealSlot: "snacks", entries: [] },
    ] as const;
    return {
      data: {
        replayed: false,
        receipt: {
          operationId,
          localDate: value.data.localDate,
          timeZone: value.data.timeZone,
          expectedDayRevision: "8",
          resultingDayRevision: "9",
          previousOrderDigest: value.data.orderDigest,
          orderDigest: await diaryDayOrderDigest(value.data.localDate, value.data.timeZone, groups),
          groups,
        },
      },
    };
  }
  async function retire(transition: string) {
    if (transition === "unmount") hooks.unmount();
    else if (transition === "effect replay") {
      hooks.replayEffects();
      await hooks.settle();
    } else if (transition === "route replacement") {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    } else hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
  }
  async function settleRetired(transition: string) {
    if (transition === "owner replacement" || transition === "route replacement") {
      for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
      hooks.renderWithoutEffects();
    } else await hooks.settle();
  }
  it.each(["unmount", "effect replay", "owner replacement"])(
    "rejects a retained reorder control after %s",
    async (transition) => {
      const { fetch } = await start(Promise.resolve(Response.json({}, { status: 503 })), false);
      const move = button("Move Apple 0 down within Breakfast");
      await retire(transition);
      const before = text(),
        requests = fetch.mock.calls.length;
      invoke(move);
      await settleRetired(transition);
      expect(hooks.afterClose()).toBe(0);
      expect(text()).toBe(before);
      expect(fetch.mock.calls).toHaveLength(requests);
    },
  );
  it("allows a fresh reorder after effect replay before the retired response arrives", async () => {
    const pending = deferred<Response>();
    const { fetch, writes } = await start(pending.promise);
    hooks.replayEffects();
    await hooks.settle();
    expect(button("Move Apple 0 down within Breakfast").props.disabled).toBe(false);
    await click("Move Apple 0 down within Breakfast");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(Object.fromEntries(new Headers(writes[1]?.headers))).toEqual(
      Object.fromEntries(new Headers(writes[0]?.headers)),
    );
    expect(text()).toContain("Fresh move unavailable.");
    const before = text(),
      requests = fetch.mock.calls.length;
    pending.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    expect(text()).toBe(before);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });
  it("retires reorder digest preparation without a request or state write", async () => {
    const { fetch } = await start(Promise.resolve(Response.json({}, { status: 503 })), false);
    const requests = fetch.mock.calls.length;
    invoke(button("Move Apple 0 down within Breakfast"));
    hooks.unmount();
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(fetch.mock.calls).toHaveLength(requests);
  });
  for (const transition of ["unmount", "effect replay", "owner replacement", "route replacement"]) {
    it.each(["expired", "saved"])(
      `ignores a late %s reorder response after ${transition}`,
      async (kind) => {
        const pending = deferred<Response>();
        const { fetch, value, writes } = await start(pending.promise);
        const response =
          kind === "expired"
            ? Response.json({}, { status: 401 })
            : Response.json(await saved(value, writes[0]));
        await retire(transition);
        const before = text(),
          requests = fetch.mock.calls.length,
          routes = router.replace.mock.calls.slice();
        pending.resolve(response);
        await settleRetired(transition);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(text()).toBe(before);
        expect(hooks.afterClose()).toBe(0);
      },
    );
  }
  it("retires a reorder receipt while its response body is decoding", async () => {
    const body = deferred<Awaited<ReturnType<typeof saved>>>();
    const response = Response.json({});
    const decode = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const { fetch, value, writes } = await start(Promise.resolve(response));
    expect(decode).toHaveBeenCalledTimes(1);
    const receipt = await saved(value, writes[0]);
    hooks.unmount();
    const requests = fetch.mock.calls.length;
    body.resolve(receipt);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });
  it.each(["expired", "saved"])("handles the current %s reorder response", async (kind) => {
    const pending = deferred<Response>();
    const { fetch, value, writes } = await start(pending.promise);
    const requests = fetch.mock.calls.length;
    pending.resolve(
      kind === "expired"
        ? Response.json({}, { status: 401 })
        : Response.json(await saved(value, writes[0])),
    );
    await hooks.settle();
    if (kind === "expired") {
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(text()).toContain("Closing your private diary");
      expect(fetch.mock.calls).toHaveLength(requests);
    } else {
      expect(text()).toContain("Apple 0 moved down; the complete authoritative day was refreshed.");
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      expect(fetch.mock.calls.at(-1)?.[0]).toContain("/api/diary?date=2026-08-15");
      expect(button("Move Apple 0 down within Breakfast").props.disabled).toBe(false);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    }
  });
});

describe("Diary deletion response lifecycle ownership", () => {
  function receipt(write: RequestInit | undefined) {
    const operationId = new Headers(write?.headers).get("idempotency-key");
    if (!operationId) throw new Error("Missing deletion operation id.");
    const affectedDays = [{ localDate: "2026-08-15", revision: "9" }];
    return {
      data: {
        replayed: false,
        entry: null,
        affectedDays,
        receipt: {
          protocol: "v1",
          operationId,
          kind: "delete",
          expectedSubjects: [{ entryId: entry(0).id, revision: "3" }],
          resultSubjects: [{ entryId: entry(0).id, revision: "4", state: "deleted" }],
          affectedDays,
        },
      },
    };
  }
  async function start(pending: Promise<Response>, reload?: Promise<Response>) {
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        writes.push(init);
        return pending;
      }
      if (writes.length > 0 && url.startsWith("/api/diary?") && reload) return reload;
      return base(url, init);
    });
    await mount(fetch);
    await click("Delete Apple 0");
    expect(writes).toHaveLength(1);
    return { fetch, writes };
  }
  function replace(transition: string) {
    if (transition === "account")
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    else {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    }
  }
  async function settleBeforeEffects() {
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    hooks.renderWithoutEffects();
  }
  for (const transition of ["account", "route"]) {
    it.each(["saved", "conflict", "failed"])(
      `ignores a late %s deletion after ${transition} replacement`,
      async (kind) => {
        const pending = deferred<Response>();
        const { fetch, writes } = await start(pending.promise);
        const response =
          kind === "saved"
            ? Response.json(receipt(writes[0]))
            : Response.json(
                { error: "Old deletion unavailable." },
                { status: kind === "conflict" ? 412 : 503 },
              );
        replace(transition);
        const before = text(),
          requests = fetch.mock.calls.length,
          routes = router.replace.mock.calls.slice();
        pending.resolve(response);
        await settleBeforeEffects();
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(text()).toBe(before);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(writes).toHaveLength(1);
      },
    );
    it(`retires a deletion while JSON decodes before ${transition} effects`, async () => {
      const body = deferred<ReturnType<typeof receipt>>();
      const response = Response.json({});
      const decode = vi.spyOn(response, "json").mockImplementation(() => body.promise);
      const { fetch, writes } = await start(Promise.resolve(response));
      expect(decode).toHaveBeenCalledTimes(1);
      replace(transition);
      const before = text(),
        requests = fetch.mock.calls.length;
      body.resolve(receipt(writes[0]));
      await settleBeforeEffects();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(text()).toBe(before);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    });
  }
  it.each(["saved", "failed"])(
    "does not report deletion into a replaced account after a %s day reload",
    async (kind) => {
      const pending = deferred<Response>(),
        reload = deferred<Response>();
      const { fetch, writes } = await start(pending.promise, reload.promise);
      const requests = fetch.mock.calls.length;
      pending.resolve(Response.json(receipt(writes[0])));
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      replace("account");
      const before = text();
      reload.resolve(
        kind === "saved"
          ? Response.json(page([entry(1, "lunch")], null, 1, "2026-08-15", "9"))
          : Response.json({ error: "Old reload unavailable." }, { status: 503 }),
      );
      await settleBeforeEffects();
      expect(text()).toBe(before);
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    },
  );
  it.each(["saved", "conflict"])("keeps the current %s deletion recovery", async (kind) => {
    const pending = deferred<Response>();
    const fresh = kind === "saved" ? page([entry(1, "lunch")], null, 1, "2026-08-15", "9") : page();
    const { fetch, writes } = await start(pending.promise, Promise.resolve(Response.json(fresh)));
    const requests = fetch.mock.calls.length;
    pending.resolve(
      kind === "saved" ? Response.json(receipt(writes[0])) : Response.json({}, { status: 412 }),
    );
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests + 1);
    expect(text()).toContain(
      kind === "saved"
        ? "Apple 0 deleted from Breakfast and totals refreshed."
        : "The diary changed elsewhere. Fresh values were loaded; delete again if needed.",
    );
    expect(elements().some((node) => node.props["aria-label"] === "Delete Apple 0")).toBe(
      kind === "conflict",
    );
    expect(button("Delete Apple 1").props.disabled).toBe(false);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"3"');
  });
});

describe("Diary edit response lifecycle ownership", () => {
  async function start(pending: Promise<Response>, reload?: Promise<Response>) {
    const base = fetcher();
    const writes: ReturnType<typeof captureEditorSave>[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writes.push(captureEditorSave(url, init));
        return pending;
      }
      if (writes.length > 0 && url.startsWith("/api/diary?") && reload) return reload;
      return base(url, init);
    });
    await mount(fetch);
    await prepareSaveLockDraft();
    const draft = editorValues();
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(1);
    return { fetch, writes, draft };
  }
  function receipt(writes: ReturnType<typeof captureEditorSave>[]) {
    const request = writes[0];
    if (!request) throw new Error("Missing editor request.");
    return editorSaveReceipt(request);
  }
  function replace(transition: string) {
    if (transition === "account")
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    else {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
    }
  }
  async function settleBeforeEffects() {
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    hooks.renderWithoutEffects();
  }
  for (const transition of ["account", "route"]) {
    it.each(["saved", "conflict", "timezone", "failed"])(
      `ignores a late %s edit after ${transition} replacement`,
      async (kind) => {
        const pending = deferred<Response>();
        const { fetch, writes } = await start(pending.promise);
        const response =
          kind === "saved"
            ? Response.json(receipt(writes))
            : Response.json(
                { error: "Old edit unavailable.", code: "DIARY_TIME_ZONE_CHANGED" },
                { status: kind === "conflict" ? 412 : kind === "timezone" ? 409 : 503 },
              );
        replace(transition);
        const before = text(),
          requests = fetch.mock.calls.length,
          routes = router.replace.mock.calls.slice();
        pending.resolve(response);
        await settleBeforeEffects();
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(text()).toBe(before);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(writes).toHaveLength(1);
      },
    );
    it(`retires an edit while JSON decodes before ${transition} effects`, async () => {
      const body = deferred<ReturnType<typeof editorSaveReceipt>>();
      const response = Response.json({});
      const decode = vi.spyOn(response, "json").mockImplementation(() => body.promise);
      const { fetch, writes } = await start(Promise.resolve(response));
      expect(decode).toHaveBeenCalledTimes(1);
      replace(transition);
      const before = text(),
        requests = fetch.mock.calls.length;
      body.resolve(receipt(writes));
      await settleBeforeEffects();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(text()).toBe(before);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    });
  }
  it.each(["saved", "failed"])(
    "does not report an edit into a replaced account after a %s day reload",
    async (kind) => {
      const pending = deferred<Response>(),
        reload = deferred<Response>();
      const { fetch, writes } = await start(pending.promise, reload.promise);
      const requests = fetch.mock.calls.length;
      pending.resolve(Response.json(receipt(writes)));
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      replace("account");
      const before = text();
      reload.resolve(
        kind === "saved"
          ? Response.json(
              page([receipt(writes).data.entry, entry(1, "lunch")], null, 2, "2026-08-15", "9"),
            )
          : Response.json({ error: "Old reload unavailable." }, { status: 503 }),
      );
      await settleBeforeEffects();
      expect(text()).toBe(before);
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    },
  );
  it.each(["saved", "conflict"])("keeps the current %s edit recovery", async (kind) => {
    const pending = deferred<Response>(),
      reload = deferred<Response>();
    const { fetch, writes } = await start(pending.promise, reload.promise);
    const requests = fetch.mock.calls.length;
    pending.resolve(
      kind === "saved" ? Response.json(receipt(writes)) : Response.json({}, { status: 412 }),
    );
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests + 1);
    reload.resolve(
      Response.json(
        kind === "saved"
          ? page([receipt(writes).data.entry, entry(1, "lunch")], null, 2, "2026-08-15", "9")
          : page(),
      ),
    );
    await hooks.settle();
    expect(text()).toContain(
      kind === "saved"
        ? "Diary entry saved in Dinner with fresh totals."
        : "The diary changed elsewhere. Fresh values were loaded; review your edit again.",
    );
    expect(elements().some((node) => node.props.className === "entryEditor")).toBe(false);
    expect(button("Edit Apple 0").props.disabled).toBe(false);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
  });
  it("keeps the current failed edit draft and exact request for retry", async () => {
    const { writes, draft } = await start(
      Promise.resolve(Response.json({ error: "Edit unavailable." }, { status: 503 })),
    );
    expect(editorValues()).toEqual(draft);
    expect(button("Save changes to Apple 0").props.disabled).toBe(false);
    await click("Save changes to Apple 0");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(editorValues()).toEqual(draft);
  });
});

describe("Diary Repeat response page ownership", () => {
  async function start(pending: Promise<Response>, reload?: Promise<Response>) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T18:00:59.000Z"));
    const base = fetcher();
    const writes: CapturedRepeat[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/repeat?")) {
        writes.push(captureRepeat(url, init));
        return pending;
      }
      if (writes.length > 0 && url.startsWith("/api/diary?") && reload) return reload;
      return base(url, init);
    });
    await mount(fetch);
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(1);
    return { fetch, writes };
  }
  function receipt(writes: CapturedRepeat[]) {
    const request = writes[0];
    if (!request) throw new Error("Missing Repeat request.");
    return repeatReceipt(request);
  }
  function replaceRoute() {
    route.date = "2026-08-16";
    hooks.renderWithoutEffects();
  }
  async function settleBeforeEffects() {
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    hooks.renderWithoutEffects();
  }
  it.each(["saved", "conflict", "timezone", "failed", "unauthorized"])(
    "keeps a late %s Repeat response off a replacement route before effects",
    async (kind) => {
      const pending = deferred<Response>();
      const { fetch, writes } = await start(pending.promise);
      const response =
        kind === "saved"
          ? Response.json(receipt(writes))
          : Response.json(
              { error: "Old Repeat unavailable.", code: "DIARY_TIME_ZONE_CHANGED" },
              {
                status:
                  kind === "conflict"
                    ? 412
                    : kind === "timezone"
                      ? 409
                      : kind === "unauthorized"
                        ? 401
                        : 503,
              },
            );
      replaceRoute();
      const before = text(),
        requests = fetch.mock.calls.length,
        routes = router.replace.mock.calls.slice();
      pending.resolve(response);
      await settleBeforeEffects();
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(text()).toBe(before);
      expect(router.replace.mock.calls).toEqual(routes);
      expect(writes).toHaveLength(1);
    },
  );
  it("keeps a decoded Repeat receipt off a route replaced during JSON decoding", async () => {
    const body = deferred<ReturnType<typeof repeatReceipt>>();
    const response = Response.json({});
    const decode = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const { fetch, writes } = await start(Promise.resolve(response));
    expect(decode).toHaveBeenCalledTimes(1);
    replaceRoute();
    const before = text(),
      requests = fetch.mock.calls.length;
    body.resolve(receipt(writes));
    await settleBeforeEffects();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(text()).toBe(before);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });
  it.each(["saved", "failed"])(
    "does not report Repeat into a replaced account after a %s day reload",
    async (kind) => {
      const pending = deferred<Response>(),
        reload = deferred<Response>();
      const { fetch, writes } = await start(pending.promise, reload.promise);
      const requests = fetch.mock.calls.length;
      pending.resolve(Response.json(receipt(writes)));
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
      const before = text();
      reload.resolve(
        kind === "saved"
          ? Response.json(
              page(
                [entry(0), entry(1, "lunch"), receipt(writes).data.entry],
                null,
                3,
                "2026-08-15",
                "9",
              ),
            )
          : Response.json({ error: "Old reload unavailable." }, { status: 503 }),
      );
      await settleBeforeEffects();
      expect(text()).toBe(before);
      expect(fetch.mock.calls).toHaveLength(requests + 1);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    },
  );
  it.each(["saved", "conflict"])("keeps the current %s Repeat recovery", async (kind) => {
    const pending = deferred<Response>(),
      reload = deferred<Response>();
    const { fetch, writes } = await start(pending.promise, reload.promise);
    const requests = fetch.mock.calls.length;
    pending.resolve(
      kind === "saved" ? Response.json(receipt(writes)) : Response.json({}, { status: 412 }),
    );
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests + 1);
    reload.resolve(
      Response.json(
        kind === "saved"
          ? page(
              [entry(0), entry(1, "lunch"), receipt(writes).data.entry],
              null,
              3,
              "2026-08-15",
              "9",
            )
          : page(),
      ),
    );
    await hooks.settle();
    expect(text()).toContain(
      kind === "saved"
        ? "Pinned entry version repeated in Breakfast with fresh authoritative totals."
        : "The source entry changed. Fresh details were loaded; review before repeating.",
    );
    expect(button("Repeat Apple 0 today").props.disabled).toBe(false);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    expect(writes[0]?.headers["if-match"]).toBe('"3"');
  });
  it("keeps an uncertain current Repeat request exact on retry", async () => {
    const { writes } = await start(
      Promise.resolve(Response.json({ error: "Repeat unavailable." }, { status: 503 })),
    );
    expect(text()).toContain("retry the same operation for 2026-08-15 safely.");
    expect(button("Repeat Apple 0 today").props.disabled).toBe(false);
    vi.setSystemTime(new Date("2026-08-16T06:00:59.000Z"));
    await click("Repeat Apple 0 today");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });
  it("keeps current Repeat expiry routing", async () => {
    const { writes } = await start(Promise.resolve(Response.json({}, { status: 401 })));
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(writes).toHaveLength(1);
  });
});

describe("Diary day Retry ownership", () => {
  async function failedDay() {
    const base = fetcher();
    let read = 0;
    let nextRead: (() => Promise<Response>) | undefined;
    const logout = deferred<Response>();
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/auth/logout") return logout.promise;
      if (url.startsWith("/api/diary?")) {
        read += 1;
        if (read === 1)
          return Promise.resolve(Response.json({ error: "Day unavailable." }, { status: 503 }));
        if (nextRead) return nextRead();
      }
      return base(url, init);
    });
    await mount(fetch);
    expect(text()).toContain("Day unavailable.");
    return {
      fetch,
      logout,
      retry: button("Retry"),
      next: (response: () => Promise<Response>) => {
        nextRead = response;
      },
    };
  }

  it("admits one retry before paint without aborting its request", async () => {
    const { fetch, retry, next } = await failedDay();
    const pending = deferred<Response>();
    next(() => pending.promise);
    invoke(retry);
    const requests = fetch.mock.calls.length;
    const signal = fetch.mock.calls.at(-1)?.[1]?.signal;
    invoke(retry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(signal?.aborted).toBe(false);
    pending.resolve(Response.json(page()));
    await hooks.settle();
    expect(text()).toContain("Apple 0");
  });

  it("retires a failed attempt's control while a fresh retry keeps the exact day request", async () => {
    const { fetch, retry, next } = await failedDay();
    next(() => Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 })));
    await click("Retry");
    expect(text()).toContain("Still unavailable.");
    const requests = fetch.mock.calls.length;
    invoke(retry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    next(() => Promise.resolve(Response.json(page())));
    await click("Retry");
    const reads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"));
    expect(reads).toHaveLength(3);
    expect(reads.map(([url]) => url)).toEqual(Array(3).fill(reads[0]?.[0]));
    for (const [, init] of reads) {
      expect(init?.cache).toBe("no-store");
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        accept: "application/json",
      });
    }
    expect(text()).toContain("2 of 2 entries loaded. Nutrition totals include all 2.");
  });

  it("keeps a recovered editor and its exact draft when the old Retry is invoked", async () => {
    const { fetch, retry } = await failedDay();
    await click("Retry");
    await prepareSaveLockDraft();
    const values = editorValues(),
      before = text(),
      requests = fetch.mock.calls.length;
    invoke(retry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(text()).toBe(before);
    expect(editorValues()).toEqual(values);
  });

  it.each([
    "unmount",
    "effect replay",
    "account replacement",
    "route replacement",
    "route return",
    "confirmed sign-out",
  ])("rejects a retained Retry after %s", async (transition) => {
    const { fetch, retry, logout } = await failedDay();
    if (transition === "unmount") hooks.unmount();
    else if (transition === "effect replay") {
      hooks.replayEffects();
      await hooks.settle();
    } else if (transition === "account replacement")
      hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    else if (transition === "confirmed sign-out") {
      logout.resolve(new Response(null, { status: 204 }));
      await click("Sign out");
    } else {
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
      if (transition === "route return") {
        route.date = "2026-08-15";
        hooks.renderWithoutEffects();
      }
    }
    const requests = fetch.mock.calls.length,
      before = text(),
      navigations = router.replace.mock.calls.length;
    invoke(retry);
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    if (transition !== "unmount") hooks.renderWithoutEffects();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
    expect(text()).toBe(before);
    expect(router.replace.mock.calls).toHaveLength(navigations);
    if (transition === "effect replay") {
      await click("Edit Apple 0");
      expect(editorField("Quantity").props.value).toBe("1.250000");
    }
  });

  it("blocks Retry during sign-out and restores fresh recovery after failed confirmation", async () => {
    const { fetch, retry, logout } = await failedDay();
    invoke(button("Sign out"));
    const requests = fetch.mock.calls.length;
    invoke(retry);
    await hooks.settle();
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(button("Retry").props.disabled).toBe(true);
    logout.resolve(Response.json({ error: "Sign out unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(button("Retry").props.disabled).toBe(false);
    await click("Retry");
    expect(text()).toContain("Apple 0");
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });
});

describe("Diary date controls during writes", () => {
  const choices = ["Previous day", "Next day", "Today", "Local date"] as const;
  function control(choice: (typeof choices)[number]) {
    return choice === "Local date" ? field(choice) : button(choice);
  }
  function activate(node: ElementNode, choice: (typeof choices)[number]) {
    if (choice === "Local date") invoke(node, "onChange", { target: { value: "2026-08-20" } });
    else invoke(node);
  }
  function submitGroups() {
    const form = elements().find(
      (node) => node.type === "form" && text(node).includes("Save groups"),
    );
    if (!form) throw new Error("Missing diary settings form.");
    invoke(form, "onSubmit", { preventDefault() {} });
  }
  for (const kind of ["edit", "profile"] as const) {
    it.each(choices)(`keeps %s on the submitted day during a ${kind} write`, async (choice) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
      const pending = deferred<Response>();
      const base = fetcher();
      const writes: ReturnType<typeof captureEditorSave>[] = [];
      const requests: RequestInit[] = [];
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (
          (kind === "profile" && url === "/api/profile") ||
          (kind === "edit" && init?.method === "PATCH")
        ) {
          if (!init) throw new Error("Missing write request.");
          writes.push(captureEditorSave(url, init));
          requests.push(init);
          return writes.length === 1
            ? pending.promise
            : Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
        }
        return base(url, init);
      });
      await mount(fetch);
      if (kind === "edit") await prepareSaveLockDraft();
      else {
        await click("Customize diary groups");
        await change("Group 1 label", "Submitted morning");
        await click("Move group 1 down");
      }
      const draft =
        kind === "edit"
          ? editorValues()
          : Array.from({ length: 4 }, (_, i) => field(`Group ${i + 1} label`).props.value);
      const retained = control(choice),
        navigations = router.replace.mock.calls.length;
      if (kind === "edit") invoke(button("Save changes to Apple 0"));
      else submitGroups();
      expect(writes).toHaveLength(1);
      const count = fetch.mock.calls.length;
      activate(retained, choice);
      await hooks.settle();
      expect(router.replace.mock.calls).toHaveLength(navigations);
      expect(fetch.mock.calls).toHaveLength(count);
      expect(field("Local date").props.value).toBe("2026-08-15");
      expect(control(choice).props.disabled).toBe(true);
      activate(control(choice), choice);
      await hooks.settle();
      expect(router.replace.mock.calls).toHaveLength(navigations);
      expect(fetch.mock.calls).toHaveLength(count);
      expect(requests[0]?.signal?.aborted).not.toBe(true);
      pending.resolve(Response.json({ error: "Save unavailable." }, { status: 503 }));
      await hooks.settle();
      expect(text()).toContain("Save unavailable.");
      expect(
        kind === "edit"
          ? editorValues()
          : Array.from({ length: 4 }, (_, i) => field(`Group ${i + 1} label`).props.value),
      ).toEqual(draft);
      if (kind === "edit") await click("Save changes to Apple 0");
      else {
        submitGroups();
        await hooks.settle();
      }
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[0]?.headers["if-match"]).toBe(kind === "edit" ? '"3"' : '"1"');
      if (kind === "profile")
        expect(JSON.parse(writes[0]?.body ?? "{}").expectedOwnerUserId).toBe(owner);
      expect(control(choice).props.disabled).toBe(false);
      activate(control(choice), choice);
      const target =
        choice === "Previous day"
          ? "2026-08-14"
          : choice === "Local date"
            ? "2026-08-20"
            : "2026-08-16";
      route.date = target;
      await hooks.settle();
      expect(router.replace).toHaveBeenLastCalledWith(`/dashboard?date=${target}`, {
        scroll: false,
      });
      expect(field("Local date").props.value).toBe(target);
      expect(text()).toContain("Apple 2");
    });
  }
});

describe("Diary date control page ownership", () => {
  const choices = ["Previous day", "Next day", "Today", "Local date"] as const;
  function control(choice: (typeof choices)[number]) {
    return choice === "Local date" ? field(choice) : button(choice);
  }
  function activate(node: ElementNode, choice: (typeof choices)[number]) {
    if (choice === "Local date") invoke(node, "onChange", { target: { value: "2026-08-20" } });
    else invoke(node);
  }
  function freezeToday() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T18:00:00Z"));
  }
  it.each(choices)("retires %s before a replacement account's effects", async (choice) => {
    freezeToday();
    const fetch = fetcher();
    await mount(fetch);
    await prepareSaveLockDraft();
    const retained = control(choice);
    hooks.replaceVerifiedSessionBeforeEffects(parseSession(session(anotherOwner)));
    const before = text(),
      draft = editorValues(),
      requests = fetch.mock.calls.length,
      navigations = router.replace.mock.calls.length;
    activate(retained, choice);
    hooks.renderWithoutEffects();
    expect(router.replace.mock.calls).toHaveLength(navigations);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(text()).toBe(before);
    expect(editorValues()).toEqual(draft);
    expect(field("Local date").props.value).toBe("2026-08-15");
  });
  it.each(["unmount", "effect replay", "route replacement", "route return"])(
    "retires Next day after %s",
    async (transition) => {
      const fetch = fetcher();
      await mount(fetch);
      const retained = button("Next day");
      if (transition === "unmount") hooks.unmount();
      else if (transition === "effect replay") {
        hooks.replayEffects();
        await hooks.settle();
      } else {
        route.date = "2026-08-16";
        hooks.renderWithoutEffects();
        if (transition === "route return") {
          route.date = "2026-08-15";
          hooks.renderWithoutEffects();
        }
      }
      const before = text(),
        requests = fetch.mock.calls.length,
        navigations = router.replace.mock.calls.length;
      invoke(retained);
      if (transition !== "unmount") hooks.renderWithoutEffects();
      expect(router.replace.mock.calls).toHaveLength(navigations);
      expect(fetch.mock.calls).toHaveLength(requests);
      expect(hooks.afterClose()).toBe(0);
      expect(text()).toBe(before);
      if (transition === "effect replay") {
        invoke(button("Next day"));
        route.date = "2026-08-16";
        await hooks.settle();
        expect(field("Local date").props.value).toBe("2026-08-16");
        expect(text()).toContain("Apple 2");
        expect(router.replace).toHaveBeenLastCalledWith("/dashboard?date=2026-08-16", {
          scroll: false,
        });
      }
    },
  );
  it.each(choices)("retires %s as soon as another date is selected", async (choice) => {
    freezeToday();
    const fetch = fetcher();
    await mount(fetch);
    const retained = control(choice);
    invoke(button("Next day"));
    const navigations = router.replace.mock.calls.length;
    activate(retained, choice);
    expect(router.replace.mock.calls).toHaveLength(navigations);
    route.date = "2026-08-16";
    await hooks.settle();
    expect(field("Local date").props.value).toBe("2026-08-16");
    await click("Edit Apple 2");
    await changeEditorField("Quantity", "2.125000");
    const draft = editorValues(),
      before = text(),
      requests = fetch.mock.calls.length;
    activate(retained, choice);
    await hooks.settle();
    expect(router.replace.mock.calls).toHaveLength(navigations);
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(editorValues()).toEqual(draft);
    expect(text()).toBe(before);
    invoke(button("Next day"));
    route.date = "2026-08-17";
    await hooks.settle();
    expect(field("Local date").props.value).toBe("2026-08-17");
    expect(text()).toContain("Apple 2");
    expect(router.replace).toHaveBeenLastCalledWith("/dashboard?date=2026-08-17", {
      scroll: false,
    });
  });
});

describe("Diary day response route ownership", () => {
  async function start(response: Promise<Response>) {
    const base = fetcher();
    let reads = 0;
    let view: "diary" | "overview" = "diary";
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/diary?") && ++reads === 1) return response;
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    hooks.mount(() => DiaryClient({ view }));
    await hooks.settle();
    return {
      fetch,
      changeView: (next: "diary" | "overview") => {
        view = next;
        hooks.renderWithoutEffects();
      },
    };
  }
  async function settleBeforeEffects() {
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    hooks.renderWithoutEffects();
  }
  for (const transition of ["date replacement", "view return"] as const) {
    it.each(["loaded", "failed", "expired", "decoded"])(
      `ignores an old %s day response after ${transition} and loads the current route`,
      async (kind) => {
        const pending = deferred<Response>();
        const body = deferred<ReturnType<typeof page>>();
        const response =
          kind === "loaded" || kind === "decoded"
            ? Response.json(page())
            : Response.json(
                { error: "Departed day unavailable." },
                { status: kind === "expired" ? 401 : 503 },
              );
        const decode = vi.spyOn(response, "json");
        if (kind === "decoded") decode.mockImplementation(() => body.promise);
        const { fetch, changeView } = await start(
          kind === "decoded" ? Promise.resolve(response) : pending.promise,
        );
        expect(text()).toContain("Loading 2026-08-15");
        if (kind === "decoded") expect(decode).toHaveBeenCalledTimes(1);
        if (transition === "date replacement") {
          route.date = "2026-08-16";
          hooks.renderWithoutEffects();
        } else {
          changeView("overview");
          changeView("diary");
        }
        const before = text(),
          requests = fetch.mock.calls.length,
          navigations = router.replace.mock.calls.length;
        if (kind === "decoded") body.resolve(page());
        else pending.resolve(response);
        await settleBeforeEffects();
        expect(text()).toBe(before);
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(router.replace.mock.calls).toHaveLength(navigations);
        if (kind !== "decoded") expect(decode).not.toHaveBeenCalled();
        hooks.render();
        await hooks.settle();
        const target = transition === "date replacement" ? "2026-08-16" : "2026-08-15";
        const reads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"));
        expect(reads).toHaveLength(2);
        expect(
          new URL(reads[1]?.[0] ?? "", "https://app.example.test").searchParams.get("date"),
        ).toBe(target);
        expect(reads[1]?.[1]?.cache).toBe("no-store");
        expect(Object.fromEntries(new Headers(reads[1]?.[1]?.headers))).toEqual({
          accept: "application/json",
        });
        expect(field("Local date").props.value).toBe(target);
        expect(text()).toContain(transition === "date replacement" ? "Apple 2" : "Apple 0");
        expect(router.replace).not.toHaveBeenCalledWith("/login");
      },
    );
  }
  it.each(["loaded", "failed", "expired"])(
    "preserves the current %s day response",
    async (kind) => {
      const pending = deferred<Response>();
      const { fetch } = await start(pending.promise);
      pending.resolve(
        kind === "loaded"
          ? Response.json(page())
          : Response.json(
              { error: "Current day unavailable." },
              { status: kind === "expired" ? 401 : 503 },
            ),
      );
      await hooks.settle();
      if (kind === "expired") expect(router.replace).toHaveBeenCalledWith("/login");
      else if (kind === "loaded") {
        expect(text()).toContain("2 of 2 entries loaded. Nutrition totals include all 2.");
        expect(text()).toContain("Apple 0");
      } else {
        expect(text()).toContain("Current day unavailable.");
        await click("Retry");
        expect(text()).toContain("Apple 0");
        const reads = fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"));
        expect(reads).toHaveLength(2);
        expect(reads[1]?.[0]).toBe(reads[0]?.[0]);
      }
    },
  );
});

describe("Dashboard card retry ownership", () => {
  function cardProps() {
    const node = elements().find((node) => node.type === TodayOverviewCards);
    if (!node) throw new Error("Missing overview cards");
    return node.props as unknown as Parameters<typeof TodayOverviewCards>[0];
  }
  for (const kind of ["hydration", "activity"] as const) {
    const endpoint = kind === "hydration" ? "/api/hydration?" : "/api/activities?";
    const retry = () =>
      kind === "hydration" ? cardProps().onRetryHydration : cardProps().onRetryActivity;
    const emptyDay = () =>
      Response.json({
        data: {
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          revision: "2",
          entries: [],
          updatedAt: "2026-08-15T13:05:02.000Z",
          ...(kind === "hydration" ? { totalMilliliters: 0 } : { totalDurationMinutes: 0 }),
        },
      });

    it.each(["unmount", "replay", "route return", "owner", "profile", "date", "sign out"] as const)(
      `${kind} retires its failed-card retry after %s`,
      async (reason) => {
        const base = fetcher();
        const logout = deferred<Response>();
        const fetch = vi.fn((url: string, init?: RequestInit) =>
          url === "/api/auth/logout" ? logout.promise : base(url, init),
        );
        let view: "overview" | "diary" = "overview";
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        expect(cardProps()[kind].status).toBe("error");
        const oldRetry = retry();
        if (reason === "unmount") hooks.unmount();
        else if (reason === "replay") {
          hooks.replayEffects();
          await hooks.settle();
        } else if (reason === "route return") {
          view = "diary";
          hooks.renderWithoutEffects();
          view = "overview";
          hooks.renderWithoutEffects();
        } else if (reason === "owner" || reason === "profile") {
          hooks.replaceVerifiedSessionBeforeEffects(
            parseSession(
              session(reason === "owner" ? anotherOwner : owner, defaultDiaryGroups, "2"),
            ),
          );
        } else if (reason === "date") invoke(button("Next day"));
        else invoke(button("Sign out"));
        const count = fetch.mock.calls.length;
        oldRetry();
        expect(fetch.mock.calls).toHaveLength(count);
        if (reason === "unmount") expect(hooks.afterClose()).toBe(0);
        if (reason === "replay") {
          retry()();
          await hooks.settle();
          expect(fetch.mock.calls.filter(([url]) => url.startsWith(endpoint))).toHaveLength(3);
        }
        if (reason === "sign out") {
          logout.resolve(Response.json({}, { status: 503 }));
          await hooks.settle();
          oldRetry();
          expect(fetch.mock.calls).toHaveLength(count);
          retry()();
          await hooks.settle();
          expect(fetch.mock.calls.filter(([url]) => url.startsWith(endpoint))).toHaveLength(2);
        }
      },
    );

    it(`${kind} retries one failure at a time and preserves a recovered card`, async () => {
      const base = fetcher();
      const pending = deferred<Response>();
      let reads = 0;
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith(endpoint)) {
          reads += 1;
          if (reads === 2) return pending.promise;
          if (reads >= 3) return Promise.resolve(emptyDay());
        }
        return base(url, init);
      });
      await mount(fetch, "overview");
      const otherKind = kind === "hydration" ? "activity" : "hydration";
      const otherCard = cardProps()[otherKind];
      const oldRetry = retry();
      oldRetry();
      const signal = fetch.mock.calls.filter(([url]) => url.startsWith(endpoint))[1]?.[1]?.signal;
      oldRetry();
      expect(reads).toBe(2);
      expect(signal?.aborted).toBe(false);
      await hooks.settle();
      expect(cardProps()[kind].status).toBe("loading");
      oldRetry();
      expect(reads).toBe(2);
      pending.resolve(
        Response.json({ error: "Summary temporarily unavailable." }, { status: 503 }),
      );
      await hooks.settle();
      expect(cardProps()[kind].status).toBe("error");
      oldRetry();
      expect(reads).toBe(2);
      const freshRetry = retry();
      freshRetry();
      await hooks.settle();
      expect(reads).toBe(3);
      expect(cardProps()[kind]).toEqual({ status: "empty", count: 0, total: 0 });
      expect(cardProps()[otherKind]).toEqual(otherCard);
      const count = fetch.mock.calls.length;
      oldRetry();
      freshRetry();
      retry()();
      expect(fetch.mock.calls).toHaveLength(count);
      for (const [url, init] of fetch.mock.calls.filter(([url]) => url.startsWith(endpoint))) {
        expect(url).toBe(endpoint + "date=2026-08-15");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        expect(new Headers(init?.headers).get("x-expected-owner-user-id")).toBe(owner);
      }
      expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(1);
      expect(router.replace).not.toHaveBeenCalled();
    });

    it(`${kind} keeps current retry session expiry`, async () => {
      const base = fetcher();
      let reads = 0;
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url.startsWith(endpoint) && ++reads > 1
          ? Promise.resolve(Response.json({}, { status: 401 }))
          : base(url, init),
      );
      await mount(fetch, "overview");
      retry()();
      await hooks.settle();
      expect(reads).toBe(2);
      expect(router.replace).toHaveBeenCalledWith("/login");
    });
  }
});

describe("Dashboard summary response route ownership", () => {
  function cards() {
    const node = elements().find((node) => node.type === TodayOverviewCards);
    if (!node) throw new Error("Missing overview cards");
    return node.props as unknown as Parameters<typeof TodayOverviewCards>[0];
  }
  async function beforeEffects() {
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    hooks.renderWithoutEffects();
  }
  for (const kind of ["hydration", "activity"] as const) {
    const endpoint = kind === "hydration" ? "/api/hydration?" : "/api/activities?";
    const day = (date = "2026-08-15") => ({
      data: {
        localDate: date,
        timeZone: "America/Chicago",
        revision: "2",
        entries: [],
        updatedAt: "2026-08-15T13:05:02.000Z",
        ...(kind === "hydration" ? { totalMilliliters: 0 } : { totalDurationMinutes: 0 }),
      },
    });
    for (const outcome of [
      "loaded",
      "failed",
      "expired",
      "decoded",
      "session expiry",
      "session decoded",
    ] as const) {
      it(`${kind} rejects old ${outcome} after a view return and recovers its summary`, async () => {
        const pending = deferred<Response>();
        const body = deferred<unknown>();
        const response =
          outcome === "expired" || outcome === "session expiry"
            ? Response.json({}, { status: 401 })
            : outcome === "failed"
              ? Response.json({ error: "Departed summary failed." }, { status: 503 })
              : Response.json(outcome === "session decoded" ? session(anotherOwner) : day());
        const decode = vi.spyOn(response, "json");
        if (outcome === "decoded" || outcome === "session decoded")
          decode.mockImplementation(() => body.promise);
        const base = fetcher();
        let reads = 0,
          sessionReads = 0;
        let view: "overview" | "diary" = "overview";
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url.startsWith(endpoint)) {
            reads += 1;
            if (reads === 1) {
              if (outcome.startsWith("session")) return Promise.resolve(Response.json(day()));
              return outcome === "decoded" ? Promise.resolve(response) : pending.promise;
            }
            return Promise.resolve(Response.json(day()));
          }
          if (url === "/api/auth/me" && ++sessionReads === 2 && outcome.startsWith("session"))
            return outcome === "session decoded" ? Promise.resolve(response) : pending.promise;
          return base(url, init);
        });
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        expect(cards()[kind].status).toBe("loading");
        const otherKind = kind === "hydration" ? "activity" : "hydration";
        const otherCard = cards()[otherKind];
        if (outcome === "decoded" || outcome === "session decoded")
          expect(decode).toHaveBeenCalledTimes(1);
        view = "diary";
        hooks.renderWithoutEffects();
        view = "overview";
        hooks.renderWithoutEffects();
        const count = fetch.mock.calls.length;
        if (outcome === "decoded") body.resolve(day());
        else if (outcome === "session decoded") body.resolve(session(anotherOwner));
        else pending.resolve(response);
        await beforeEffects();
        expect(cards()[kind].status).toBe("loading");
        expect(cards()[otherKind]).toEqual(otherCard);
        expect(fetch.mock.calls).toHaveLength(count);
        expect(router.replace).not.toHaveBeenCalled();
        if (outcome !== "decoded" && outcome !== "session decoded")
          expect(decode).not.toHaveBeenCalled();
        hooks.render();
        await hooks.settle();
        expect(cards()[kind]).toEqual({ status: "empty", count: 0, total: 0 });
        expect(cards()[otherKind]).toEqual(otherCard);
        const requests = fetch.mock.calls.filter(([url]) => url.startsWith(endpoint));
        expect(requests).toHaveLength(2);
        for (const [url, init] of requests) {
          expect(url).toBe(`${endpoint}date=2026-08-15`);
          expect(init?.cache).toBe("no-store");
          expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
            accept: "application/json",
            "x-expected-owner-user-id": owner,
          });
        }
        const otherEndpoint = kind === "hydration" ? "/api/activities?" : "/api/hydration?";
        expect(fetch.mock.calls.filter(([url]) => url.startsWith(otherEndpoint))).toHaveLength(1);
        expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/diary?"))).toHaveLength(1);
        expect(router.replace).not.toHaveBeenCalled();
      });
    }

    it(`${kind} ignores old expiry before a new route date commits`, async () => {
      const pending = deferred<Response>();
      const base = fetcher();
      let reads = 0;
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith(endpoint)) {
          if (++reads === 1) return pending.promise;
          const date = new URL(url, "https://app.example.test").searchParams.get("date");
          return Promise.resolve(Response.json(day(date ?? "")));
        }
        return base(url, init);
      });
      await mount(fetch, "overview");
      route.date = "2026-08-16";
      hooks.renderWithoutEffects();
      const count = fetch.mock.calls.length;
      pending.resolve(Response.json({}, { status: 401 }));
      await beforeEffects();
      expect(fetch.mock.calls).toHaveLength(count);
      expect(router.replace).not.toHaveBeenCalled();
      hooks.render();
      await hooks.settle();
      expect(cards().date).toBe("2026-08-16");
      expect(cards()[kind]).toEqual({ status: "empty", count: 0, total: 0 });
      expect(reads).toBe(2);
    });

    it(`${kind} preserves a completed summary across same-day view changes`, async () => {
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url.startsWith(endpoint) ? Promise.resolve(Response.json(day())) : base(url, init),
      );
      let view: "overview" | "diary" = "overview";
      vi.stubGlobal("fetch", fetch);
      hooks.mount(() => DiaryClient({ view }));
      await hooks.settle();
      expect(cards()[kind]).toEqual({ status: "empty", count: 0, total: 0 });
      const count = fetch.mock.calls.length;
      view = "diary";
      hooks.render();
      await hooks.settle();
      view = "overview";
      hooks.render();
      await hooks.settle();
      expect(cards()[kind]).toEqual({ status: "empty", count: 0, total: 0 });
      expect(fetch.mock.calls).toHaveLength(count);
    });
  }
});

describe("Diary pagination during group saves", () => {
  for (const retryPage of [false, true]) {
    it.each(["success", "failure"] as const)(
      `blocks ${retryPage ? "Retry load more" : "Load more"} until group save %s settles`,
      async (outcome) => {
        const pending = deferred<Response>();
        const first = page(
          Array.from({ length: 20 }, (_, index) => entry(index)),
          "d1.next-page",
          21,
        );
        const base = fetcher(first);
        const groups = defaultDiaryGroups.map((group) =>
          group.mealSlot === "breakfast" ? { ...group, label: "Submitted morning" } : group,
        );
        const writes: ReturnType<typeof captureEditorSave>[] = [];
        const writeRequests: RequestInit[] = [];
        const continuations: { url: string; headers: Record<string, string> }[] = [];
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url === "/api/profile") {
            if (!init) throw new Error("Missing profile request.");
            writes.push(captureEditorSave(url, init));
            writeRequests.push(init);
            return writes.length === 1
              ? pending.promise
              : Promise.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
          }
          if (url.includes("cursor=")) {
            if (!init) throw new Error("Missing continuation request.");
            continuations.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
            return Promise.resolve(
              retryPage && continuations.length === 1
                ? Response.json({ error: "Page unavailable." }, { status: 503 })
                : Response.json(page([entry(20)], null, 21)),
            );
          }
          return base(url, init);
        });
        await mount(fetch);
        if (retryPage) await click("Load more");
        const label = retryPage ? "Retry load more" : "Load more";
        await click("Customize diary groups");
        await change("Group 1 label", "Submitted morning");
        const retained = button(label);
        const submit = () => {
          const form = elements().find(
            (node) => node.type === "form" && text(node).includes("Save groups"),
          );
          if (!form) throw new Error("Missing diary settings form.");
          invoke(form, "onSubmit", { preventDefault() {} });
        };
        submit();
        expect(writes).toHaveLength(1);
        const count = fetch.mock.calls.length;
        const pageCount = continuations.length;
        const routes = router.replace.mock.calls.slice();
        invoke(retained);
        expect(fetch.mock.calls).toHaveLength(count);
        await hooks.settle();
        expect(button(label).props.disabled).toBe(true);
        expect(button(label).props["aria-disabled"]).toBe(true);
        invoke(button(label));
        await hooks.settle();
        expect(fetch.mock.calls).toHaveLength(count);
        expect(continuations).toHaveLength(pageCount);
        expect(writeRequests[0]?.signal?.aborted).not.toBe(true);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(field("Local date").props.value).toBe("2026-08-15");
        expect(field("Group 1 label").props.value).toBe("Submitted morning");
        expect(text()).toContain("20 of 21 entries loaded");
        expect(text()).not.toContain("Apple 20");
        pending.resolve(
          outcome === "success"
            ? Response.json({ data: { profile: session(owner, groups, "2").data.profile } })
            : Response.json({ error: "Save unavailable." }, { status: 503 }),
        );
        await hooks.settle();
        if (outcome === "failure") {
          expect(text()).toContain("Save unavailable.");
          expect(field("Group 1 label").props.value).toBe("Submitted morning");
          submit();
          await hooks.settle();
          expect(writes).toHaveLength(2);
          expect(writes[1]).toEqual(writes[0]);
          expect(writes[0]?.headers["if-match"]).toBe('"1"');
          expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({
            expectedOwnerUserId: owner,
            diaryGroups: groups,
          });
        } else {
          expect(text()).toContain("Diary group names and order saved everywhere you log food.");
          expect(button("Collapse Submitted morning").props["aria-expanded"]).toBe(true);
        }
        expect(button(label).props.disabled).toBe(false);
        await click(label);
        expect(continuations).toHaveLength(pageCount + 1);
        const request = continuations.at(-1);
        expect(request?.url).toBe("/api/diary?date=2026-08-15&limit=20&cursor=d1.next-page");
        expect(request?.headers).toEqual({ accept: "application/json" });
        if (retryPage) expect(request).toEqual(continuations[0]);
        expect(text()).toContain("21 of 21 entries loaded");
        expect(text()).toContain("Apple 20");
        expect(router.replace.mock.calls).toEqual(routes);
      },
    );
  }
});

describe("Diary pagination route admission", () => {
  for (const retryPage of [false, true]) {
    it.each(["view replacement", "view return before effects", "view return after effects"])(
      `retires ${retryPage ? "Retry load more" : "Load more"} on %s`,
      async (transition) => {
        const first = page(
          Array.from({ length: 20 }, (_, index) => entry(index)),
          "d1.next-page",
          21,
        );
        const base = fetcher(first);
        const continuations: {
          url: string;
          cache: RequestCache | undefined;
          headers: Record<string, string>;
        }[] = [];
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url.includes("cursor=")) {
            continuations.push({
              url,
              cache: init?.cache,
              headers: Object.fromEntries(new Headers(init?.headers)),
            });
            return Promise.resolve(
              retryPage && continuations.length === 1
                ? Response.json({ error: "Page unavailable." }, { status: 503 })
                : Response.json(page([entry(20)], null, 21)),
            );
          }
          return base(url, init);
        });
        let view: "diary" | "overview" = "diary";
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        if (retryPage) await click("Load more");
        const label = retryPage ? "Retry load more" : "Load more";
        const retained = button(label);
        view = "overview";
        hooks.renderWithoutEffects();
        if (transition !== "view replacement") {
          view = "diary";
          hooks.renderWithoutEffects();
        }
        if (transition === "view return after effects") {
          hooks.render();
          await hooks.settle();
        }
        const count = fetch.mock.calls.length;
        const before = text();
        const routes = router.replace.mock.calls.slice();
        invoke(retained);
        for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
        hooks.renderWithoutEffects();
        expect(fetch.mock.calls).toHaveLength(count);
        expect(text()).toBe(before);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(continuations).toHaveLength(retryPage ? 1 : 0);
        view = "diary";
        hooks.render();
        await hooks.settle();
        expect(text()).toContain("20 of 21 entries loaded");
        expect(text()).not.toContain("Apple 20");
        expect(button(label).props.disabled).toBe(false);
        await click(label);
        expect(continuations).toHaveLength(retryPage ? 2 : 1);
        expect(continuations.at(-1)).toEqual({
          url: "/api/diary?date=2026-08-15&limit=20&cursor=d1.next-page",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (retryPage) expect(continuations[1]).toEqual(continuations[0]);
        expect(text()).toContain("21 of 21 entries loaded");
        expect(text()).toContain("Apple 20");
        expect(router.replace.mock.calls).toEqual(routes);
      },
    );
  }
});

describe("Diary pagination response route ownership", () => {
  for (const timing of ["before effects", "during a new continuation"] as const) {
    it.each(["loaded", "failed", "expired", "decoded", "stale", "rejected"])(
      `ignores an old %s continuation after a same-day view return ${timing}`,
      async (kind) => {
        const first = page(
          Array.from({ length: 20 }, (_, index) => entry(index)),
          "d1.next-page",
          21,
        );
        const base = fetcher(first);
        const pending = deferred<Response>();
        const fresh = deferred<Response>();
        const body = deferred<ReturnType<typeof page>>();
        const response =
          kind === "loaded" || kind === "decoded"
            ? Response.json(page([entry(20)], null, 21))
            : Response.json(
                kind === "stale"
                  ? { code: "DIARY_PAGE_STALE" }
                  : { error: "Departed continuation unavailable." },
                { status: kind === "expired" ? 401 : kind === "stale" ? 409 : 503 },
              );
        const decode = vi.spyOn(response, "json");
        if (kind === "decoded") decode.mockImplementation(() => body.promise);
        const continuations: {
          url: string;
          cache: RequestCache | undefined;
          headers: Record<string, string>;
        }[] = [];
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url.includes("cursor=")) {
            continuations.push({
              url,
              cache: init?.cache,
              headers: Object.fromEntries(new Headers(init?.headers)),
            });
            return continuations.length === 1
              ? kind === "decoded"
                ? Promise.resolve(response)
                : pending.promise.then((value) => {
                    if (kind === "rejected") throw new TypeError("Departed continuation offline.");
                    return value;
                  })
              : fresh.promise;
          }
          return base(url, init);
        });
        let view: "diary" | "overview" = "diary";
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        invoke(button("Load more"));
        await hooks.settle();
        if (kind === "decoded") expect(decode).toHaveBeenCalledTimes(1);
        view = "overview";
        hooks.renderWithoutEffects();
        view = "diary";
        hooks.renderWithoutEffects();
        const dayReads = () =>
          fetch.mock.calls.filter(
            ([url]) => url.startsWith("/api/diary?") && !url.includes("cursor="),
          );
        if (timing === "during a new continuation") {
          hooks.render();
          await hooks.settle();
          expect(text()).toContain("20 of 21 entries loaded");
          expect(text()).not.toContain("Apple 20");
          expect(button("Load more").props.disabled).toBe(false);
          expect(continuations).toHaveLength(1);
          expect(dayReads()).toHaveLength(1);
          invoke(button("Load more"));
          await hooks.settle();
          expect(continuations).toHaveLength(2);
        }
        const before = text(),
          requests = fetch.mock.calls.length,
          routes = router.replace.mock.calls.slice();
        if (kind === "decoded") body.resolve(page([entry(20)], null, 21));
        else pending.resolve(response);
        for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
        hooks.renderWithoutEffects();
        expect(text()).toBe(before);
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(router.replace.mock.calls).toEqual(routes);
        if (kind !== "decoded") expect(decode).not.toHaveBeenCalled();
        hooks.render();
        await hooks.settle();
        if (timing === "before effects") {
          expect(text()).toContain("20 of 21 entries loaded");
          expect(button("Load more").props.disabled).toBe(false);
          expect(continuations).toHaveLength(1);
          invoke(button("Load more"));
          await hooks.settle();
        }
        expect(continuations).toHaveLength(2);
        expect(button("Loading more…").props.disabled).toBe(true);
        expect(continuations[1]).toEqual(continuations[0]);
        expect(continuations[1]).toEqual({
          url: "/api/diary?date=2026-08-15&limit=20&cursor=d1.next-page",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        fresh.resolve(Response.json(page([entry(20)], null, 21)));
        await hooks.settle();
        expect(text()).toContain("21 of 21 entries loaded");
        expect(text()).toContain("Apple 20");
        expect(dayReads()).toHaveLength(1);
        expect(router.replace.mock.calls).toEqual(routes);
      },
    );
  }
});

describe("Diary group control route ownership", () => {
  function form() {
    const node = elements().find(
      (candidate) =>
        candidate.type === "form" &&
        elements(candidate).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!node) throw new Error("Missing group settings form.");
    return node;
  }
  function draft() {
    return elements()
      .filter((node) => node.type === "input" && String(node.props.id).startsWith("diary-group-"))
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  const actions = [
    "open",
    "rename",
    "Move group 2 up",
    "Move group 1 down",
    "Reset defaults",
    "Cancel",
    "Close diary group settings",
    "save",
  ];
  for (const transition of [
    "view replacement",
    "view return before effects",
    "view return after effects",
  ]) {
    it.each(actions)(
      `retires retained %s after ${transition} while fresh settings remain usable`,
      async (action) => {
        const base = fetcher();
        const groups = defaultDiaryGroups.map((group) =>
          group.mealSlot === "breakfast" ? { ...group, label: "Fresh morning" } : group,
        );
        const writes: RequestInit[] = [];
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url === "/api/profile") {
            if (!init) throw new Error("Missing profile request.");
            writes.push(init);
            return Promise.resolve(
              writes.length === 1
                ? Response.json({ error: "Save unavailable." }, { status: 503 })
                : Response.json({ data: { profile: session(owner, groups, "2").data.profile } }),
            );
          }
          return base(url, init);
        });
        let view: "diary" | "overview" = "diary";
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        const opening = button("Customize diary groups");
        await click("Customize diary groups");
        await change("Group 1 label", "My morning");
        const expectedDraft = draft();
        const retained =
          action === "open"
            ? opening
            : action === "rename"
              ? field("Group 1 label")
              : action === "save"
                ? form()
                : button(action);
        view = "overview";
        hooks.renderWithoutEffects();
        if (transition !== "view replacement") {
          view = "diary";
          hooks.renderWithoutEffects();
        }
        if (transition === "view return after effects") {
          hooks.render();
          await hooks.settle();
        }
        const before = text(),
          requests = fetch.mock.calls.length,
          routes = router.replace.mock.calls.slice();
        if (action === "rename")
          invoke(retained, "onChange", { target: { value: "Retired label" } });
        else if (action === "save") invoke(retained, "onSubmit", { preventDefault() {} });
        else invoke(retained);
        for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
        hooks.renderWithoutEffects();
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(text()).toBe(before);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(writes).toHaveLength(0);
        view = "diary";
        hooks.render();
        await hooks.settle();
        expect(draft()).toEqual(expectedDraft);
        await click("Move group 1 down");
        expect(draft()[1]?.id).toBe("diary-group-breakfast");
        expect(draft()[1]?.value).toBe("My morning");
        await click("Move group 2 up");
        expect(draft()).toEqual(expectedDraft);
        await click("Reset defaults");
        expect(field("Group 1 label").props.value).toBe("Breakfast");
        await click("Cancel");
        expect(draft()).toEqual([]);
        await click("Customize diary groups");
        await change("Group 1 label", "Fresh morning");
        expect(button("Save groups").props.disabled).toBe(false);
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(text()).toContain("Save unavailable.");
        expect(field("Group 1 label").props.value).toBe("Fresh morning");
        expect(button("Save groups").props.disabled).toBe(false);
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(writes).toHaveLength(2);
        expect(writes[0]?.method).toBe("PATCH");
        expect(writes[0]?.cache).toBe("no-store");
        expect(writes[0]?.body).toBe(
          JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: groups }),
        );
        expect(writes[1]?.body).toBe(writes[0]?.body);
        expect(Object.fromEntries(new Headers(writes[0]?.headers))).toEqual({
          accept: "application/json",
          "content-type": "application/json",
          "if-match": '"1"',
        });
        expect(Object.fromEntries(new Headers(writes[1]?.headers))).toEqual(
          Object.fromEntries(new Headers(writes[0]?.headers)),
        );
        expect(text()).toContain("Diary group names and order saved everywhere you log food.");
        expect(router.replace.mock.calls).toEqual(routes);
      },
    );
  }
});

describe("Diary group save response route ownership", () => {
  function form() {
    const node = elements().find(
      (candidate) =>
        candidate.type === "form" &&
        elements(candidate).some((child) => child.props.id === "diary-group-breakfast"),
    );
    if (!node) throw new Error("Missing group settings form.");
    return node;
  }
  function draft() {
    return elements()
      .filter((node) => node.type === "input" && String(node.props.id).startsWith("diary-group-"))
      .map((node) => ({ id: node.props.id, value: node.props.value }));
  }
  const outcomes = [
    "success",
    "failure",
    "expired",
    "owner changed",
    "conflict",
    "network rejection",
    "decoded profile",
    "refreshed session",
    "refresh expired",
    "decoded session",
  ] as const;
  for (const transition of [
    "view replacement",
    "same-day return before effects",
    "same-day return after effects",
  ] as const) {
    it.each(outcomes)(
      `ignores late %s after ${transition} and releases only the existing save lock`,
      async (outcome) => {
        const pending = deferred<Response>();
        const decoded = deferred<unknown>();
        const base = fetcher();
        const groups = moveDiaryGroup(
          defaultDiaryGroups.map((group) =>
            group.mealSlot === "breakfast" ? { ...group, label: "My morning" } : group,
          ),
          0,
          1,
        );
        const saved = { data: { profile: session(owner, groups, "2").data.profile } };
        const writes: RequestInit[] = [];
        let sessionReads = 0;
        const recovering = ["refreshed session", "refresh expired", "decoded session"].includes(
          outcome,
        );
        const fetch = vi.fn((url: string, init?: RequestInit) => {
          if (url === "/api/profile") {
            if (!init) throw new Error("Missing profile request.");
            writes.push(init);
            if (writes.length > 1)
              return Promise.resolve(
                writes.length === 2
                  ? Response.json({ error: "Fresh save unavailable." }, { status: 503 })
                  : Response.json(saved),
              );
            if (recovering) return Promise.resolve(Response.json({}, { status: 412 }));
            if (outcome === "decoded profile") {
              const response = Response.json(saved);
              vi.spyOn(response, "json").mockReturnValue(decoded.promise);
              return Promise.resolve(response);
            }
            if (outcome === "network rejection")
              return pending.promise.then(() => {
                throw new Error("Retired network failure.");
              });
            return pending.promise;
          }
          if (url === "/api/auth/me") {
            sessionReads += 1;
            if (recovering && sessionReads > 1) {
              if (outcome === "decoded session") {
                const response = Response.json(session());
                vi.spyOn(response, "json").mockReturnValue(decoded.promise);
                return Promise.resolve(response);
              }
              return pending.promise;
            }
          }
          return base(url, init);
        });
        let view: "diary" | "overview" = "diary";
        vi.stubGlobal("fetch", fetch);
        hooks.mount(() => DiaryClient({ view }));
        await hooks.settle();
        await click("Customize diary groups");
        await change("Group 1 label", "My morning");
        await click("Move group 1 down");
        const expectedDraft = draft();
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(writes).toHaveLength(1);
        expect(button("Saving…").props.disabled).toBe(true);
        expect(sessionReads).toBe(recovering ? 2 : 1);
        view = "overview";
        hooks.renderWithoutEffects();
        if (transition !== "view replacement") {
          view = "diary";
          hooks.renderWithoutEffects();
        }
        if (transition === "same-day return after effects") {
          hooks.render();
          await hooks.settle();
        }
        const requests = fetch.mock.calls.length;
        const routes = router.replace.mock.calls.slice();
        expect(writes[0]?.signal?.aborted).toBe(false);
        if (transition !== "view replacement") {
          expect(button("Saving…").props.disabled).toBe(true);
          invoke(form(), "onSubmit", { preventDefault() {} });
          expect(writes).toHaveLength(1);
        }
        if (outcome === "decoded profile") decoded.resolve(saved);
        else if (outcome === "decoded session") decoded.resolve(session(anotherOwner));
        else
          pending.resolve(
            outcome === "success"
              ? Response.json(saved)
              : outcome === "refreshed session"
                ? Response.json(session(owner, defaultDiaryGroups, "2"))
                : outcome === "expired" || outcome === "refresh expired"
                  ? new Response(null, { status: 401 })
                  : outcome === "owner changed"
                    ? Response.json({ code: "PROFILE_OWNER_CHANGED" }, { status: 409 })
                    : outcome === "conflict"
                      ? Response.json({}, { status: 412 })
                      : Response.json({ error: "Retired save failure." }, { status: 503 }),
          );
        for (let pass = 0; pass < 30; pass += 1) await Promise.resolve();
        hooks.renderWithoutEffects();
        expect(fetch.mock.calls).toHaveLength(requests);
        expect(router.replace.mock.calls).toEqual(routes);
        expect(text()).not.toContain("Retired save failure.");
        expect(text()).not.toContain("Retired network failure.");
        expect(text()).not.toContain("Diary group names and order saved everywhere");
        expect(text()).not.toContain("Fresh diary group settings were loaded.");
        expect(writes[0]?.signal?.aborted).toBe(false);
        view = "diary";
        hooks.render();
        await hooks.settle();
        expect(draft()).toEqual(expectedDraft);
        expect(button("Collapse Breakfast").props["aria-expanded"]).toBe(true);
        expect(button("Save groups").props.disabled).toBe(false);
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(text()).toContain("Fresh save unavailable.");
        expect(draft()).toEqual(expectedDraft);
        expect(button("Save groups").props.disabled).toBe(false);
        invoke(form(), "onSubmit", { preventDefault() {} });
        await hooks.settle();
        expect(writes).toHaveLength(3);
        for (const write of writes) {
          expect(write.method).toBe("PATCH");
          expect(write.cache).toBe("no-store");
          expect(write.body).toBe(
            JSON.stringify({ expectedOwnerUserId: owner, diaryGroups: groups }),
          );
          expect(Object.fromEntries(new Headers(write.headers))).toEqual({
            accept: "application/json",
            "content-type": "application/json",
            "if-match": '"1"',
          });
        }
        expect(button("Collapse My morning").props["aria-expanded"]).toBe(true);
        expect(text()).toContain("Diary group names and order saved everywhere you log food.");
      },
    );
  }
});
