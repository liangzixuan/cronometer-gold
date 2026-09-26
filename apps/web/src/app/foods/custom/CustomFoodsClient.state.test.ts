import { afterEach, describe, expect, it, vi } from "vitest";

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
    renderWithoutEffects: () => render(false),
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
const navigation = vi.hoisted(() => ({ search: "" }));
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
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import type { CustomFood } from "../../../lib/retention";
import { CustomFoodsClient } from "./CustomFoodsClient";

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
function button(label: string, within: unknown = hooks.tree()): ElementNode {
  const found = elements(within).find(
    (node) =>
      node.type === "button" && (text(node) === label || node.props["aria-label"] === label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function field(label: string): ElementNode {
  const labelled = elements().find((node) => node.type === "label" && text(node).trim() === label);
  const found =
    elements().find(
      (node) =>
        ["input", "select", "textarea"].includes(String(node.type)) &&
        node.props["aria-label"] === label,
    ) ??
    (labelled &&
      elements(labelled).find((node) =>
        ["input", "select", "textarea"].includes(String(node.type)),
      ));
  if (!found) throw new Error(`Missing field: ${label}`);
  return found;
}
function invoke(node: ElementNode, action: string, ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string, within: unknown = hooks.tree()) {
  const node = button(label, within);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node, "onClick");
  await hooks.settle();
}
async function change(label: string, value: string) {
  invoke(field(label), "onChange", { target: { value } });
  await hooks.settle();
}
async function submit(label: string) {
  const form = elements().find((node) => node.type === "form" && text(node).includes(label));
  if (!form) throw new Error(`Missing form: ${label}`);
  invoke(form, "onSubmit", { preventDefault() {} });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const otherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
const instant = "2026-09-10T12:00:00.000Z";
const longAmount = `0.${"1".repeat(198)}`;
function food(index = 1): CustomFood {
  return {
    id: `3bcfa2bf-4950-43f7-9f24-${String(index).padStart(12, "0")}`,
    status: "active",
    revision: "1",
    currentVersion: {
      id: String(9007199254740993n + BigInt(index)),
      versionNumber: 1,
      name: `Saved food ${index}`,
      brandName: null,
      notes: "saved notes",
      serving: { id: String(index), label: "Saved portion", grams: "125.25" },
      nutrients: [
        {
          nutrient: { id: "2", code: "protein", name: "Snapshot protein", unit: "g" },
          state: "quantified",
          amountPer100Grams: "12.375",
        },
      ],
      provenance: { kind: "user_entered", statement: "Entered by account owner." },
      createdAt: instant,
    },
    createdAt: instant,
    updatedAt: instant,
  };
}
function allStates(): CustomFood {
  const base = food();
  return {
    ...base,
    currentVersion: {
      ...base.currentVersion,
      nutrients: [
        {
          nutrient: { id: "1", code: "energy", name: "Saved Energy", unit: "kcal" },
          state: "quantified",
          amountPer100Grams: longAmount,
        },
        {
          nutrient: { id: "3", code: "zero", name: "Duplicate name", unit: "g" },
          state: "quantified",
          amountPer100Grams: "0",
        },
        {
          nutrient: { id: "4", code: "manual", name: "Duplicate name", unit: "mg" },
          state: "trace",
          amountPer100Grams: null,
        },
        ...(["not_reported", "not_analyzed", "not_applicable", "withheld"] as const).map(
          (reason, index) => ({
            nutrient: {
              id: String(index + 10),
              code: `unknown_${index}`,
              name: `Saved ${reason}`,
              unit: "µg",
            },
            state: "unknown" as const,
            amountPer100Grams: null,
            reason,
          }),
        ),
      ],
    },
  };
}
function session(id = owner, timeZone = "America/Chicago") {
  return Response.json({
    data: {
      user: { id, email: `${id}@example.test`, emailVerified: true },
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
        revision: "1",
      },
    },
  });
}
function page(items: readonly CustomFood[], nextCursor: string | null = null) {
  return Response.json({ data: items, page: { nextCursor } });
}
function receipt(saved: CustomFood) {
  return Response.json({ data: { replayed: false, customFood: saved } });
}
function card(item: CustomFood) {
  const id = `saved-food-nutrients-${item.id}-${item.currentVersion.id}`;
  const found = elements().find(
    (node) => node.type === "li" && elements(node).some((child) => child.props.id === id),
  );
  if (!found) throw new Error(`Missing card: ${item.id}`);
  return found;
}
function details(item: CustomFood) {
  const found = elements(card(item)).find(
    (node) => node.props.id === `saved-food-nutrients-${item.id}-${item.currentVersion.id}`,
  );
  if (!found) throw new Error("Missing details.");
  return found;
}
function disclosure(item: CustomFood) {
  return elements(card(item)).find(
    (node) => node.type === "button" && "aria-expanded" in node.props,
  ) as ElementNode;
}
async function toggle(item: CustomFood) {
  const node = disclosure(item);
  expect(node.props.disabled).toBe(false);
  invoke(node, "onClick");
  await hooks.settle();
}
function workspace(
  initial: readonly CustomFood[] = [allStates(), { ...food(2), status: "archived" }],
) {
  const state = {
    items: initial,
    picker: [] as readonly unknown[],
    auth: null as null | (() => Response | Promise<Response>),
    cursor: null as string | null,
    owner,
    timeZone: "America/Chicago",
    sectionRead: null as null | ((url: string) => Response | Promise<Response> | undefined),
    read: null as null | (() => Response | Promise<Response>),
    continuation: null as null | (() => Response | Promise<Response>),
    write: null as null | ((url: string, init: RequestInit) => Response | Promise<Response>),
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/auth/me")
      return state.auth ? state.auth() : session(state.owner, state.timeZone);
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    if (init?.method && init.method !== "GET") {
      if (!state.write) throw new Error(`Unexpected write: ${url}`);
      return state.write(url, init);
    }
    const sectionResult = state.sectionRead?.(url);
    if (sectionResult !== undefined) return sectionResult;
    if (url === "/api/retention/custom-foods?limit=50")
      return state.read ? state.read() : page(state.items, state.cursor);
    if (url.startsWith("/api/retention/custom-foods?limit=50&cursor=")) {
      if (!state.continuation) throw new Error("Unexpected continuation.");
      return state.continuation();
    }
    if (url === "/api/nutrients/targetable") return Response.json({ data: state.picker });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    state,
    fetcher,
    writes: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "DELETE"),
  };
}
async function mount() {
  hooks.mount(CustomFoodsClient);
  await hooks.settle();
}
function formValues() {
  return elements()
    .filter((node) => ["input", "select", "textarea"].includes(String(node.type)))
    .map((node) => ({ type: node.type, label: node.props["aria-label"], value: node.props.value }));
}
function status() {
  return text(elements().find((node) => node.props.role === "status"));
}
function visibility() {
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: "visible",
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  vi.stubGlobal("document", document);
  return {
    document,
    async set(value: string) {
      document.visibilityState = value;
      listeners.get("visibilitychange")?.();
      await hooks.settle();
    },
  };
}
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  navigation.search = "";
});

describe("actual saved custom-food nutrient disclosures", () => {
  it("shows saved metadata, compact amounts, every state and original order without requests", async () => {
    const first = allStates();
    const archived = { ...food(2), status: "archived" as const };
    const { fetcher } = workspace([first, archived]);
    await mount();
    expect(details(first).props.hidden).toBe(true);
    expect(details(archived).props.hidden).toBe(true);
    const requests = fetcher.mock.calls.length;
    await toggle(first);
    await toggle(archived);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(disclosure(first).props["aria-expanded"]).toBe(true);
    expect(disclosure(first).props["aria-controls"]).toBe(details(first).props.id);
    expect(disclosure(first).props.type).toBe("button");
    expect(text(details(first))).toContain("Saved Saved food 1 v1 · Nutrients per 100 g");
    expect(
      elements(details(first))
        .filter((node) => node.type === "dt")
        .map(text),
    ).toEqual(
      first.currentVersion.nutrients.map((row) => `${row.nutrient.name} (${row.nutrient.unit})`),
    );
    expect(
      elements(details(first))
        .filter((node) => node.type === "dd")
        .map(text),
    ).toEqual([
      "<1 kcal",
      "0 g",
      "Trace",
      "Unknown — Not reported",
      "Unknown — Not analyzed",
      "Unknown — Not applicable",
      "Unknown — Withheld",
    ]);
    await toggle(first);
    expect(details(first).props.hidden).toBe(true);
    expect(details(archived).props.hidden).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each([
    ["kcal", "1234.5", "1,235 kcal"],
    ["g", "12.375", "12.4 g"],
    ["mg", "0.00001", "<0.1 mg"],
  ])(
    "formats saved %s amounts while preserving their exact revision input",
    async (unit, amount, expected) => {
      const base = food();
      const first: CustomFood = {
        ...base,
        currentVersion: {
          ...base.currentVersion,
          nutrients: [
            {
              nutrient: { id: "2", code: "protein", name: "Saved nutrient", unit },
              state: "quantified",
              amountPer100Grams: amount,
            },
          ],
        },
      };
      workspace([first]);
      await mount();
      await toggle(first);
      expect(
        elements(details(first))
          .filter((node) => node.type === "dd")
          .map(text),
      ).toEqual([expected]);
      await click("Revise", card(first));
      expect(field("Amount per 100 grams 1").props.value).toBe(amount);
    },
  );

  it("renders all 256 saved rows, including repeated names and compact long decimals", async () => {
    const initial = food();
    const maximum = {
      ...initial,
      currentVersion: {
        ...initial.currentVersion,
        name: "N".repeat(500),
        nutrients: Array.from({ length: 256 }, (_, index) => ({
          nutrient: {
            id: String(index + 1),
            code: `nutrient_${index}`,
            name: "Repeated snapshot name",
            unit: "u".repeat(32),
          },
          state: "quantified" as const,
          amountPer100Grams: longAmount,
        })),
      },
    };
    workspace([maximum]);
    await mount();
    await toggle(maximum);
    expect(elements(details(maximum)).filter((node) => node.type === "dt")).toHaveLength(256);
    expect(
      elements(details(maximum))
        .filter((node) => node.type === "dd")
        .map(text),
    ).toEqual(Array(256).fill(`0.1 ${"u".repeat(32)}`));
    expect(text(details(maximum))).toContain(maximum.currentVersion.name);
  });

  it("rejects old and duplicate toggle callbacks while keeping other cards independent", async () => {
    const first = food();
    const second = food(2);
    const { fetcher } = workspace([first, second]);
    await mount();
    const oldShow = disclosure(first);
    const secondShow = disclosure(second);
    invoke(oldShow, "onClick");
    invoke(oldShow, "onClick");
    invoke(secondShow, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(false);
    expect(details(second).props.hidden).toBe(false);
    const oldHide = disclosure(first);
    await toggle(first);
    invoke(oldShow, "onClick");
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    await toggle(first);
    expect(details(first).props.hidden).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("preserves independent revision and pinned log drafts and shared feedback", async () => {
    const first = food();
    const second = food(2);
    workspace([first, second]);
    await mount();
    await click("Revise", card(first));
    await change("Name", " Unsaved revision ");
    await change("Brand (optional)", "Draft brand");
    await click("Log pinned v1", card(second));
    await change("Exact quantity", "2.375");
    await change("Local date", "2026-09-09");
    await change("Local time", "13:14");
    const before = formValues();
    const beforeMessage = status();
    await toggle(first);
    await toggle(second);
    await toggle(first);
    expect(formValues()).toEqual(before);
    expect(status()).toBe(beforeMessage);
  });

  it("preserves an unresolved revision body/key and allows details during the pending write", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    await mount();
    await click("Revise", card(first));
    await change("Name", "Draft revision");
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Save new version");
    const during = formValues();
    await toggle(first);
    expect(button("Saving…").props.disabled).toBe(true);
    expect(formValues()).toEqual(during);
    pending.resolve(Response.json({ error: "Response unavailable" }, { status: 503 }));
    await hooks.settle();
    const failedMessage = status();
    await toggle(first);
    await toggle(first);
    expect(status()).toBe(failedMessage);
    state.write = () => Response.json({ error: "Still unavailable" }, { status: 503 });
    await submit("Save new version");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBe('"1"');
  });

  it("keeps open unchanged rows through pending, failed and overlapping continuation", async () => {
    const first = food();
    const second = food(2);
    const { state, fetcher } = workspace([first]);
    state.cursor = "next-page";
    await mount();
    await toggle(first);
    const pending = deferred<Response>();
    state.continuation = () => pending.promise;
    await click("Load more private foods");
    expect(details(first).props.hidden).toBe(false);
    await toggle(first);
    await toggle(first);
    pending.resolve(Response.json({ error: "Page unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(details(first).props.hidden).toBe(false);
    state.continuation = () => page([{ ...first }, second]);
    await click("Load more private foods");
    expect(details(first).props.hidden).toBe(false);
    expect(details(second).props.hidden).toBe(true);
    expect(
      elements().filter((node) => node.type === "button" && "aria-expanded" in node.props),
    ).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("cursor=")).map(([url]) => url),
    ).toEqual(Array(2).fill("/api/retention/custom-foods?limit=50&cursor=next-page"));
  });

  it("closes immediately on full refresh and preserves metadata with an intentionally empty draft", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await change("Name", " Empty-picker draft ");
    await change("Brand (optional)", "Brand");
    await toggle(first);
    const oldHide = disclosure(first);
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    hooks.replayEffects();
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    expect(disclosure(first).props.disabled).toBe(true);
    invoke(oldHide, "onClick");
    pending.resolve(page([first]));
    await hooks.settle();
    expect(field("Name").props.value).toBe(" Empty-picker draft ");
    expect(field("Brand (optional)").props.value).toBe("Brand");
    expect(details(first).props.hidden).toBe(true);
    expect(disclosure(first).props.disabled).toBe(false);
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    await toggle(first);
    expect(details(first).props.hidden).toBe(false);
  });

  it("starts accepted replacement versions closed and never revives old controls", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await toggle(first);
    const stale = disclosure(first);
    await click("Revise", card(first));
    const replacement = {
      ...first,
      revision: "2",
      currentVersion: {
        ...first.currentVersion,
        id: "9007199254741999",
        versionNumber: 2,
        name: "Replacement",
      },
    };
    state.write = () => receipt(replacement);
    await submit("Save new version");
    expect(details(replacement).props.hidden).toBe(true);
    invoke(stale, "onClick");
    await hooks.settle();
    expect(details(replacement).props.hidden).toBe(true);
    await toggle(replacement);
    expect(text(details(replacement))).toContain("Saved Replacement v2");
  });

  it("closes background disclosures and rejects callbacks even before the visibility event", async () => {
    const view = visibility();
    const first = food();
    const { fetcher } = workspace([first]);
    await mount();
    const before = fetcher.mock.calls.length;
    const oldShow = disclosure(first);
    view.document.visibilityState = "hidden";
    invoke(oldShow, "onClick");
    hooks.renderWithoutEffects();
    expect(savedCards()).toHaveLength(0);
    await view.set("visible");
    await toggle(first);
    const oldHide = disclosure(first);
    await view.set("hidden");
    expect(savedCards()).toHaveLength(0);
    await view.set("visible");
    invoke(oldShow, "onClick");
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    await toggle(first);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it("closes expired private data and rejects delayed save installs and retained controls", async () => {
    const first = food();
    const { state } = workspace([first]);
    state.cursor = "next";
    await mount();
    await click("Revise", card(first));
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Save new version");
    await toggle(first);
    const oldHide = disclosure(first);
    state.continuation = () => Response.json({ error: "Expired" }, { status: 401 });
    await click("Load more private foods");
    expect(router.replace).toHaveBeenCalledWith("/login");
    pending.resolve(receipt(first));
    await hooks.settle();
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(
      elements().filter((node) => node.type === "button" && "aria-expanded" in node.props),
    ).toHaveLength(0);
    expect(text()).not.toContain("Saved food 1");
  });

  it("rejects an owner replacement during page revalidation", async () => {
    const first = food();
    const { state } = workspace([first]);
    state.cursor = "next";
    await mount();
    await toggle(first);
    const old = disclosure(first);
    state.continuation = () => {
      state.owner = otherOwner;
      return page([food(2)]);
    };
    await click("Load more private foods");
    invoke(old, "onClick");
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(
      elements().filter((node) => node.type === "button" && "aria-expanded" in node.props),
    ).toHaveLength(0);
  });

  it("rejects retained controls after unmount without scheduling state or requests", async () => {
    const first = food();
    const { fetcher } = workspace([first]);
    await mount();
    await toggle(first);
    const old = disclosure(first);
    const requests = fetcher.mock.calls.length;
    hooks.unmount();
    const updates = hooks.afterClose();
    invoke(old, "onClick");
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });
  it("keeps failed lifecycle refresh details unavailable and uses existing Retry without changing drafts", async () => {
    const first = food();
    const { state, fetcher } = workspace([first]);
    await mount();
    await click("Revise", card(first));
    await change("Name", " Revision remains ");
    await click("Remove nutrient 1");
    await click("Log pinned v1", card(first));
    await change("Exact quantity", "7.5");
    const before = formValues();
    await toggle(first);
    const oldShow = disclosure(first);
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    const readCount = fetcher.mock.calls.filter(
      ([url]) => url === "/api/retention/custom-foods?limit=50",
    ).length;
    hooks.replayEffects();
    invoke(oldShow, "onClick");
    await hooks.settle();
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/api/retention/custom-foods?limit=50"),
    ).toHaveLength(readCount + 1);
    pending.resolve(Response.json({ error: "Refresh unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    expect(disclosure(first).props.disabled).toBe(true);
    expect(status()).toBe("Refresh unavailable");
    expect(formValues()).toEqual(before);
    invoke(disclosure(first), "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    state.read = () => page([first]);
    await click("Retry private data");
    expect(formValues()).toEqual(before);
    expect(details(first).props.hidden).toBe(true);
    const after = fetcher.mock.calls.length;
    invoke(oldShow, "onClick");
    await hooks.settle();
    expect(fetcher).toHaveBeenCalledTimes(after);
    await toggle(first);
  });

  it("preserves a new create draft and exact ambiguous retry across disclosures", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    state.picker = [
      { id: "2", code: "protein", name: "Picker protein", unit: "g", category: "macronutrient" },
    ];
    await mount();
    await change("Name", "New private draft");
    await change("Amount per 100 grams 1", "0.125");
    state.write = () => Response.json({ error: "Unknown receipt" }, { status: 503 });
    await submit("Create private food");
    const before = formValues();
    const message = status();
    await toggle(first);
    await toggle(first);
    expect(formValues()).toEqual(before);
    expect(status()).toBe(message);
    await submit("Create private food");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[0]).toBe("/api/retention/custom-foods");
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    const headers = new Headers(writes()[0]?.[1]?.headers);
    expect(headers.has("if-match")).toBe(false);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      headers.get("idempotency-key"),
    );
  });

  it("preserves pinned logging body, key, date and time through a pending and ambiguous write", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    await mount();
    await click("Log pinned v1", card(first));
    await change("Exact quantity", "3.125");
    await change("Local date", "2026-09-09");
    await change("Local time", "13:14");
    const before = formValues();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Log exact version");
    await toggle(first);
    expect(button("Log exact version").props.disabled).toBe(true);
    expect(formValues()).toEqual(before);
    pending.resolve(Response.json({ error: "Lost log response" }, { status: 503 }));
    await hooks.settle();
    await toggle(first);
    state.write = () => Response.json({ error: "Still lost" }, { status: 503 });
    await submit("Log exact version");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({
      customFoodVersionId: first.currentVersion.id,
      portion: { kind: "serving", servingId: "1", amount: "3.125" },
      mealSlot: "snacks",
      occurredAt: "2026-09-09T18:14:00.000Z",
    });
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
  });

  it("closes profile re-verification details before paint and retains the existing date-review flow", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await click("Log pinned v1", card(first));
    await change("Exact quantity", "2");
    await toggle(first);
    const oldHide = disclosure(first);
    const pending = deferred<Response>();
    state.auth = () => pending.promise;
    state.write = () =>
      Response.json({ error: "Zone changed", code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
    await submit("Log exact version");
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(savedCards()).toHaveLength(0);
    pending.resolve(session(owner, "America/New_York"));
    await hooks.settle();
    expect(field("Exact quantity").props.value).toBe("2");
    expect(button("Log exact version").props.disabled).toBe(true);
    invoke(oldHide, "onClick");
    await hooks.settle();
    expect(details(first).props.hidden).toBe(true);
    await toggle(first);
    expect(text()).toContain("America/New_York");
  });

  it("rejects delayed old save and continuation installs after a lifecycle replacement", async () => {
    const first = food();
    const { state } = workspace([first]);
    state.cursor = "next";
    await mount();
    const pendingSave = deferred<Response>();
    const pendingPage = deferred<Response>();
    state.write = () => pendingSave.promise;
    state.continuation = () => pendingPage.promise;
    await click("Revise", card(first));
    await submit("Save new version");
    await click("Load more private foods");
    const fresh = {
      ...food(2),
      currentVersion: { ...food(2).currentVersion, name: "Fresh installation" },
    };
    state.read = () => page([fresh]);
    hooks.replayEffects();
    await hooks.settle();
    await toggle(fresh);
    pendingSave.resolve(receipt(first));
    pendingPage.resolve(page([food(3)]));
    await hooks.settle();
    expect(
      elements().filter((node) => node.type === "button" && "aria-expanded" in node.props),
    ).toHaveLength(1);
    expect(details(fresh).props.hidden).toBe(false);
    expect(text()).not.toContain("Saved food 1");
    expect(text()).not.toContain("Saved food 3");
  });

  it("keeps pre-verification metadata on the existing error Retry and starts new details closed", async () => {
    const first = food();
    const { state, fetcher } = workspace([first]);
    state.read = () => Response.json({ error: "Private data unavailable" }, { status: 503 });
    await mount();
    await change("Name", "Typed before first verified list");
    await change("Notes (optional)", " Keep these notes ");
    const before = [field("Name").props.value, field("Notes (optional)").props.value];
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    await click("Retry private data");
    expect(elements().some((node) => node.type === "button" && "aria-expanded" in node.props)).toBe(
      false,
    );
    pending.resolve(page([first]));
    await hooks.settle();
    expect([field("Name").props.value, field("Notes (optional)").props.value]).toEqual(before);
    expect(details(first).props.hidden).toBe(true);
    const requests = fetcher.mock.calls.length;
    await toggle(first);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect([field("Name").props.value, field("Notes (optional)").props.value]).toEqual(before);
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Refresh private data"),
    ).toBe(false);
  });
});

const savedFilterLabel = "Filter loaded saved foods by name";
const clearFilterLabel = "Clear saved-food filter";
function savedCards() {
  return elements().filter(
    (node) =>
      node.type === "li" &&
      elements(node).some(
        (child) =>
          typeof child.props.id === "string" && child.props.id.startsWith("saved-food-nutrients-"),
      ),
  );
}
function savedNames() {
  return savedCards().map((node) => text(elements(node).find((child) => child.type === "strong")));
}
function filterStatus() {
  return text(elements().find((node) => node.props.id === "saved-food-filter-status"));
}
function otherFields() {
  return elements()
    .filter(
      (node) =>
        ["input", "select", "textarea"].includes(String(node.type)) &&
        node.props.id !== "saved-food-filter",
    )
    .map((node) => ({ type: node.type, value: node.props.value, checked: node.props.checked }));
}
function namedFood(index: number, name: string) {
  const item = food(index);
  return { ...item, currentVersion: { ...item.currentVersion, name } };
}

describe("actual loaded saved-food name filter", () => {
  it("matches only literal trimmed case-insensitive saved names and preserves duplicates/order", async () => {
    const foods = [
      namedFood(1, "Soup [.*] café"),
      namedFood(2, "SOUP [.*] café"),
      namedFood(3, "Other soup"),
      namedFood(4, "Cafe bowl"),
    ] as const;
    const { fetcher } = workspace(foods);
    await mount();
    const requests = fetcher.mock.calls.length;
    expect(field(savedFilterLabel).props.type).toBe("search");
    expect(field(savedFilterLabel).props.maxLength).toBe(200);
    expect(field(savedFilterLabel).props["aria-describedby"]).toBe("saved-food-filter-status");
    expect(filterStatus()).toContain("4 of 4 loaded saved foods match.");
    for (const [query, expected] of [
      ["  soUP [.*]  ", [foods[0], foods[1]]],
      ["cafe", [foods[3]]],
      [" café ", [foods[0], foods[1]]],
      ["  ", foods],
    ] as const) {
      await change(savedFilterLabel, query);
      expect(field(savedFilterLabel).props.value).toBe(query);
      expect(savedNames()).toEqual(expected.map((item) => item.currentVersion.name));
    }
    expect(savedCards()[0]).not.toBe(savedCards()[1]);
    await click(clearFilterLabel);
    expect(savedNames()).toEqual(foods.map((item) => item.currentVersion.name));
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("bounds raw text and rejects old edit/Clear cycles while same-value actions stay usable", async () => {
    workspace([namedFood(1, "alpha")]);
    await mount();
    const emptyClear = button(clearFilterLabel);
    const initial = field(savedFilterLabel);
    invoke(emptyClear, "onClick");
    invoke(initial, "onChange", { target: { value: "alpha" } });
    await hooks.settle();
    const alphaField = field(savedFilterLabel);
    const alphaClear = button(clearFilterLabel);
    invoke(alphaField, "onChange", { target: { value: "alpha" } });
    invoke(alphaClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("");
    await change(savedFilterLabel, "alpha");
    invoke(alphaField, "onChange", { target: { value: "stale" } });
    invoke(alphaClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("alpha");
    await change(savedFilterLabel, "x".repeat(201));
    expect(field(savedFilterLabel).props.value).toBe("x".repeat(200));
    expect(filterStatus()).toContain("0 of 1 loaded saved foods match.");
    expect(filterStatus()).toContain("No loaded saved foods match this name.");
    await click(clearFilterLabel);
    expect(savedNames()).toEqual(["alpha"]);
  });

  it("distinguishes initial unverified/loading/error from a verified empty terminal listing", async () => {
    const { state } = workspace([]);
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    await mount();
    expect(field(savedFilterLabel).props.disabled).toBe(true);
    expect(filterStatus()).toBe("Saved-food listing is loading.");
    expect(filterStatus()).not.toContain("0 of 0");
    pending.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(filterStatus()).toBe("Saved-food listing is unavailable.");
    expect(filterStatus()).not.toContain("No more");
    state.read = () => page([]);
    await click("Retry private data");
    expect(field(savedFilterLabel).props.disabled).toBe(false);
    expect(filterStatus()).toContain("0 of 0 loaded saved foods match.");
    expect(filterStatus()).toContain("No saved foods were returned in this listing.");
    expect(filterStatus()).toContain("No more records in this listing.");
  });

  it("uses loaded-only empty wording when an empty page has a continuation", async () => {
    const { state } = workspace([]);
    state.cursor = "next";
    await mount();
    expect(filterStatus()).toContain("No saved foods are loaded yet.");
    expect(filterStatus()).toContain("More records may be available.");
    expect(filterStatus()).not.toContain("No saved foods were returned in this listing.");
    await change(savedFilterLabel, "soup");
    expect(button("Load more private foods").props.disabled).not.toBe(true);
    state.continuation = () => page([namedFood(1, "Soup")]);
    await click("Load more private foods");
    expect(savedNames()).toEqual(["Soup"]);
    expect(filterStatus()).toContain("1 of 1 loaded saved foods match.");
  });

  it("keeps zero-match pagination, query and accumulated counts through failure, overlap and empty terminal page", async () => {
    const first = namedFood(1, "Alpha");
    const second = namedFood(2, "Beta");
    const third = namedFood(3, "Quinoa");
    const { state, fetcher } = workspace([first, second]);
    state.cursor = "next";
    await mount();
    await toggle(first);
    await change(savedFilterLabel, "QUINOA");
    expect(savedCards()).toHaveLength(0);
    const pending = deferred<Response>();
    state.continuation = () => pending.promise;
    await click("Load more private foods");
    await change(savedFilterLabel, " quinoa ");
    expect(filterStatus()).toContain("0 of 2 loaded saved foods match.");
    pending.resolve(Response.json({ error: "Next page unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe(" quinoa ");
    expect(status()).toBe("Next page unavailable");
    state.continuation = () => page([first, third], "end");
    await click("Load more private foods");
    expect(filterStatus()).toContain("1 of 3 loaded saved foods match.");
    expect(savedNames()).toEqual(["Quinoa"]);
    state.continuation = () => page([]);
    await click("Load more private foods");
    expect(filterStatus()).toContain("1 of 3 loaded saved foods match.");
    expect(filterStatus()).toContain("No more records in this listing.");
    await click(clearFilterLabel);
    expect(savedNames()).toEqual(["Alpha", "Beta", "Quinoa"]);
    expect(details(first).props.hidden).toBe(false);
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("cursor=")).map(([url]) => url),
    ).toEqual([
      "/api/retention/custom-foods?limit=50&cursor=next",
      "/api/retention/custom-foods?limit=50&cursor=next",
      "/api/retention/custom-foods?limit=50&cursor=end",
    ]);
  });

  it("preserves open disclosures, independent dirty editor/log fields and shared feedback when cards are hidden", async () => {
    const first = namedFood(1, "Saved alpha");
    const second = namedFood(2, "Saved beta");
    const { fetcher } = workspace([first, second]);
    await mount();
    await toggle(first);
    await toggle(second);
    await click("Revise", card(first));
    await change("Name", "Draft name that must not be searched");
    await change("Notes (optional)", " Draft notes ");
    await click("Log pinned v1", card(second));
    await change("Exact quantity", "2.375");
    await change("Local date", "2026-09-09");
    await change("Local time", "13:14");
    const before = otherFields();
    const message = status();
    const requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "Draft name");
    expect(savedCards()).toHaveLength(0);
    expect(otherFields()).toEqual(before);
    await change(savedFilterLabel, "beta");
    expect(savedNames()).toEqual(["Saved beta"]);
    expect(details(second).props.hidden).toBe(false);
    await click(clearFilterLabel);
    expect(details(first).props.hidden).toBe(false);
    expect(details(second).props.hidden).toBe(false);
    expect(otherFields()).toEqual(before);
    expect(status()).toBe(message);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("loads only its own private library and nutrient registry, including while filtering", async () => {
    const { fetcher } = workspace([food()]);
    await mount();
    expect(new Set(fetcher.mock.calls.map(([url]) => url))).toEqual(
      new Set([
        "/api/auth/me",
        "/api/nutrients/targetable",
        "/api/retention/custom-foods?limit=50",
      ]),
    );
    const before = otherFields(),
      requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "absent");
    await click(clearFilterLabel);
    expect(otherFields()).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each(["create", "revision", "log"] as const)(
    "preserves the exact unresolved %s operation through pending and failed filter changes",
    async (kind) => {
      const first = food();
      const { state, fetcher, writes } = workspace([first]);
      if (kind === "create")
        state.picker = [
          { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
        ];
      await mount();
      if (kind === "revision") await click("Revise", card(first));
      if (kind === "log") {
        await click("Log pinned v1", card(first));
        await change("Exact quantity", "1.375");
      } else await change("Name", "Pending draft");
      const label =
        kind === "create"
          ? "Create private food"
          : kind === "revision"
            ? "Save new version"
            : "Log exact version";
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      await submit(label);
      const requests = fetcher.mock.calls.length;
      const before = otherFields();
      const beforeMessage = status();
      await change(savedFilterLabel, "absent");
      expect(savedCards()).toHaveLength(0);
      expect(otherFields()).toEqual(before);
      expect(status()).toBe(beforeMessage);
      await click(clearFilterLabel);
      expect(fetcher).toHaveBeenCalledTimes(requests);
      pending.resolve(Response.json({ error: "Receipt unavailable" }, { status: 503 }));
      await hooks.settle();
      const failedMessage = status();
      await change(savedFilterLabel, "saved");
      expect(status()).toBe(failedMessage);
      state.write = () => Response.json({ error: "Still unavailable" }, { status: 503 });
      await submit(label);
      expect(writes()).toHaveLength(2);
      expect(writes()[1]?.[0]).toBe(writes()[0]?.[0]);
      expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
      expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
        new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
      );
      expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBe(
        new Headers(writes()[0]?.[1]?.headers).get("if-match"),
      );
    },
  );

  it("retains query across same-owner refresh and Retry without treating old counts as verified", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await change(savedFilterLabel, "  SAVED  ");
    const oldField = field(savedFilterLabel);
    const oldClear = button(clearFilterLabel);
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    hooks.replayEffects();
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("  SAVED  ");
    expect(savedCards()).toHaveLength(1);
    expect(filterStatus()).toBe("Saved-food listing is loading.");
    await change(savedFilterLabel, "saved food");
    pending.resolve(Response.json({ error: "Refresh failed" }, { status: 503 }));
    await hooks.settle();
    expect(filterStatus()).toBe("Saved-food listing is unavailable.");
    expect(filterStatus()).not.toContain("No more");
    state.read = () => page([first]);
    await click("Retry private data");
    expect(field(savedFilterLabel).props.value).toBe("saved food");
    expect(filterStatus()).toContain("1 of 1 loaded saved foods match.");
    invoke(oldField, "onChange", { target: { value: "stale" } });
    invoke(oldClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("saved food");
  });

  it("hides background query/cards before effects and restores only current same-scope controls", async () => {
    const view = visibility();
    const { fetcher } = workspace([food()]);
    await mount();
    await change(savedFilterLabel, " SAVED ");
    const oldField = field(savedFilterLabel);
    const oldClear = button(clearFilterLabel);
    const requests = fetcher.mock.calls.length;
    view.document.visibilityState = "hidden";
    invoke(oldField, "onChange", { target: { value: "stale" } });
    hooks.renderWithoutEffects();
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(savedCards()).toHaveLength(0);
    await view.set("hidden");
    await view.set("visible");
    expect(field(savedFilterLabel).props.value).toBe(" SAVED ");
    expect(savedCards()).toHaveLength(1);
    invoke(oldField, "onChange", { target: { value: "stale" } });
    invoke(oldClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe(" SAVED ");
    await click(clearFilterLabel);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each(["America/Chicago", "America/New_York"])(
    "handles verified profile refresh to %s without touching the pinned log",
    async (zone) => {
      const first = food();
      const { state } = workspace([first]);
      await mount();
      await click("Log pinned v1", card(first));
      await change("Exact quantity", "2.375");
      await change(savedFilterLabel, " saved ");
      const oldField = field(savedFilterLabel);
      const oldClear = button(clearFilterLabel);
      const pending = deferred<Response>();
      state.auth = () => pending.promise;
      state.write = () =>
        Response.json({ error: "Zone changed", code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
      await submit("Log exact version");
      expect(field(savedFilterLabel).props.value).toBe("");
      expect(savedCards()).toHaveLength(0);
      pending.resolve(session(owner, zone));
      await hooks.settle();
      expect(field(savedFilterLabel).props.value).toBe(zone === "America/Chicago" ? " saved " : "");
      expect(field("Exact quantity").props.value).toBe("2.375");
      invoke(oldField, "onChange", { target: { value: "stale" } });
      invoke(oldClear, "onClick");
      await hooks.settle();
      expect(field(savedFilterLabel).props.value).toBe(zone === "America/Chicago" ? " saved " : "");
      expect(filterStatus()).toContain("1 of 1 loaded saved foods match.");
    },
  );

  it("clears private query on owner closure and rejects retained filter controls after unmount", async () => {
    const { state, fetcher } = workspace([food()]);
    state.cursor = "next";
    await mount();
    await change(savedFilterLabel, " private name ");
    const oldField = field(savedFilterLabel);
    const oldClear = button(clearFilterLabel);
    state.continuation = () => {
      state.owner = otherOwner;
      return page([]);
    };
    await click("Load more private foods");
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(field(savedFilterLabel).props.value).toBe("");
    expect(savedCards()).toHaveLength(0);
    invoke(oldField, "onChange", { target: { value: "leak" } });
    invoke(oldClear, "onClick");
    await hooks.settle();
    expect(field(savedFilterLabel).props.value).toBe("");
    const requests = fetcher.mock.calls.length;
    hooks.unmount();
    const updates = hooks.afterClose();
    invoke(oldField, "onChange", { target: { value: "late" } });
    invoke(oldClear, "onClick");
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("keeps locally archived cards searchable without implying archived-library coverage", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    vi.stubGlobal("window", { confirm: () => true });
    await change(savedFilterLabel, "SAVED");
    const archived = { ...first, status: "archived" as const, revision: "2" };
    state.write = () => receipt(archived);
    await click("Archive", card(first));
    expect(field(savedFilterLabel).props.value).toBe("SAVED");
    expect(savedCards()).toHaveLength(1);
    expect(text(card(archived))).toContain("archived");
    expect(filterStatus()).toContain("1 of 1 loaded saved foods match.");
    expect(filterStatus()).not.toContain("All saved");
  });
});

const discardCustomCopy = "Discard draft and copy saved version";
function copyButton(item: CustomFood) {
  return button(
    `Copy ${item.currentVersion.name} v${item.currentVersion.versionNumber} to new draft`,
    card(item),
  );
}
async function copyFood(item: CustomFood) {
  const node = copyButton(item);
  expect(node.props.disabled).toBe(false);
  invoke(node, "onClick");
  await hooks.settle();
}
function customForm() {
  const found = elements().find(
    (node) =>
      node.type === "form" &&
      elements(node).some(
        (child) => child.props.value === field("Name").props.value && child.props.maxLength === 500,
      ),
  );
  if (!found) throw new Error("Missing custom form");
  return found;
}
function newSaved(source: CustomFood, index = 20): CustomFood {
  return {
    ...source,
    id: food(index).id,
    revision: "1",
    currentVersion: {
      ...source.currentVersion,
      id: food(index).currentVersion.id,
      versionNumber: 1,
    },
  };
}
function savedRequest(source: CustomFood) {
  return {
    name: source.currentVersion.name,
    brandName: source.currentVersion.brandName,
    serving: source.currentVersion.serving
      ? { label: source.currentVersion.serving.label, grams: source.currentVersion.serving.grams }
      : null,
    nutrients: source.currentVersion.nutrients.map((row) => ({
      nutrientId: row.nutrient.id,
      state: row.state,
      amountPer100Grams: row.amountPer100Grams,
      ...(row.state === "unknown" ? { reason: row.reason } : {}),
    })),
    notes: source.currentVersion.notes,
  };
}

describe("actual saved custom-food Copy to new draft", () => {
  it("copies exact saved states and unavailable snapshot options without requests, then creates a separate food", async () => {
    const base = allStates();
    const first = {
      ...base,
      currentVersion: {
        ...base.currentVersion,
        name: "Exact copy",
        brandName: "Brand",
        nutrients: base.currentVersion.nutrients.map((row, index) =>
          index === 1 ? { ...row, amountPer100Grams: "0.0000" } : row,
        ),
      },
    } as CustomFood;
    const original = JSON.stringify(first);
    const { state, fetcher, writes } = workspace([first]);
    await mount();
    await toggle(first);
    const focus = vi.fn();
    (field("Name").props.ref as { current: unknown }).current = { focus };
    const requests = fetcher.mock.calls.length;
    const beforeStatus = status();
    await copyFood(first);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(focus).toHaveBeenCalledOnce();
    expect(status()).toBe(beforeStatus);
    expect(details(first).props.hidden).toBe(false);
    expect(text(customForm())).toContain("New draft copied from saved Exact copy v1");
    expect(field("Name").props.value).toBe("Exact copy");
    expect(field("Brand (optional)").props.value).toBe("Brand");
    expect(field("Serving grams").props.value).toBe("125.25");
    expect(field("Amount per 100 grams 1").props.value).toBe(longAmount);
    expect(field("Amount per 100 grams 2").props.value).toBe("0.0000");
    for (const [index, row] of first.currentVersion.nutrients.entries()) {
      expect(field(`Nutrient ${index + 1}`).props.value).toBe(row.nutrient.id);
      expect(text(field(`Nutrient ${index + 1}`))).toContain(
        `${row.nutrient.name} (${row.nutrient.unit})`,
      );
    }
    state.write = () => receipt(newSaved(first));
    await submit("Create private food");
    expect(writes()).toHaveLength(1);
    const attempt = writes()[0];
    if (!attempt) throw new Error("Missing create");
    const [url, init] = attempt;
    expect(url).toBe("/api/retention/custom-foods");
    expect(new Headers(init?.headers).has("if-match")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual(savedRequest(first));
    expect(savedNames()).toEqual(["Exact copy", "Exact copy"]);
    expect(JSON.stringify(first)).toBe(original);
    expect(field("Name").props.value).toBe("");
  });

  it("preserves all 256 nutrient rows and optional serving absence on an archived source", async () => {
    const first = {
      ...food(),
      status: "archived" as const,
      currentVersion: {
        ...food().currentVersion,
        serving: null,
        nutrients: Array.from({ length: 256 }, (_, index) => ({
          nutrient: {
            id: String(index + 1),
            code: `code${index}`,
            name: `Nutrient ${index}`,
            unit: "g",
          },
          state: "quantified" as const,
          amountPer100Grams: index ? "0" : longAmount,
        })),
      },
    };
    const { state, writes } = workspace([first]);
    await mount();
    await copyFood(first);
    expect(field("Serving label").props.value).toBe("");
    expect(field("Serving grams").props.value).toBe("");
    expect(field("Nutrient 256").props.value).toBe("256");
    state.write = () => receipt(newSaved(first));
    await submit("Create private food");
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual(savedRequest(first));
  });

  it("protects populated new drafts and copied drafts, while Keep editing preserves raw work", async () => {
    const first = food();
    const { fetcher } = workspace([first]);
    await mount();
    await change("Name", "  unfinished  ");
    await change("Notes (optional)", "  notes\n ");
    const before = formValues();
    const requests = fetcher.mock.calls.length;
    await copyFood(first);
    expect(text(customForm())).toContain("unsaved draft");
    await click("Keep editing");
    expect(formValues()).toEqual(before);
    await copyFood(first);
    await click(discardCustomCopy);
    expect(field("Name").props.value).toBe(first.currentVersion.name);
    await copyFood(first);
    expect(text(customForm())).toContain("unsaved draft");
    await click("Keep editing");
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("copies unchanged revisions directly but treats raw whitespace edits as dirty", async () => {
    const first = food();
    workspace([first]);
    await mount();
    await click("Revise", card(first));
    await change("Name", `${first.currentVersion.name} `);
    await copyFood(first);
    expect(button(discardCustomCopy)).toBeDefined();
    await click("Keep editing");
    await change("Name", first.currentVersion.name);
    await copyFood(first);
    expect(elements().some((node) => text(node) === discardCustomCopy)).toBe(false);
    expect(button("Create private food")).toBeDefined();
  });

  it("rejects old choices after edit/restore and cannot cancel a newer choice", async () => {
    const first = food();
    workspace([first]);
    await mount();
    await change("Name", "Draft");
    await copyFood(first);
    const discard = button(discardCustomCopy);
    const keep = button("Keep editing");
    await change("Name", "Other");
    await change("Name", "Draft");
    await copyFood(first);
    invoke(discard, "onClick");
    invoke(keep, "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe("Draft");
    expect(button(discardCustomCopy)).toBeDefined();
    await click(discardCustomCopy);
    expect(field("Name").props.value).toBe(first.currentVersion.name);
  });

  it("leaves filter, disclosures, pinned log and other fields intact, even when the choice source is filtered out", async () => {
    const first = food();
    const second = food(2);
    const { fetcher } = workspace([first, second]);
    await mount();
    await toggle(first);
    await click("Log pinned v1", card(second));
    await change("Exact quantity", "2.375");
    await change("Name", "Dirty draft");
    await copyFood(first);
    const logBefore = ["Exact quantity", "Local date", "Local time"].map(
      (label) => field(label).props.value,
    );
    const messageBefore = status();
    const requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "absent");
    await click(discardCustomCopy);
    expect(field(savedFilterLabel).props.value).toBe("absent");
    expect(
      ["Exact quantity", "Local date", "Local time"].map((label) => field(label).props.value),
    ).toEqual(logBefore);
    expect(status()).toBe(messageBefore);
    await click(clearFilterLabel);
    expect(details(first).props.hidden).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each(["copy", "revise"] as const)(
    "rejects retained original field, row, Revise, Cancel and submit controls after %s",
    async (action) => {
      const first = food();
      const { fetcher, writes } = customAvailabilityWorkspace(first);
      await mount();
      await click("Revise", card(first));
      const originalFields = elements(customForm()).filter(
        (node) => typeof node.props.onChange === "function",
      );
      const oldRemove = button("Remove nutrient 1");
      const oldAdd = button("Add nutrient");
      const oldNutrient = field("Nutrient 1");
      const oldRevise = button("Revise", card(first));
      const oldCancel = button("Cancel edit");
      const oldForm = customForm();
      if (action === "copy") await copyFood(first);
      else await click("Revise", card(first));
      const before = formValues();
      const requests = fetcher.mock.calls.length;
      for (const node of originalFields) invoke(node, "onChange", { target: { value: "stale" } });
      invoke(oldNutrient, "onChange", { target: { value: "4" } });
      for (const node of [oldRemove, oldAdd, oldRevise, oldCancel]) invoke(node, "onClick");
      invoke(oldForm, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(formValues()).toEqual(before);
      expect(fetcher).toHaveBeenCalledTimes(requests);
      expect(writes()).toHaveLength(0);
    },
  );

  it("keeps same-value controls usable and fences duplicate Copy before paint", async () => {
    const first = food();
    workspace([first]);
    await mount();
    const originalCopy = copyButton(first);
    invoke(field("Name"), "onChange", { target: { value: "" } });
    invoke(originalCopy, "onClick");
    invoke(originalCopy, "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe(first.currentVersion.name);
    expect(elements().some((node) => text(node) === discardCustomCopy)).toBe(false);
  });

  it("retains A-to-B-to-A and malformed receipt retries, but accepted identical Copy has a new intent", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    await mount();
    await copyFood(first);
    state.write = () => Response.json({ data: "malformed" });
    await submit("Create private food");
    await submit("Create private food");
    await change("Name", "Body B");
    await submit("Create private food");
    await change("Name", first.currentVersion.name);
    await submit("Create private food");
    const attempts = writes();
    expect(attempts).toHaveLength(4);
    expect(attempts[0]?.[1]?.body).toBe(attempts[3]?.[1]?.body);
    const keys = attempts.map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[2]);
    await copyFood(first);
    await click("Keep editing");
    await submit("Create private food");
    expect(new Headers(writes()[4]?.[1]?.headers).get("idempotency-key")).toBe(keys[0]);
    await copyFood(first);
    await click(discardCustomCopy);
    await submit("Create private food");
    expect(writes()[5]?.[1]?.body).toBe(attempts[0]?.[1]?.body);
    expect(new Headers(writes()[5]?.[1]?.headers).get("idempotency-key")).not.toBe(keys[0]);
  });

  it("blocks Copy, Revise and duplicate saves through its own pending write after unrelated work completes", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    state.cursor = "next";
    await mount();
    await copyFood(first);
    const oldCopy = copyButton(first),
      oldRevise = button("Revise", card(first));
    const oldSubmit = customForm();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    invoke(oldCopy, "onClick");
    invoke(oldRevise, "onClick");
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    state.continuation = () => page([food(2)]);
    await click("Load more private foods");
    expect(copyButton(first).props.disabled).toBe(true);
    expect(button("Revise", card(first)).props.disabled).toBe(true);
    expect(button("Saving…").props.disabled).toBe(true);
    expect(writes()).toHaveLength(1);
    pending.resolve(receipt(newSaved(first)));
    await hooks.settle();
    expect(field("Name").props.value).toBe("");
    expect(button("Create private food").props.disabled).toBe(false);
  });

  it("checks current draft before unauthorized or JSON effects and preserves later edits", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await copyFood(first);
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Create private food");
    await change("Name", "Newer raw draft");
    const old = Response.json({ error: "expired" }, { status: 401 });
    const parse = vi.spyOn(old, "json");
    pending.resolve(old);
    await hooks.settle();
    expect(parse).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(field("Name").props.value).toBe("Newer raw draft");
    expect(button("Create private food").props.disabled).toBe(false);
  });

  it("checks identity again after deferred JSON and never clears a replacement draft", async () => {
    const first = food();
    const { state } = workspace([first]);
    await mount();
    await copyFood(first);
    const parsed = deferred<unknown>();
    const response = receipt(newSaved(first));
    vi.spyOn(response, "json").mockImplementation(() => parsed.promise);
    state.write = () => response;
    await submit("Create private food");
    await change("Name", "Later draft");
    parsed.resolve({ data: { replayed: false, customFood: newSaved(first) } });
    await hooks.settle();
    expect(field("Name").props.value).toBe("Later draft");
    expect(savedCards()).toHaveLength(1);
  });

  it.each([
    ["receipt first", false],
    ["list first", false],
    ["receipt first", true],
    ["list first", true],
  ] as const)(
    "preserves an accepted save across existing Retry full refresh: %s, newer page %s",
    async (order, newerPage) => {
      const first = food();
      const { state, writes } = workspace([first]);
      await mount();
      await copyFood(first);
      state.read = () => Response.json({ error: "Full read unavailable" }, { status: 503 });
      hooks.replayEffects();
      await hooks.settle();
      expect(button("Retry private data")).toBeDefined();
      const retry = button("Retry private data");
      const pendingSave = deferred<Response>();
      const pendingList = deferred<Response>();
      state.write = () => pendingSave.promise;
      state.read = () => pendingList.promise;
      await submit("Create private food");
      invoke(retry, "onClick");
      await hooks.settle();
      const saved = newSaved(first);
      const later = {
        ...saved,
        revision: "3",
        currentVersion: {
          ...saved.currentVersion,
          id: "9999999999999999",
          versionNumber: 3,
          name: "Newer authoritative version",
        },
      };
      const loaded = newerPage ? [first, later] : [first];
      if (order === "receipt first") {
        pendingSave.resolve(receipt(saved));
        await hooks.settle();
        expect(field("Name").props.value).toBe("");
        expect(savedCards()).toHaveLength(2);
        pendingList.resolve(page(loaded));
      } else {
        pendingList.resolve(page(loaded));
        await hooks.settle();
        expect(field("Name").props.value).toBe(first.currentVersion.name);
        pendingSave.resolve(receipt(saved));
      }
      await hooks.settle();
      expect(savedCards()).toHaveLength(2);
      expect(card(newerPage ? later : saved)).toBeDefined();
      if (newerPage) expect(savedNames()).toContain("Newer authoritative version");
      expect(field("Name").props.value).toBe("");
      expect(writes()).toHaveLength(1);
      expect(button("Create private food").props.disabled).toBe(false);
      expect(filterStatus()).toContain("2 of 2 loaded saved foods match.");
    },
  );

  it("retains an already-loaded v3 through accepted v2 retry and an older pending full list", async () => {
    const first = food();
    const second = {
      ...first,
      revision: "2",
      currentVersion: { ...first.currentVersion, id: "9999999999999998", versionNumber: 2 },
    };
    const third = {
      ...first,
      revision: "3",
      currentVersion: {
        ...first.currentVersion,
        id: "9999999999999999",
        versionNumber: 3,
        name: "Newest saved version",
      },
    };
    const { state, writes } = workspace([first]);
    await mount();
    await click("Revise", card(first));
    state.write = () => Response.json({ error: "Receipt unavailable" }, { status: 503 });
    await submit("Save new version");
    const original = writes()[0]?.[1];
    state.read = () => page([third]);
    hooks.replayEffects();
    await hooks.settle();
    expect(card(third)).toBeDefined();
    expect(field("Name").props.value).toBe(first.currentVersion.name);
    state.read = () => Response.json({ error: "Read unavailable" }, { status: 503 });
    hooks.replayEffects();
    await hooks.settle();
    const retry = button("Retry private data");
    const pendingWrite = deferred<Response>();
    const pendingList = deferred<Response>();
    state.write = () => pendingWrite.promise;
    state.read = () => pendingList.promise;
    await submit("Save new version");
    invoke(retry, "onClick");
    await hooks.settle();
    pendingWrite.resolve(receipt(second));
    await hooks.settle();
    expect(card(third)).toBeDefined();
    expect(field("Name").props.value).toBe("");
    expect(writes()[1]?.[1]?.body).toBe(original?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(original?.headers).get("idempotency-key"),
    );
    pendingList.resolve(page([first]));
    await hooks.settle();
    expect(savedNames()).toEqual(["Newest saved version"]);
    expect(card(third)).toBeDefined();
    expect(field("Name").props.value).toBe("");
    expect(filterStatus()).toContain("1 of 1 loaded saved foods match.");
  });

  it("ignores an old unauthorized receipt after background and a newer accepted Copy", async () => {
    const view = visibility();
    const first = food();
    const { state, writes } = workspace([first]);
    await mount();
    await copyFood(first);
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Create private food");
    await view.set("hidden");
    await view.set("visible");
    await copyFood(first);
    await click(discardCustomCopy);
    await change("Name", "Replacement copied draft");
    const old = Response.json({ error: "Old unauthorized response" }, { status: 401 });
    const parse = vi.spyOn(old, "json");
    pending.resolve(old);
    await hooks.settle();
    expect(parse).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(field("Name").props.value).toBe("Replacement copied draft");
    expect(button("Create private food").props.disabled).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it.each(["copy", "revise"] as const)(
    "closes %s choice on full refresh, background, owner change and unmount without reusing old controls",
    async (action) => {
      const view = visibility();
      const first = food();
      const { state, fetcher } = workspace([first]);
      const discardLabel = action === "copy" ? discardCustomCopy : discardCustomRevise;
      const choose = async (source: CustomFood) =>
        action === "copy" ? copyFood(source) : click("Revise", card(source));
      await mount();
      await change("Name", "Draft");
      await choose(first);
      const oldDiscard = button(discardLabel);
      const oldCopy = action === "copy" ? copyButton(first) : button("Revise", card(first));
      await view.set("hidden");
      invoke(oldDiscard, "onClick");
      await view.set("visible");
      invoke(oldCopy, "onClick");
      await hooks.settle();
      expect(field("Name").props.value).toBe("Draft");
      expect(elements().some((node) => text(node) === discardLabel)).toBe(false);
      await choose(first);
      const beforeRefresh = button(discardLabel),
        pending = deferred<Response>();
      const later = {
        ...first,
        revision: "2",
        currentVersion: { ...first.currentVersion, versionNumber: 2, name: "Refreshed version" },
      };
      state.read = () => pending.promise;
      hooks.replayEffects();
      invoke(beforeRefresh, "onClick");
      pending.resolve(page([later]));
      await hooks.settle();
      invoke(beforeRefresh, "onClick");
      await hooks.settle();
      expect(field("Name").props.value).toBe("Draft");
      expect(elements().some((node) => text(node) === discardLabel)).toBe(false);
      await choose(later);
      expect(customDraftChoiceText()).toContain("Refreshed version v2.");
      const beforeOwnerChange = button(discardLabel);
      state.read = null;
      state.owner = otherOwner;
      hooks.replayEffects();
      await hooks.settle();
      invoke(beforeOwnerChange, "onClick");
      await hooks.settle();
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(customDraftChoiceText()).toBe("");
      expect(field("Name").props.value).toBe("");
      const before = fetcher.mock.calls.length;
      hooks.unmount();
      const updates = hooks.afterClose();
      invoke(oldDiscard, "onClick");
      invoke(oldCopy, "onClick");
      expect(hooks.afterClose()).toBe(updates);
      expect(fetcher).toHaveBeenCalledTimes(before);
    },
  );
});

function customNutrientAvailability() {
  return text(elements().find((node) => node.props.id === "custom-nutrient-availability"));
}
function customNutrientRows() {
  return elements(customForm()).filter((node) => node.props.className === "nutrientDraftRow");
}
function customNutrientValues() {
  return customNutrientRows().map((row) =>
    elements(row)
      .filter((node) => node.type === "input" || node.type === "select")
      .map((node) => node.props.value),
  );
}
function customAvailabilityWorkspace(initial: CustomFood = food()) {
  const result = workspace([initial]);
  result.state.picker = [
    { id: "4", code: "first", name: "First loaded", unit: "mg", category: "vitamin" },
    { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
    { id: "3", code: "last", name: "Last loaded", unit: "ug", category: "vitamin" },
  ];
  return result;
}

describe("web custom-food nutrient addition availability", () => {
  it("adds unused IDs in loaded order, explains exhaustion and restores a removed choice without touching exact legacy rows", async () => {
    const saved = allStates();
    const { fetcher } = customAvailabilityWorkspace(saved);
    await mount();
    await click("Revise", card(saved));
    await change("Name", " Raw saved-food name ");
    await change("Amount per 100 grams 1", " 001.2300 ");
    await change("Unknown reason 4", "withheld");
    const originalRows = customNutrientValues(),
      name = field("Name").props.value;
    const before = fetcher.mock.calls.length;
    const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
    vi.stubGlobal("crypto", { randomUUID: allocate });
    expect(button("Add nutrient").props.disabled).toBe(false);
    expect(button("Add nutrient").props["aria-describedby"]).toBe("custom-nutrient-availability");
    await click("Add nutrient");
    expect(customNutrientValues()).toEqual([...originalRows, ["2", "quantified", "0"]]);
    expect(field("Name").props.value).toBe(name);
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(customNutrientAvailability()).toBe(
      "All loaded nutrients are already in this draft. Remove a row to add that nutrient again.",
    );
    const exhausted = button("Add nutrient");
    invoke(exhausted, "onClick");
    await hooks.settle();
    expect(customNutrientValues()).toHaveLength(originalRows.length + 1);
    await click("Remove nutrient 3");
    expect(button("Add nutrient").props.disabled).toBe(false);
    await click("Add nutrient");
    expect(customNutrientValues().at(-1)).toEqual(["4", "quantified", "0"]);
    expect(customNutrientValues().slice(0, 2)).toEqual(originalRows.slice(0, 2));
    expect(customNutrientValues().slice(2, 6)).toEqual(originalRows.slice(3));
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("uses first unused source order rather than numeric IDs and fences duplicate callbacks before paint", async () => {
    const { fetcher } = customAvailabilityWorkspace();
    await mount();
    await click("Revise", card(food()));
    const before = fetcher.mock.calls.length,
      add = button("Add nutrient");
    invoke(add, "onClick");
    invoke(add, "onClick");
    hooks.renderWithoutEffects();
    expect(customNutrientValues()).toEqual([
      ["2", "quantified", "12.375"],
      ["4", "quantified", "0"],
    ]);
    await click("Add nutrient");
    expect(customNutrientValues().at(-1)).toEqual(["3", "quantified", "0"]);
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it("distinguishes loading or failed metadata from a verified empty list and recovers only after accepted metadata", async () => {
    const { state, fetcher } = customAvailabilityWorkspace();
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    await mount();
    const unavailable = button("Add nutrient"),
      before = fetcher.mock.calls.length;
    expect(unavailable.props.disabled).toBe(true);
    expect(customNutrientAvailability()).toBe("The nutrient list is not available right now.");
    invoke(unavailable, "onClick");
    expect(fetcher.mock.calls).toHaveLength(before);
    pending.resolve(Response.json({ error: "Metadata receipt unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(customNutrientAvailability()).toContain("not available");
    state.read = null;
    state.picker = [];
    await click("Retry private data");
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(customNutrientAvailability()).toBe("No nutrients are available in the loaded list.");
    state.picker = [
      { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
    ];
    hooks.replayEffects();
    await hooks.settle();
    expect(button("Add nutrient").props.disabled).toBe(false);
    expect(customNutrientAvailability()).toBe("Add the next unused nutrient from the loaded list.");
    invoke(unavailable, "onClick");
    await hooks.settle();
    expect(customNutrientRows()).toHaveLength(0);
    await click("Add nutrient");
    expect(customNutrientValues()).toEqual([["2", "quantified", "0"]]);
  });

  it("rejects retained Add after raw edit-restore and pending or replaced registry receipts", async () => {
    const { state, fetcher } = customAvailabilityWorkspace();
    await mount();
    await click("Revise", card(food()));
    const old = button("Add nutrient"),
      oldChoice = field("Nutrient 1"),
      name = String(field("Name").props.value);
    invoke(field("Name"), "onChange", { target: { value: "temporary raw draft" } });
    invoke(old, "onClick");
    invoke(oldChoice, "onChange", { target: { value: "4" } });
    hooks.renderWithoutEffects();
    invoke(field("Name"), "onChange", { target: { value: name } });
    hooks.renderWithoutEffects();
    invoke(old, "onClick");
    invoke(oldChoice, "onChange", { target: { value: "4" } });
    await hooks.settle();
    expect(customNutrientRows()).toHaveLength(1);
    const beforeRefresh = button("Add nutrient"),
      beforeRefreshChoice = field("Nutrient 1"),
      pending = deferred<Response>();
    state.read = () => pending.promise;
    state.picker = [
      { id: "99", code: "new", name: "New accepted nutrient", unit: "mg", category: "mineral" },
    ];
    hooks.replayEffects();
    invoke(beforeRefresh, "onClick");
    invoke(beforeRefreshChoice, "onChange", { target: { value: "99" } });
    hooks.renderWithoutEffects();
    expect(button("Add nutrient").props.disabled).toBe(true);
    pending.resolve(page(state.items));
    await hooks.settle();
    const before = fetcher.mock.calls.length;
    invoke(beforeRefresh, "onClick");
    invoke(beforeRefreshChoice, "onChange", { target: { value: "99" } });
    await hooks.settle();
    expect(customNutrientRows()).toHaveLength(1);
    expect(fetcher.mock.calls).toHaveLength(before);
    await change("Nutrient 1", "4");
    expect(customNutrientValues()).toEqual([["2", "quantified", "12.375"]]);
    await click("Add nutrient");
    expect(customNutrientValues()).toEqual([
      ["2", "quantified", "12.375"],
      ["99", "quantified", "0"],
    ]);
  });

  it("keeps nutrient additions independent of filtering, disclosure and selected-day changes before effects", async () => {
    const { fetcher } = customAvailabilityWorkspace();
    navigation.search = "date=2026-09-08";
    await mount();
    const add = button("Add nutrient"),
      choice = field("Nutrient 1");
    invoke(field(savedFilterLabel), "onChange", { target: { value: "Saved" } });
    hooks.renderWithoutEffects();
    invoke(disclosure(food()), "onClick");
    hooks.renderWithoutEffects();
    navigation.search = "date=2026-09-09";
    hooks.renderWithoutEffects();
    const before = fetcher.mock.calls.length;
    invoke(choice, "onChange", { target: { value: "2" } });
    hooks.renderWithoutEffects();
    expect(customNutrientValues()).toEqual([["2", "quantified", "0"]]);
    invoke(add, "onClick");
    invoke(button("Add nutrient"), "onClick");
    hooks.renderWithoutEffects();
    expect(customNutrientValues()).toEqual([
      ["2", "quantified", "0"],
      ["4", "quantified", "0"],
    ]);
    expect(field(savedFilterLabel).props.value).toBe("Saved");
    expect(details(food()).props.hidden).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(before);
    await hooks.settle();
  });

  it("preserves local Add during a pending save and reuses the exact original ambiguous retry after removal", async () => {
    const { state, fetcher, writes } = customAvailabilityWorkspace();
    await mount();
    await click("Revise", card(food()));
    const pending = deferred<Response>(),
      add = button("Add nutrient"),
      choice = field("Nutrient 1");
    state.write = () => pending.promise;
    await submit("Save new version");
    const before = fetcher.mock.calls.length,
      body = writes()[0]?.[1]?.body;
    expect(button("Add nutrient").props.disabled).toBe(false);
    invoke(choice, "onChange", { target: { value: "3" } });
    await hooks.settle();
    expect(customNutrientValues()).toEqual([["3", "quantified", "0"]]);
    await change("Nutrient 1", "2");
    await change("Amount per 100 grams 1", "12.375");
    invoke(add, "onClick");
    invoke(button("Add nutrient"), "onClick");
    await hooks.settle();
    expect(customNutrientValues().at(-1)).toEqual(["4", "quantified", "0"]);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[1]?.body).toBe(body);
    pending.resolve(Response.json({ error: "Ambiguous saved version" }, { status: 503 }));
    await hooks.settle();
    await click("Remove nutrient 2");
    state.write = () => Response.json({ error: "Still ambiguous" }, { status: 503 });
    await submit("Save new version");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBe('"1"');
  });

  it("blocks hidden, profile-unverified, expired and unmounted retained additions without changing the draft", async () => {
    const view = visibility(),
      { state, fetcher } = customAvailabilityWorkspace();
    await mount();
    await click("Revise", card(food()));
    const old = button("Add nutrient"),
      oldChoice = field("Nutrient 1"),
      rows = customNutrientValues();
    view.document.visibilityState = "hidden";
    invoke(old, "onClick");
    invoke(oldChoice, "onChange", { target: { value: "4" } });
    hooks.renderWithoutEffects();
    expect(button("Add nutrient").props.disabled).toBe(true);
    await view.set("visible");
    invoke(old, "onClick");
    invoke(oldChoice, "onChange", { target: { value: "4" } });
    await hooks.settle();
    expect(customNutrientValues()).toEqual(rows);
    await click("Log pinned v1", card(food()));
    await change("Exact quantity", "2");
    const profileOld = button("Add nutrient"),
      profileChoice = field("Nutrient 1"),
      pending = deferred<Response>();
    state.auth = () => pending.promise;
    state.write = () =>
      Response.json({ error: "Zone changed", code: "DIARY_TIME_ZONE_CHANGED" }, { status: 409 });
    await submit("Log exact version");
    invoke(profileOld, "onClick");
    invoke(profileChoice, "onChange", { target: { value: "4" } });
    hooks.renderWithoutEffects();
    expect(button("Add nutrient").props.disabled).toBe(true);
    pending.resolve(session(owner, "America/Chicago"));
    await hooks.settle();
    invoke(profileOld, "onClick");
    invoke(profileChoice, "onChange", { target: { value: "4" } });
    await hooks.settle();
    expect(customNutrientValues()).toEqual(rows);
    const current = button("Add nutrient"),
      currentChoice = field("Nutrient 1");
    state.auth = null;
    state.owner = otherOwner;
    hooks.replayEffects();
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    invoke(current, "onClick");
    invoke(currentChoice, "onChange", { target: { value: "4" } });
    await hooks.settle();
    expect(customNutrientRows()).toHaveLength(0);
    hooks.unmount();
    const updates = hooks.afterClose(),
      requests = fetcher.mock.calls.length;
    invoke(current, "onClick");
    invoke(currentChoice, "onChange", { target: { value: "4" } });
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });
});

function customNutrientOptions(index: number) {
  return elements(field(`Nutrient ${index}`))
    .filter((node) => node.type === "option")
    .map((node) => ({
      id: node.props.value,
      label: text(node),
      disabled: node.props.disabled === true,
    }));
}

describe("web custom-food nutrient row uniqueness", () => {
  it("preserves raw same-ID and rejected choices, ordered names/units and legacy options while releasing changed or removed IDs", async () => {
    const saved = allStates();
    const { state, fetcher } = customAvailabilityWorkspace(saved);
    state.picker = [
      { id: "4", code: "first", name: "Shared name", unit: "mg", category: "vitamin" },
      { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
      { id: "3", code: "last", name: "Shared name", unit: "ug", category: "vitamin" },
    ];
    await mount();
    await click("Revise", card(saved));
    await change("Name", " Raw nutrient draft ");
    await change("Amount per 100 grams 1", " 001.2300 ");
    await change("Amount per 100 grams 2", "0.0000");
    const original = formValues(),
      rows = customNutrientValues(),
      message = status(),
      before = fetcher.mock.calls.length;
    const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
    vi.stubGlobal("crypto", { randomUUID: allocate });
    expect(customNutrientOptions(1)).toEqual([
      { id: "1", label: "Saved Energy (kcal) · saved nutrient", disabled: false },
      { id: "4", label: "Shared name (mg) · already in this draft", disabled: true },
      { id: "2", label: "Protein (g)", disabled: false },
      { id: "3", label: "Shared name (ug) · already in this draft", disabled: true },
    ]);
    expect(customNutrientOptions(3)[0]).toEqual({
      id: "4",
      label: "Shared name (mg)",
      disabled: false,
    });
    for (const [index, row] of rows.entries()) {
      const select = field(`Nutrient ${index + 1}`);
      for (const nutrientId of [String(row[0]), row[0] === "3" ? "4" : "3", "99"]) {
        invoke(select, "onChange", { target: { value: nutrientId } });
      }
    }
    await hooks.settle();
    expect(formValues()).toEqual(original);
    expect(status()).toBe(message);
    await change("Nutrient 2", "2");
    expect(customNutrientValues()[1]).toEqual(["2", "quantified", "0"]);
    expect(customNutrientOptions(1).at(-1)).toEqual({
      id: "3",
      label: "Shared name (ug)",
      disabled: false,
    });
    await change("Nutrient 1", "3");
    expect(customNutrientValues()[0]).toEqual(["3", "quantified", "0"]);
    await click("Remove nutrient 3");
    expect(customNutrientOptions(2)[0]).toEqual({
      id: "4",
      label: "Shared name (mg)",
      disabled: false,
    });
    await change("Nutrient 2", "4");
    expect(customNutrientValues()).toEqual([
      ["3", "quantified", "0"],
      ["4", "quantified", "0"],
      ...rows.slice(3),
    ]);
    expect(field("Name").props.value).toBe(" Raw nutrient draft ");
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("fences competing callbacks before paint and retained callbacks for a removed row", async () => {
    const saved = food();
    const second = allStates().currentVersion.nutrients[1];
    if (!second) throw new Error("Missing second fixture row");
    const source = {
      ...saved,
      currentVersion: {
        ...saved.currentVersion,
        nutrients: [...saved.currentVersion.nutrients, second],
      },
    };
    const { fetcher } = customAvailabilityWorkspace(source);
    await mount();
    await click("Revise", card(source));
    const first = field("Nutrient 1"),
      secondChoice = field("Nutrient 2"),
      before = fetcher.mock.calls.length;
    invoke(first, "onChange", { target: { value: "4" } });
    invoke(secondChoice, "onChange", { target: { value: "4" } });
    hooks.renderWithoutEffects();
    expect(customNutrientValues()).toEqual([
      ["4", "quantified", "0"],
      ["3", "quantified", "0"],
    ]);
    const removed = field("Nutrient 2");
    invoke(button("Remove nutrient 2"), "onClick");
    invoke(removed, "onChange", { target: { value: "2" } });
    await hooks.settle();
    expect(customNutrientValues()).toEqual([["4", "quantified", "0"]]);
    expect(customNutrientOptions(1).at(-1)?.disabled).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it("keeps an existing duplicated current ID enabled without silently repairing either raw row", async () => {
    const saved = food();
    const row = saved.currentVersion.nutrients[0];
    if (!row) throw new Error("Missing fixture row");
    const source = {
      ...saved,
      currentVersion: {
        ...saved.currentVersion,
        nutrients: [row, { ...row, state: "trace" as const, amountPer100Grams: null }],
      },
    };
    const { fetcher } = customAvailabilityWorkspace(source);
    await mount();
    await click("Revise", card(source));
    const rows = customNutrientValues(),
      before = fetcher.mock.calls.length;
    for (const index of [1, 2]) {
      expect(customNutrientOptions(index).find((item) => item.id === "2")).toEqual({
        id: "2",
        label: "Protein (g)",
        disabled: false,
      });
      await change(`Nutrient ${index}`, "2");
    }
    expect(customNutrientValues()).toEqual(rows);
    await change("Nutrient 2", "4");
    expect(customNutrientValues()).toEqual([rows[0], ["4", "quantified", "0"]]);
    expect(customNutrientOptions(2).find((item) => item.id === "2")?.disabled).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(before);
  });
});

const discardCustomRevise = "Discard draft and revise";
function customDraftChoiceText() {
  return text(elements().find((node) => node.props.id === "custom-draft-choice") ?? null);
}

describe("web custom-food dirty Revise protection", () => {
  it("keeps dirty new and revised raw drafts intact, focuses the safe choice, and revises clean baselines directly", async () => {
    const first = allStates(),
      base = food(2);
    const second = {
      ...base,
      revision: "7",
      currentVersion: { ...base.currentVersion, versionNumber: 7 },
    };
    const { state, fetcher, writes } = workspace([first, second]);
    await mount();
    await change("Name", "  unfinished  ");
    await change("Notes (optional)", "  raw\n notes  ");
    const rawNew = formValues(),
      requests = fetcher.mock.calls.length,
      message = status();
    const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
    vi.stubGlobal("crypto", { randomUUID: allocate });
    invoke(button("Revise", card(first)), "onClick");
    hooks.renderWithoutEffects();
    const keepFocus = vi.fn(),
      nameFocus = vi.fn();
    (button("Keep editing").props.ref as { current: unknown }).current = { focus: keepFocus };
    (field("Name").props.ref as { current: unknown }).current = { focus: nameFocus };
    hooks.render();
    expect(keepFocus).toHaveBeenCalledOnce();
    expect(customDraftChoiceText()).toContain(`revise saved ${first.currentVersion.name} v1.`);
    await click("Keep editing");
    expect(formValues()).toEqual(rawNew);
    expect(status()).toBe(message);
    expect(nameFocus).not.toHaveBeenCalled();
    await click("Revise", card(first));
    await click(discardCustomRevise);
    expect(nameFocus).toHaveBeenCalledOnce();
    expect(button("Save new version")).toBeDefined();
    expect(customNutrientValues()).toEqual(
      first.currentVersion.nutrients
        .map((row) => [
          row.nutrient.id,
          row.state,
          row.state === "unknown" ? row.reason : row.amountPer100Grams,
        ])
        .map((row) => (row[1] === "trace" ? row.slice(0, 2) : row)),
    );
    await change("Name", `${first.currentVersion.name} `);
    await change("Serving grams", "001.2500");
    await change("Amount per 100 grams 1", " 001.2300 ");
    const rawRevision = formValues();
    await click("Revise", card(second));
    expect(customDraftChoiceText()).toContain(`revise saved ${second.currentVersion.name} v7.`);
    await click("Keep editing");
    expect(formValues()).toEqual(rawRevision);
    await change("Name", first.currentVersion.name);
    await change("Serving grams", first.currentVersion.serving?.grams ?? "");
    await change("Amount per 100 grams 1", longAmount);
    await click("Revise", card(second));
    expect(customDraftChoiceText()).toBe("");
    expect(field("Name").props.value).toBe(second.currentVersion.name);
    expect(nameFocus).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(allocate).not.toHaveBeenCalled();
    state.write = () => Response.json({ error: "Ambiguous revision" }, { status: 503 });
    await submit("Save new version");
    await submit("Save new version");
    expect(writes()).toHaveLength(2);
    expect(writes()[0]?.[0]).toBe(`/api/retention/custom-foods/${second.id}/revisions`);
    expect(new Headers(writes()[0]?.[1]?.headers).get("if-match")).toBe('"7"');
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual(savedRequest(second));
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
  });

  it("keeps copied drafts dirty and their ambiguous create retry intact until explicitly revising the saved identity", async () => {
    const first = food();
    const { state, fetcher, writes } = workspace([first]);
    await mount();
    await copyFood(first);
    state.write = () => Response.json({ error: "Receipt unavailable" }, { status: 503 });
    await submit("Create private food");
    const original = writes()[0]?.[1],
      raw = formValues(),
      requests = fetcher.mock.calls.length;
    await click("Revise", card(first));
    expect(customDraftChoiceText()).toContain(`revise saved ${first.currentVersion.name} v1.`);
    await click("Keep editing");
    expect(formValues()).toEqual(raw);
    expect(fetcher.mock.calls).toHaveLength(requests);
    await submit("Create private food");
    expect(writes()[1]?.[1]?.body).toBe(original?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(original?.headers).get("idempotency-key"),
    );
    await click("Revise", card(first));
    await click(discardCustomRevise);
    expect(button("Save new version")).toBeDefined();
    expect(text(customForm())).not.toContain("New draft copied");
    await submit("Save new version");
    expect(writes()[2]?.[0]).toBe(`/api/retention/custom-foods/${first.id}/revisions`);
    expect(writes()[2]?.[1]?.body).toBe(original?.body);
    expect(new Headers(writes()[2]?.[1]?.headers).get("if-match")).toBe('"1"');
    expect(new Headers(original?.headers).has("if-match")).toBe(false);
  });

  it("fences competing Copy/Revise targets before paint and old Keep/Discard after raw edit-restore", async () => {
    const first = food(),
      second = food(2);
    const { fetcher } = workspace([first, second]);
    await mount();
    await change("Name", "Raw draft");
    const requests = fetcher.mock.calls.length,
      originalCopy = copyButton(second),
      originalRevise = button("Revise", card(second));
    invoke(button("Revise", card(first)), "onClick");
    invoke(originalCopy, "onClick");
    invoke(originalRevise, "onClick");
    hooks.renderWithoutEffects();
    expect(customDraftChoiceText()).toContain(`revise saved ${first.currentVersion.name} v1.`);
    const oldDiscard = button(discardCustomRevise),
      oldKeep = button("Keep editing");
    invoke(copyButton(second), "onClick");
    invoke(oldDiscard, "onClick");
    invoke(oldKeep, "onClick");
    hooks.renderWithoutEffects();
    expect(customDraftChoiceText()).toContain(`copy saved ${second.currentVersion.name} v1.`);
    const oldCopyDiscard = button(discardCustomCopy),
      oldCopy = copyButton(first);
    invoke(button("Revise", card(second)), "onClick");
    invoke(oldCopyDiscard, "onClick");
    invoke(oldCopy, "onClick");
    hooks.renderWithoutEffects();
    expect(customDraftChoiceText()).toContain(`revise saved ${second.currentVersion.name} v1.`);
    const beforeEdit = button(discardCustomRevise);
    invoke(field("Name"), "onChange", { target: { value: "Temporary" } });
    hooks.renderWithoutEffects();
    invoke(field("Name"), "onChange", { target: { value: "Raw draft" } });
    hooks.renderWithoutEffects();
    invoke(beforeEdit, "onClick");
    invoke(oldKeep, "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe("Raw draft");
    expect(customDraftChoiceText()).toBe("");
    await click("Revise", card(second));
    await click(discardCustomRevise);
    expect(field("Name").props.value).toBe(second.currentVersion.name);
    expect(button("Save new version")).toBeDefined();
    expect(fetcher.mock.calls).toHaveLength(requests);
  });
});

describe("My foods selected-day continuity", () => {
  it.each([
    ["date=2026-09-09", "2026-09-09"],
    ["date=2024-02-29", "2024-02-29"],
    ["date=2026-02-29", "2026-09-13"],
    ["date=invalid", "2026-09-13"],
    ["date=2026-09-08&date=2026-09-09", "2026-09-13"],
    ["", "2026-09-13"],
  ])("opens a new log for validated query %s", async (search, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T03:00:00.000Z"));
    navigation.search = search;
    workspace([food()]);
    await mount();
    await click("Log pinned v1", card(food()));
    expect(field("Local date").props.value).toBe(expected);
  });

  it("preserves raw editor and explicit log dates, exact retry body and key while the selected route day changes", async () => {
    const first = food();
    const { state, fetcher, writes } = workspace([first]);
    navigation.search = "date=2026-09-08";
    await mount();
    await click("Revise", card(first));
    await change("Name", "  Preserved raw draft  ");
    await change("Notes (optional)", "  Exact notes  ");
    await click("Log pinned v1", card(first));
    await change("Local date", "2026-09-07");
    await change("Local time", "13:14");
    await change("Exact quantity", "2.375");
    const draft = formValues();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await submit("Log exact version");
    const requests = fetcher.mock.calls.length;
    navigation.search = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    expect(formValues()).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(button("Log exact version").props.disabled).toBe(true);
    pending.resolve(Response.json({ error: "Receipt unavailable" }, { status: 503 }));
    await hooks.settle();
    state.write = () => Response.json({ error: "Still unavailable" }, { status: 503 });
    await submit("Log exact version");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({
      customFoodVersionId: first.currentVersion.id,
      portion: { kind: "serving", servingId: "1", amount: "2.375" },
      mealSlot: "snacks",
      occurredAt: "2026-09-07T18:14:00.000Z",
    });
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
    await click("Cancel");
    await click("Log pinned v1", card(first));
    expect(field("Local date").props.value).toBe("2026-09-10");
    expect(field("Name").props.value).toBe("  Preserved raw draft  ");
    expect(field("Notes (optional)").props.value).toBe("  Exact notes  ");
  });

  it("rejects a retained log-opening callback from an earlier selected day and leaves an open log unchanged", async () => {
    const first = food();
    const { fetcher } = workspace([first]);
    navigation.search = "date=2026-09-08";
    await mount();
    const oldOpen = button("Log pinned v1", card(first));
    const requests = fetcher.mock.calls.length;
    navigation.search = "date=2026-09-09";
    hooks.renderWithoutEffects();
    invoke(oldOpen, "onClick");
    await hooks.settle();
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Log exact version"),
    ).toBe(false);
    await click("Log pinned v1", card(first));
    expect(field("Local date").props.value).toBe("2026-09-09");
    navigation.search = "date=2026-09-10";
    hooks.render();
    await hooks.settle();
    expect(field("Local date").props.value).toBe("2026-09-09");
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await click("Cancel");
    await click("Log pinned v1", card(first));
    expect(field("Local date").props.value).toBe("2026-09-10");
  });

  it("uses profile today for the next log after removing the selected day while preserving the current draft", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T03:00:00.000Z"));
    const first = food();
    const { fetcher } = workspace([first]);
    navigation.search = "date=2026-09-08";
    await mount();
    await change("Name", "Unsaved editor after route removal");
    await click("Log pinned v1", card(first));
    await change("Local date", "2026-09-07");
    const oldOpen = button("Log pinned v1", card(first));
    const requests = fetcher.mock.calls.length;
    navigation.search = "";
    hooks.renderWithoutEffects();
    invoke(oldOpen, "onClick");
    await hooks.settle();
    expect(field("Local date").props.value).toBe("2026-09-07");
    expect(field("Name").props.value).toBe("Unsaved editor after route removal");
    await click("Cancel");
    invoke(oldOpen, "onClick");
    await hooks.settle();
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Log exact version"),
    ).toBe(false);
    await click("Log pinned v1", card(first));
    expect(field("Local date").props.value).toBe("2026-09-13");
    expect(field("Name").props.value).toBe("Unsaved editor after route removal");
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });
});

describe("My foods invalid local logging times", () => {
  it.each([
    ["", "13:14", "Invalid local diary time."],
    ["invalid", "13:14", "Invalid local diary time."],
    ["2026-02-29", "13:14", "Invalid local diary time."],
    ["2026-09-09", "", "Invalid local diary time."],
    ["2026-09-09", "25:99", "Invalid local diary time."],
    ["2026-03-08", "02:30", "That local time does not exist in the selected time zone."],
  ])(
    "keeps date %s and time %s editable without allocating or sending an operation",
    async (date, time, error) => {
      const first = food();
      const { state, writes } = workspace([first]);
      await mount();
      await click("Log pinned v1", card(first));
      await change("Local date", date);
      await change("Local time", time);
      await change("Exact quantity", "2.375");
      const original = formValues();
      const allocate = vi.fn(() => "cdfd121e-6fbc-42f5-8630-e1cb60f9c351");
      vi.stubGlobal("crypto", { randomUUID: allocate });
      await submit("Log exact version");
      expect(status()).toBe(error);
      expect(formValues()).toEqual(original);
      expect(writes()).toHaveLength(0);
      expect(allocate).not.toHaveBeenCalled();
      expect(button("Log exact version").props.disabled).toBe(false);
      await change("Local date", "2026-09-09");
      await change("Local time", "13:14");
      state.write = () => Response.json({ error: "Receipt unavailable" }, { status: 503 });
      await submit("Log exact version");
      expect(writes()).toHaveLength(1);
      expect(allocate).toHaveBeenCalledOnce();
      expect(JSON.parse(String(writes()[0]?.[1]?.body)).occurredAt).toBe(
        "2026-09-09T18:14:00.000Z",
      );
      expect(field("Exact quantity").props.value).toBe("2.375");
      expect(button("Log exact version").props.disabled).toBe(false);
    },
  );
});

function logForm() {
  const found = elements().find(
    (node) => node.type === "form" && text(node).includes("Log exact version"),
  );
  if (!found) throw new Error("Missing pinned food log form");
  return found;
}
function logReceipt() {
  return Response.json({
    data: {
      replayed: false,
      entry: null,
      affectedDays: [{ localDate: "2026-09-09", revision: "1" }],
    },
  });
}
async function prepareLog() {
  await click("Log pinned v1", card(food()));
  await change("Local date", "2026-09-09");
  await change("Local time", "13:14");
  await change("Exact quantity", "2.375");
}

describe("My foods pinned log lifecycle", () => {
  it.each(["edit-restore", "cancel-reopen", "selected-day", "background"])(
    "rejects retained fields, submit and Cancel after %s while current controls stay usable",
    async (transition) => {
      const view = visibility();
      const { fetcher, writes } = workspace([food()]);
      navigation.search = "date=2026-09-08";
      await mount();
      await prepareLog();
      const form = logForm();
      const inputs = elements(form).filter((node) => typeof node.props.onChange === "function");
      const cancel = button("Cancel");
      if (transition === "edit-restore") {
        await change("Exact quantity", "3.125");
        await change("Exact quantity", "2.375");
      } else if (transition === "cancel-reopen") {
        await click("Cancel");
        await prepareLog();
      } else if (transition === "selected-day") {
        navigation.search = "date=2026-09-10";
        hooks.renderWithoutEffects();
      } else {
        await view.set("hidden");
        await view.set("visible");
      }
      const original = formValues(),
        requests = fetcher.mock.calls.length;
      for (const input of inputs) invoke(input, "onChange", { target: { value: "stale" } });
      invoke(form, "onSubmit", { preventDefault() {} });
      invoke(cancel, "onClick");
      await hooks.settle();
      expect(formValues()).toEqual(original);
      expect(fetcher).toHaveBeenCalledTimes(requests);
      expect(writes()).toHaveLength(0);
      await change("Exact quantity", "4.125");
      expect(field("Exact quantity").props.value).toBe("4.125");
      await click("Cancel");
      expect(
        elements().some((node) => node.type === "button" && text(node) === "Log exact version"),
      ).toBe(false);
    },
  );

  it("keeps an accepted older request from erasing newer edits and retains exact A-to-B-to-A retry IDs and bodies", async () => {
    const { state, writes } = workspace([food()]);
    await mount();
    await prepareLog();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    const form = logForm();
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes()).toHaveLength(1);
    await change("Exact quantity", "3.125");
    expect(field("Exact quantity").props.value).toBe("3.125");
    pending.resolve(logReceipt());
    await hooks.settle();
    expect(field("Exact quantity").props.value).toBe("3.125");
    expect(button("Log exact version").props.disabled).toBe(false);
    expect(status()).not.toContain("version logged");
    state.write = () => Response.json({ error: "Ambiguous replay" }, { status: 503 });
    await change("Exact quantity", "2.375");
    await submit("Log exact version");
    await submit("Log exact version");
    await change("Exact quantity", "3.125");
    await submit("Log exact version");
    await change("Exact quantity", "2.375");
    await submit("Log exact version");
    const attempts = writes();
    expect(attempts).toHaveLength(5);
    const keys = attempts.map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys[4]).toBe(keys[0]);
    for (const index of [1, 2, 4]) expect(attempts[index]?.[1]?.body).toBe(attempts[0]?.[1]?.body);
    expect(attempts[3]?.[1]?.body).not.toBe(attempts[0]?.[1]?.body);
    state.write = () => logReceipt();
    await submit("Log exact version");
    expect(
      elements().some((node) => node.type === "button" && text(node) === "Log exact version"),
    ).toBe(false);
    expect(status()).toContain("version logged");
    await prepareLog();
    state.write = () => Response.json({ error: "New log response unavailable" }, { status: 503 });
    await submit("Log exact version");
    expect(new Headers(writes().at(-1)?.[1]?.headers).get("idempotency-key")).not.toBe(keys[0]);
  });

  it.each(["fetch", "json"])(
    "ignores an older log receipt at %s after a later edit",
    async (boundary) => {
      const { state, fetcher } = workspace([food()]);
      await mount();
      await prepareLog();
      const pending = deferred<Response>(),
        parsed = deferred<unknown>();
      const response = logReceipt();
      const parse = vi.fn(() => parsed.promise);
      if (boundary === "json") response.json = parse;
      state.write = () => (boundary === "fetch" ? pending.promise : response);
      await submit("Log exact version");
      await change("Exact quantity", "3.125");
      const original = formValues(),
        requests = fetcher.mock.calls.length;
      if (boundary === "fetch") {
        const expired = Response.json({ error: "Old expiry" }, { status: 401 });
        expired.json = parse;
        pending.resolve(expired);
      } else
        parsed.resolve({
          data: {
            replayed: false,
            entry: null,
            affectedDays: [{ localDate: "2026-09-09", revision: "1" }],
          },
        });
      await hooks.settle();
      if (boundary === "fetch") expect(parse).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(formValues()).toEqual(original);
      expect(fetcher).toHaveBeenCalledTimes(requests);
      expect(button("Log exact version").props.disabled).toBe(false);
    },
  );

  it.each(["owner", "expired", "unmount"])(
    "rejects retained log callbacks and delayed receipts after %s closes its scope",
    async (transition) => {
      const { state, fetcher, writes } = workspace([food()]);
      state.cursor = "next";
      await mount();
      await prepareLog();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      const form = logForm(),
        cancel = button("Cancel");
      const inputs = elements(form).filter((node) => typeof node.props.onChange === "function");
      await submit("Log exact version");
      if (transition === "unmount") hooks.unmount();
      else {
        state.continuation = () => {
          if (transition === "owner") {
            state.owner = otherOwner;
            return page([]);
          }
          return Response.json({ error: "Expired" }, { status: 401 });
        };
        await click("Load more private foods");
        expect(router.replace).toHaveBeenCalledWith("/login");
        expect(savedCards()).toHaveLength(0);
      }
      const before = fetcher.mock.calls.length,
        updates = hooks.afterClose(),
        rendered = text();
      const stale = logReceipt(),
        parse = vi.spyOn(stale, "json");
      pending.resolve(stale);
      for (const input of inputs) invoke(input, "onChange", { target: { value: "stale" } });
      invoke(form, "onSubmit", { preventDefault() {} });
      invoke(cancel, "onClick");
      await hooks.settle();
      expect(parse).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(before);
      expect(writes()).toHaveLength(1);
      expect(hooks.afterClose()).toBe(updates);
      expect(text()).toBe(rendered);
    },
  );
});

describe("My foods guarded time-zone recovery", () => {
  it.each(["America/Chicago", "America/New_York"])(
    "requires current date review after a no-write conflict refreshed to %s",
    async (zone) => {
      const { state, writes } = workspace([food()]);
      await mount();
      await prepareLog();
      const oldForm = logForm();
      state.write = () => {
        state.timeZone = zone;
        return Response.json(
          { error: "Zone changed", code: "DIARY_TIME_ZONE_CHANGED" },
          { status: 409 },
        );
      };
      await submit("Log exact version");
      expect(writes()).toHaveLength(1);
      expect(field("Local date").props.value).toBe("2026-09-09");
      expect(field("Exact quantity").props.value).toBe("2.375");
      expect(button("Log exact version").props.disabled).toBe(true);
      expect(text()).toContain("This private food was not logged");
      const confirm = button("Confirm 2026-09-09 as local day");
      await change("Local date", "2026-09-10");
      await change("Local date", "2026-09-09");
      invoke(confirm, "onClick");
      invoke(oldForm, "onSubmit", { preventDefault() {} });
      invoke(logForm(), "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(writes()).toHaveLength(1);
      expect(button("Log exact version").props.disabled).toBe(true);
      await click("Confirm 2026-09-09 as local day");
      expect(button("Log exact version").props.disabled).toBe(false);
      state.write = () => Response.json({ error: "New response unavailable" }, { status: 503 });
      await submit("Log exact version");
      expect(writes()).toHaveLength(2);
      const original = new Headers(writes()[0]?.[1]?.headers);
      const reviewed = new Headers(writes()[1]?.[1]?.headers);
      expect(reviewed.get("idempotency-key")).not.toBe(original.get("idempotency-key"));
      expect(original.get("x-expected-profile-time-zone")).toBe("America/Chicago");
      expect(reviewed.get("x-expected-profile-time-zone")).toBe(zone);
      expect(JSON.parse(String(writes()[1]?.[1]?.body)).occurredAt).toBe(
        zone === "America/Chicago" ? "2026-09-09T18:14:00.000Z" : "2026-09-09T17:14:00.000Z",
      );
      if (zone === "America/Chicago") expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
      expect(writes()[1]?.[0]).toBe(
        `/api/retention/custom-foods/${food().id}/log?profileTimeZonePrecondition=v1`,
      );
    },
  );
});
