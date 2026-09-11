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
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import type {
  BiometricDefinition,
  BiometricEvent,
  CustomFood,
  Reminder,
} from "../../lib/retention";
import { HealthClient } from "./HealthClient";

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
    trend: null as null | ((url: string) => Response),
    auth: null as null | (() => Response | Promise<Response>),
    cursor: null as string | null,
    owner,
    timeZone: "America/Chicago",
    read: null as null | (() => Response | Promise<Response>),
    continuation: null as null | (() => Response | Promise<Response>),
    write: null as null | ((url: string, init: RequestInit) => Response | Promise<Response>),
    eventRead: null as null | ((url: string) => Response | Promise<Response>),
    definitions: [] as readonly BiometricDefinition[],
    reminders: [] as readonly Reminder[],
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/auth/me")
      return state.auth ? state.auth() : session(state.owner, state.timeZone);
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    if (init?.method && init.method !== "GET") {
      if (!state.write) throw new Error(`Unexpected write: ${url}`);
      return state.write(url, init);
    }
    if (url === "/api/retention/custom-foods?limit=50")
      return state.read ? state.read() : page(state.items, state.cursor);
    if (url.startsWith("/api/retention/custom-foods?limit=50&cursor=")) {
      if (!state.continuation) throw new Error("Unexpected continuation.");
      return state.continuation();
    }
    if (url === "/api/nutrients/targetable") return Response.json({ data: state.picker });
    if (url.startsWith("/api/retention/trends/"))
      return state.trend
        ? state.trend(url)
        : Response.json({ error: "No trend fixture" }, { status: 503 });
    if (url.startsWith("/api/retention/biometrics/events?"))
      return state.eventRead
        ? state.eventRead(url)
        : Response.json({ data: [], page: { nextCursor: null } });
    if (url === "/api/retention/biometrics/definitions")
      return Response.json({ data: state.definitions });
    if (url === "/api/retention/reminders") return Response.json({ data: state.reminders });
    if (
      [
        "/api/nutrients/targetable",
        "/api/retention/biometrics/definitions",
        "/api/retention/reminders",
        "/api/retention/integrations/health",
      ].includes(url)
    )
      return Response.json({ data: [] });
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
  hooks.mount(HealthClient);
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
});

describe("actual saved custom-food nutrient disclosures", () => {
  it("shows exact saved metadata, every state and original order without picker data or requests", async () => {
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
      longAmount,
      "0",
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

  it("renders all 256 saved rows, including repeated names and long exact values", async () => {
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
    ).toEqual(Array(256).fill(longAmount));
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

  it("does not change a parsed trend or start reads while filtering", async () => {
    const { state, fetcher } = workspace([food()]);
    state.picker = [
      { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
    ];
    state.trend = (path) => {
      const params = new URL(path, "http://127.0.0.1").searchParams;
      const from = params.get("from");
      const to = params.get("to");
      return Response.json({
        data: {
          nutrient: { id: "2", code: "protein", name: "Response protein", unit: "g" },
          from,
          to,
          timeZone: "America/Chicago",
          bucket: "day",
          watermarkRevision: "1",
          points: [
            {
              localDate: from,
              startsAt: `${from}T05:00:00.000Z`,
              endsAt: `${from}T23:00:00.000Z`,
              aggregate: {
                nutrientId: "2",
                code: "protein",
                name: "Response protein",
                unit: "g",
                knownAmount: "12.345",
                completeness: "complete",
                isExact: true,
                contributorCount: 1,
                quantifiedCount: 1,
                traceCount: 0,
                unknownCount: 0,
                unknownReasonCounts: {
                  not_reported: 0,
                  not_analyzed: 0,
                  not_applicable: 0,
                  withheld: 0,
                },
              },
            },
          ],
        },
      });
    };
    await mount();
    const before = otherFields();
    const trendText = () => text(elements().find((node) => node.props.className === "trendTables"));
    const beforeTrend = trendText();
    expect(beforeTrend).toContain("12.345");
    const requests = fetcher.mock.calls.length;
    await change(savedFilterLabel, "absent");
    await click(clearFilterLabel);
    expect(trendText()).toBe(beforeTrend);
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

  it("rejects retained original field, row, Revise, Cancel and submit controls after Copy", async () => {
    const first = food();
    const { fetcher, writes } = workspace([first]);
    await mount();
    await click("Revise", card(first));
    const originalFields = elements(customForm()).filter(
      (node) => typeof node.props.onChange === "function",
    );
    const oldRemove = button("Remove nutrient 1");
    const oldAdd = button("Add nutrient");
    const oldRevise = button("Revise", card(first));
    const oldCancel = button("Cancel edit");
    const oldForm = customForm();
    await copyFood(first);
    const before = formValues();
    const requests = fetcher.mock.calls.length;
    for (const node of originalFields) invoke(node, "onChange", { target: { value: "stale" } });
    for (const node of [oldRemove, oldAdd, oldRevise, oldCancel]) invoke(node, "onClick");
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(formValues()).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(writes()).toHaveLength(0);
  });

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

  it("blocks Copy and duplicate saves through its own pending write after unrelated work completes", async () => {
    const first = food();
    const { state, writes } = workspace([first]);
    state.cursor = "next";
    await mount();
    await copyFood(first);
    const oldCopy = copyButton(first);
    const oldSubmit = customForm();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    invoke(oldCopy, "onClick");
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    state.continuation = () => page([food(2)]);
    await click("Load more private foods");
    expect(copyButton(first).props.disabled).toBe(true);
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

  it("closes choice on full refresh, background and unmount without reusing old controls", async () => {
    const view = visibility();
    const first = food();
    const { fetcher } = workspace([first]);
    await mount();
    await change("Name", "Draft");
    await copyFood(first);
    const oldDiscard = button(discardCustomCopy);
    const oldCopy = copyButton(first);
    await view.set("hidden");
    invoke(oldDiscard, "onClick");
    await view.set("visible");
    invoke(oldCopy, "onClick");
    await hooks.settle();
    expect(field("Name").props.value).toBe("Draft");
    expect(elements().some((node) => text(node) === discardCustomCopy)).toBe(false);
    await copyFood(first);
    hooks.replayEffects();
    await hooks.settle();
    expect(elements().some((node) => text(node) === discardCustomCopy)).toBe(false);
    const before = fetcher.mock.calls.length;
    hooks.unmount();
    const updates = hooks.afterClose();
    invoke(oldDiscard, "onClick");
    invoke(oldCopy, "onClick");
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});

const historyDay = 86_400_000;
const historySpan = 121 * historyDay;
const historyDefinition: BiometricDefinition = {
  id: "4bcfa2bf-4950-43f7-9f24-000000000001",
  revision: "1",
  status: "active",
  name: "Weight",
  dimension: "mass",
  canonicalUnit: "kg",
  notes: null,
  createdAt: instant,
  updatedAt: instant,
};
function reading(index = 1, measuredAt = "2026-09-10T12:34:56.789Z"): BiometricEvent {
  return {
    id: `5bcfa2bf-4950-43f7-9f24-${String(index).padStart(12, "0")}`,
    revision: "1",
    definitionId: historyDefinition.id,
    measuredAt,
    localDate: measuredAt.slice(0, 10),
    timeZone: "UTC",
    value: `${index}.200`,
    source: { kind: "manual", deviceId: null, externalId: null, externalRevision: null },
    createdAt: instant,
    updatedAt: instant,
  };
}
function eventPage(items: readonly BiometricEvent[], cursor: string | null = null) {
  return Response.json({ data: items, page: { nextCursor: cursor } });
}
function historyWorkspace(now = instant) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const result = workspace();
  result.state.definitions = [historyDefinition];
  result.state.timeZone = "UTC";
  result.state.eventRead = (url) => {
    const range = requestRange(url),
      event = reading();
    return eventPage(
      Date.parse(event.measuredAt) >= Date.parse(range.from) &&
        Date.parse(event.measuredAt) <= Date.parse(range.to)
        ? [event]
        : [],
    );
  };
  return {
    ...result,
    eventReads: () =>
      result.fetcher.mock.calls.filter(([url]) =>
        url.startsWith("/api/retention/biometrics/events?"),
      ),
  };
}
function biometricSection() {
  const node = elements().find((node) => node.props["aria-labelledby"] === "biometrics-heading");
  if (!node) throw new Error("Missing biometric section");
  return node;
}
function eventRows() {
  return elements(biometricSection()).filter(
    (node) =>
      node.type === "li" &&
      elements(node).some((child) => child.type === "small" && text(child).includes(" · UTC · ")),
  );
}
function eventField(label: string) {
  const wrapper = elements(biometricSection()).find(
    (node) => node.type === "label" && text(node).trim() === label,
  );
  const input = elements(wrapper ?? null).find((node) =>
    ["input", "select"].includes(String(node.type)),
  );
  if (!input) throw new Error(`Missing event field ${label}`);
  return input;
}
async function changeEvent(label: string, value: string) {
  invoke(eventField(label), "onChange", { target: { value } });
  await hooks.settle();
}
function historyStatus() {
  return text(elements().find((node) => node.props.id === "biometric-history-status"));
}
function eventForm() {
  const form = elements(biometricSection()).find(
    (node) =>
      node.type === "form" &&
      (text(node).includes("Edit manual event") || text(node).includes("Log event")),
  );
  if (!form) throw new Error("Missing event form");
  return form;
}
async function saveReading() {
  invoke(eventForm(), "onSubmit", { preventDefault() {} });
  await hooks.settle();
}
function requiredHistory<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected history fixture value");
  return value;
}
function requestRange(url: string | undefined) {
  const params = new URL(requiredHistory(url), "http://localhost").searchParams;
  return {
    from: requiredHistory(params.get("from")),
    to: requiredHistory(params.get("to")),
    cursor: params.get("cursor"),
    limit: params.get("limit"),
  };
}

describe("biometric history windows", () => {
  it("moves exact inclusive121day windows, keeps a captured Recent anchor and preserves every raw form/disclosure", async () => {
    const { eventReads, fetcher } = historyWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.23000");
    await changeEvent("Local time", "13:14");
    await change("Name", " Unsaved custom food ");
    await change("Private in-app label", " Raw reminder ");
    await change("From", "2026-08-01");
    await toggle(food());
    const forms = formValues(),
      message = status(),
      before = fetcher.mock.calls.length;
    const original = requestRange(eventReads()[0]?.[0]);
    expect(original).toEqual({
      from: new Date(Date.parse(instant) - 120 * historyDay).toISOString(),
      to: new Date(Date.parse(instant) + historyDay).toISOString(),
      cursor: null,
      limit: "100",
    });
    expect(button("Newer window").props.disabled).toBe(true);
    expect(button("Recent history").props.disabled).toBe(true);
    await click("Earlier window");
    const earlier = requestRange(eventReads()[1]?.[0]);
    expect(earlier.to).toBe(original.from);
    expect(Date.parse(earlier.to) - Date.parse(earlier.from)).toBe(historySpan);
    expect(historyStatus()).toContain(
      `${earlier.from} through ${earlier.to}. Includes both endpoints`,
    );
    expect(formValues()).toEqual(forms);
    expect(status()).toBe(message);
    expect(details(food()).props.hidden).toBe(false);
    expect(fetcher.mock.calls.slice(before).map(([url]) => url.split("?")[0])).toEqual([
      "/api/retention/biometrics/events",
      "/api/auth/me",
    ]);
    await click("Earlier window");
    await click("Newer window");
    expect(requestRange(eventReads()[3]?.[0])).toEqual(earlier);
    vi.setSystemTime(new Date(Date.parse(instant) + 10 * historyDay));
    await click("Recent history");
    expect(requestRange(eventReads()[4]?.[0])).toEqual(original);
    expect(formValues()).toEqual(forms);
    expect(status()).toBe(message);
  });

  it("loads100 then overlap/new IDs then empty terminal in server order, retaining boundary readings", async () => {
    const { state, eventReads } = historyWorkspace();
    const recentFrom = new Date(Date.parse(instant) - 120 * historyDay).toISOString();
    const items = Array.from({ length: 100 }, (_, index) =>
      reading(
        index + 1,
        index === 0 ? recentFrom : new Date(Date.parse(recentFrom) - index * 1000).toISOString(),
      ),
    );
    state.eventRead = (url) => {
      const range = requestRange(url);
      if (!range.cursor)
        return eventPage(range.from === recentFrom ? items.slice(0, 1) : items, "history.one");
      if (range.cursor === "history.one")
        return eventPage(
          [
            { ...requiredHistory(items[99]), value: "999.000" },
            reading(101, requiredHistory(items[99]).measuredAt),
            reading(102, requiredHistory(items[99]).measuredAt),
          ],
          "history.two",
        );
      return eventPage([]);
    };
    await mount();
    await click("Earlier window");
    expect(eventRows()).toHaveLength(100);
    expect(text(eventRows()[0])).toContain("1.200");
    await click("Load older biometric events");
    expect(eventRows()).toHaveLength(102);
    expect(text(eventRows()[99])).toContain("100.200");
    expect(text(eventRows()[100])).toContain("101.200");
    expect(historyStatus()).toContain("102 loaded readings");
    const first = requestRange(eventReads()[1]?.[0]),
      page = requestRange(eventReads()[2]?.[0]);
    expect(page).toEqual({ ...first, cursor: "history.one" });
    await click("Load older biometric events");
    expect(eventRows()).toHaveLength(102);
    expect(historyStatus()).toContain("No more readings in this window");
    expect(
      elements().some(
        (node) => node.type === "button" && text(node) === "Load older biometric events",
      ),
    ).toBe(false);
  });

  it.each([null, "empty.next"])(
    "keeps empty windows navigable with truthful cursor%s status",
    async (cursor) => {
      const { state } = historyWorkspace();
      state.eventRead = () => eventPage([], cursor);
      await mount();
      expect(historyStatus()).toContain("0 loaded readings");
      expect(historyStatus()).toContain(
        cursor ? "More readings may be available" : "No more readings in this window",
      );
      await click("Earlier window");
      expect(eventRows()).toHaveLength(0);
      expect(button("Recent history").props.disabled).toBe(false);
    },
  );

  it.each(["503", "malformed", "400"])(
    "retains exact continuation state after%s and explicitly recovers",
    async (failure) => {
      const { state, eventReads } = historyWorkspace();
      let fail = true;
      state.eventRead = (url) =>
        !requestRange(url).cursor
          ? eventPage([reading()], "same.cursor")
          : fail
            ? failure === "malformed"
              ? Response.json({ data: [], page: { nextCursor: "bad!" } })
              : Response.json({ error: "Page failure" }, { status: Number(failure) })
            : eventPage([reading(2)]);
      await mount();
      const loaded = text(eventRows()[0]);
      await click("Load older biometric events");
      expect(text(eventRows()[0])).toBe(loaded);
      expect(historyStatus()).not.toContain("No more readings in this window");
      fail = false;
      if (failure === "400") {
        expect(historyStatus()).toContain("Choose Reload history");
        await click("Reload history");
        expect(requestRange(eventReads()[2]?.[0]).cursor).toBeNull();
      } else {
        await click("Load older biometric events");
        expect(eventReads()[2]?.[0]).toBe(eventReads()[1]?.[0]);
        expect(eventRows()).toHaveLength(2);
      }
    },
  );

  it("clears old rows before a moved-window request/failure and retries that exact target", async () => {
    const { state, eventReads } = historyWorkspace();
    await mount();
    const pending = deferred<Response>();
    state.eventRead = () => pending.promise;
    const oldEdit = button("Edit", eventRows()[0]);
    const oldDelete = button("Delete", eventRows()[0]);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const earlier = button("Earlier window");
    invoke(earlier, "onClick");
    invoke(earlier, "onClick");
    invoke(oldEdit, "onClick");
    invoke(oldDelete, "onClick");
    await hooks.settle();
    expect(eventRows()).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(eventReads()).toHaveLength(2);
    expect(button("Reload history").props.disabled).toBe(true);
    const target = requestRange(eventReads()[1]?.[0]);
    expect(historyStatus()).toContain(target.from);
    pending.resolve(Response.json({ error: "Try again" }, { status: 503 }));
    await hooks.settle();
    expect(historyStatus()).toContain("This window has not been verified");
    state.eventRead = () => eventPage([reading(2, target.to)]);
    await click("Reload history");
    expect(eventReads()[2]?.[0]).toBe(eventReads()[1]?.[0]);
    expect(eventRows()).toHaveLength(1);
  });

  it.each([200, 400, 401])(
    "ignores obsolete%s before JSON/finally while a replacement read is pending",
    async (code) => {
      const view = visibility();
      const { state, eventReads, fetcher } = historyWorkspace();
      await mount();
      const first = deferred<Response>(),
        second = deferred<Response>();
      state.eventRead = () => first.promise;
      await click("Earlier window");
      await view.set("hidden");
      await view.set("visible");
      state.eventRead = () => second.promise;
      await click("Reload history");
      const before = fetcher.mock.calls.length;
      const response = Response.json({ error: "Old receipt" }, { status: code });
      const parse = vi.spyOn(response, "json");
      first.resolve(response);
      await hooks.settle();
      expect(parse).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(button("Reload history").props.disabled).toBe(true);
      invoke(button("Reload history"), "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      second.resolve(eventPage([reading(2)]));
      await hooks.settle();
      expect(eventRows()).toHaveLength(1);
      expect(eventReads()).toHaveLength(3);
    },
  );

  it("ignores deferred old JSON after a full same-owner Retry retains the exact selected range", async () => {
    const { state, eventReads } = historyWorkspace();
    await mount();
    await click("Earlier window");
    const selected = requestRange(eventReads()[1]?.[0]),
      body = deferred<unknown>();
    state.eventRead = () => {
      const response = eventPage([]);
      response.json = () => body.promise;
      return response;
    };
    await click("Reload history");
    state.eventRead = () => eventPage([reading(3, selected.to)]);
    hooks.replayEffects();
    await hooks.settle();
    expect(requestRange(eventReads()[3]?.[0])).toEqual(selected);
    body.resolve(await eventPage([reading(8)]).json());
    await hooks.settle();
    expect(text(eventRows()[0])).toContain("3.200");
    expect(historyStatus()).toContain(selected.from);
  });

  it.each(["profile", "owner", "unmount"])(
    "fences history response/controls after%s changes context",
    async (transition) => {
      const { state, fetcher } = historyWorkspace();
      await mount();
      const old = button("Earlier window");
      const pending = deferred<Response>();
      state.eventRead = () => pending.promise;
      await click("Earlier window");
      if (transition === "unmount") hooks.unmount();
      else state.auth = () => session(transition === "owner" ? otherOwner : owner, "Europe/Paris");
      pending.resolve(eventPage([reading(2)]));
      await hooks.settle();
      const before = fetcher.mock.calls.length,
        updates = hooks.afterClose();
      invoke(old, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(hooks.afterClose()).toBe(updates);
      if (transition === "owner") expect(router.replace).toHaveBeenCalledWith("/login");
      if (transition === "profile") {
        expect(historyStatus()).toContain("Your profile changed");
        expect(eventRows()).toHaveLength(0);
      }
    },
  );

  it.each(["0100-08-01T00:00:00.000Z", "9999-12-29T23:59:59.999Z"])(
    "respects conservative complete-window bounds at%s",
    async (now) => {
      const { state, eventReads } = historyWorkspace(now);
      state.eventRead = () => eventPage([]);
      await mount();
      if (now.startsWith("0100")) expect(button("Earlier window").props.disabled).toBe(true);
      else {
        await click("Earlier window");
        await click("Newer window");
        expect(button("Newer window").props.disabled).toBe(true);
      }
      for (const [url] of eventReads()) {
        const range = requestRange(url);
        expect(Date.parse(range.from)).toBeGreaterThanOrEqual(
          Date.parse("0100-01-02T00:00:00.000Z"),
        );
        expect(Date.parse(range.to)).toBeLessThanOrEqual(Date.parse("9999-12-30T23:59:59.999Z"));
        expect(Date.parse(range.to) - Date.parse(range.from)).toBe(historySpan);
      }
    },
  );
});

describe("biometric history and event operations", () => {
  it("preserves exact value-only PATCH retry and original seconds while its dirty editor is off-window", async () => {
    const { state, fetcher } = historyWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.2000");
    state.write = () => Response.json({ error: "Ambiguous saved change" }, { status: 503 });
    await saveReading();
    const first = fetcher.mock.calls.filter(
      ([url, init]) => url.includes("/biometrics/events/") && init?.method === "PATCH",
    )[0];
    expect(first?.[1]?.body).toBe(JSON.stringify({ value: "71.2000" }));
    expect(new Headers(first?.[1]?.headers).get("if-match")).toBe('"1"');
    const forms = formValues(),
      message = status();
    state.eventRead = () => eventPage([]);
    await click("Earlier window");
    expect(formValues()).toEqual(forms);
    expect(status()).toBe(message);
    await saveReading();
    const writes = fetcher.mock.calls.filter(
      ([url, init]) => url.includes("/biometrics/events/") && init?.method === "PATCH",
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.body).toBe(first?.[1]?.body);
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first?.[1]?.headers).get("idempotency-key"),
    );
    expect(eventField("Local time").props.value).toBe("12:34");
  });

  it("keeps A-to-B-to-A Create identity through history movement without changing defaults", async () => {
    const { state, fetcher } = historyWorkspace();
    await mount();
    state.write = () => Response.json({ error: "Unknown outcome" }, { status: 503 });
    await changeEvent("Exact value", "71.000");
    await saveReading();
    await click("Earlier window");
    await changeEvent("Exact value", "72.000");
    await saveReading();
    await click("Recent history");
    await changeEvent("Exact value", "71.000");
    await saveReading();
    const writes = fetcher.mock.calls.filter(
      ([url, init]) => url === "/api/retention/biometrics/events" && init?.method === "POST",
    );
    expect(writes).toHaveLength(3);
    expect(writes[0]?.[1]?.body).toBe(writes[2]?.[1]?.body);
    const keys = writes.map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({
      definitionId: historyDefinition.id,
      measuredAt: instant,
      value: "71.000",
    });
  });

  it.each(["save", "delete"])(
    "blocks history reads and duplicate%s synchronously during its live write even after unrelated busy clears",
    async (action) => {
      const { state, eventReads, fetcher } = historyWorkspace();
      state.cursor = "private.next";
      state.continuation = () => page([], null);
      await mount();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      vi.stubGlobal("window", { confirm: vi.fn(() => true) });
      await changeEvent("Exact value", "71.200");
      const earlier = button("Earlier window"),
        reload = button("Reload history"),
        remove = button("Delete", eventRows()[0]),
        form = eventForm();
      if (action === "save") invoke(form, "onSubmit", { preventDefault() {} });
      else invoke(remove, "onClick");
      invoke(earlier, "onClick");
      invoke(reload, "onClick");
      invoke(form, "onSubmit", { preventDefault() {} });
      invoke(remove, "onClick");
      await hooks.settle();
      expect(eventReads()).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== "GET"),
      ).toHaveLength(1);
      // A real independent continuation clears shared busy while the event lease stays live.
      await click("Load more private foods");
      expect(
        fetcher.mock.calls.some(([url]) =>
          url.includes("custom-foods?limit=50&cursor=private.next"),
        ),
      ).toBe(true);
      invoke(button("Reload history"), "onClick");
      await hooks.settle();
      expect(eventReads()).toHaveLength(1);
      pending.resolve(
        Response.json({
          data: {
            event: action === "save" ? { ...reading(), revision: "2", value: "71.200" } : null,
            replayed: false,
          },
        }),
      );
      await hooks.settle();
      expect(button("Earlier window").props.disabled).toBe(false);
      if (action === "save") expect(eventField("Exact value").props.value).toBe("");
      else expect(eventRows()).toHaveLength(0);
    },
  );

  it("blocks Save/Delete during history reads before paint and resumes the same editor afterward", async () => {
    const { state, fetcher } = historyWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.5");
    const remove = button("Delete", eventRows()[0]),
      form = eventForm(),
      confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const pending = deferred<Response>();
    state.eventRead = () => pending.promise;
    invoke(button("Reload history"), "onClick");
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(remove, "onClick");
    await hooks.settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(button("Save event").props.disabled).toBe(true);
    pending.resolve(eventPage([reading()]));
    await hooks.settle();
    expect(eventField("Exact value").props.value).toBe("71.5");
    expect(button("Save event").props.disabled).toBe(false);
  });

  it.each(["background", "raw-edit", "trend-metric"])(
    "accepts a valid receipt after%s, reconciling membership and clearing only the owned draft",
    async (changeKind) => {
      const view = visibility();
      const { state } = historyWorkspace();
      const otherDefinition = {
        ...historyDefinition,
        id: "4bcfa2bf-4950-43f7-9f24-000000000002",
        name: "Height",
      };
      state.definitions = [historyDefinition, otherDefinition];
      await mount();
      await click("Edit", eventRows()[0]);
      await changeEvent("Exact value", "71.9000");
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      await saveReading();
      if (changeKind === "background") await view.set("hidden");
      else if (changeKind === "raw-edit") await changeEvent("Exact value", "72.0000");
      else {
        const selector = elements().find(
          (node) => node.type === "label" && text(node).startsWith("Biometric"),
        );
        const control = elements(selector ?? null).find((node) => node.type === "select");
        invoke(requiredHistory(control), "onChange", { target: { value: otherDefinition.id } });
        await hooks.settle();
      }
      pending.resolve(
        Response.json({
          data: { event: { ...reading(), revision: "2", value: "71.9000" }, replayed: false },
        }),
      );
      await hooks.settle();
      if (changeKind === "background") {
        await view.set("visible");
        expect(eventField("Exact value").props.value).toBe("");
      } else
        expect(eventField("Exact value").props.value).toBe(
          changeKind === "raw-edit" ? "72.0000" : "71.9000",
        );
      expect(text(eventRows()[0])).toContain("71.9000");
      expect(status()).toContain("Biometric event saved");
    },
  );

  it.each(["create-outside", "edit-outside", "edit-boundary"])(
    "installs accepted%s only according to current inclusive window membership",
    async (kind) => {
      const { state } = historyWorkspace();
      await mount();
      const old = reading();
      if (kind !== "create-outside") await click("Edit", eventRows()[0]);
      await changeEvent("Exact value", "88.000");
      const recentTo = new Date(Date.parse(instant) + historyDay).toISOString();
      const saved = {
        ...old,
        id: kind === "create-outside" ? reading(9).id : old.id,
        revision: "2",
        value: "88.000",
        measuredAt: kind === "edit-boundary" ? recentTo : "2025-01-01T12:00:00.000Z",
        localDate: kind === "edit-boundary" ? recentTo.slice(0, 10) : "2025-01-01",
      };
      state.write = () => Response.json({ data: { event: saved, replayed: false } });
      await saveReading();
      expect(eventField("Exact value").props.value).toBe("");
      expect(eventRows()).toHaveLength(kind === "edit-outside" ? 0 : 1);
      if (kind === "create-outside") expect(text(eventRows()[0])).toContain("1.200");
      if (kind === "edit-boundary") expect(text(eventRows()[0])).toContain("88.000");
    },
  );

  it("rejects full Retry during a live event write and preserves selected range when Retry resumes", async () => {
    const { state, eventReads } = historyWorkspace();
    await mount();
    await click("Earlier window");
    state.read = () => Response.json({ error: "Private load failed" }, { status: 503 });
    hooks.replayEffects();
    await hooks.settle();
    const retry = button("Retry private data");
    await changeEvent("Exact value", "78.000");
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await saveReading();
    const count = eventReads().length;
    invoke(retry, "onClick");
    await hooks.settle();
    expect(eventReads()).toHaveLength(count);
    pending.resolve(Response.json({ data: { event: reading(), replayed: false } }));
    await hooks.settle();
    state.read = null;
    await click("Retry private data");
    expect(requestRange(eventReads().at(-1)?.[0])).toEqual(requestRange(eventReads()[1]?.[0]));
  });
});

describe("biometric receipt private ownership", () => {
  it.each(["fetch", "json"])(
    "ignores an old event receipt at%s after another read closes private scope",
    async (boundary) => {
      const { state, fetcher } = historyWorkspace();
      state.cursor = "private.next";
      state.continuation = () => page([], null);
      await mount();
      await changeEvent("Exact value", "73.001");
      const delayedFetch = deferred<Response>(),
        delayedJson = deferred<unknown>();
      const response = Response.json({ data: { event: reading(), replayed: false } });
      const parse = vi.fn(() => delayedJson.promise);
      if (boundary === "json") response.json = parse;
      state.write = () => (boundary === "fetch" ? delayedFetch.promise : response);
      await saveReading();
      state.auth = () => session(otherOwner);
      await click("Load more private foods");
      const before = fetcher.mock.calls.length,
        redirects = router.replace.mock.calls.length,
        closedUpdates = hooks.afterClose(),
        closedText = text();
      if (boundary === "fetch") {
        const expired = Response.json({ error: "Obsolete expiry" }, { status: 401 });
        expired.json = parse;
        delayedFetch.resolve(expired);
      } else delayedJson.resolve({ data: { event: reading(), replayed: false } });
      await hooks.settle();
      if (boundary === "fetch") expect(parse).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(router.replace.mock.calls).toHaveLength(redirects);
      expect(hooks.afterClose()).toBe(closedUpdates);
      expect(text()).toBe(closedText);
      expect(eventRows()).toHaveLength(0);
    },
  );
});

describe("biometric history initial visibility recovery", () => {
  it.each([
    { phase: "auth", foreground: "before" },
    { phase: "auth", foreground: "after" },
    { phase: "events", foreground: "before" },
    { phase: "events", foreground: "after" },
  ])(
    "recovers an initial $phase read when visibility returns $foreground the full receipt",
    async ({ phase, foreground }) => {
      const view = visibility();
      const { state, eventReads } = historyWorkspace();
      state.trend = (url) => {
        const params = new URL(url, "http://localhost").searchParams;
        return Response.json({
          data: {
            definition: historyDefinition,
            timeZone: "UTC",
            from: params.get("from"),
            to: params.get("to"),
            bucket: "day",
            points: [],
          },
        });
      };
      const pending = deferred<Response>();
      if (phase === "auth") {
        let first = true;
        state.auth = () => {
          if (first) {
            first = false;
            return pending.promise;
          }
          return session(owner, "UTC");
        };
      } else state.eventRead = () => pending.promise;
      await mount();
      await view.set("hidden");
      if (foreground === "before") await view.set("visible");
      pending.resolve(
        phase === "auth" ? session(owner, "UTC") : eventPage([reading()], "discarded.cursor"),
      );
      await hooks.settle();
      expect(status()).toBe("Private health workspace is current.");
      if (foreground === "after") await view.set("visible");
      expect(eventReads()).toHaveLength(1);
      expect(eventRows()).toHaveLength(0);
      expect(
        elements().some(
          (node) => node.type === "button" && text(node) === "Load older biometric events",
        ),
      ).toBe(false);
      expect(text(biometricSection())).toContain("Weight (kg)");
      expect(historyStatus()).toContain("This window has not been verified");
      expect(historyStatus()).toContain("Reload history");
      expect(button("Reload history").props.disabled).toBe(false);
      expect(button("Earlier window").props.disabled).toBe(false);
      const initial = requestRange(eventReads()[0]?.[0]);
      state.eventRead = () => eventPage([reading(2)]);
      await click("Reload history");
      expect(requestRange(eventReads()[1]?.[0])).toEqual(initial);
      expect(historyStatus()).toContain("1 loaded readings");
      expect(text(eventRows()[0])).toContain("2.200");
      expect(historyStatus()).not.toContain("not been verified");
    },
  );

  it("keeps an earlier selected range and raw editor recoverable after visibility invalidates a full Retry", async () => {
    const view = visibility();
    const { state, eventReads } = historyWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "75.00010");
    await changeEvent("Local time", "07:32");
    await change("From", "2026-08-01");
    await click("Earlier window");
    const selected = requestRange(eventReads()[1]?.[0]);
    const forms = formValues();
    state.read = () => Response.json({ error: "Private retry fixture" }, { status: 503 });
    hooks.replayEffects();
    await hooks.settle();
    state.read = null;
    const pending = deferred<Response>();
    state.eventRead = () => pending.promise;
    await click("Retry private data");
    await view.set("hidden");
    await view.set("visible");
    pending.resolve(eventPage([reading(8, selected.to)], "discarded.cursor"));
    await hooks.settle();
    expect(status()).toBe("Private health workspace is current.");
    expect(formValues()).toEqual(forms);
    expect(eventRows()).toHaveLength(0);
    expect(historyStatus()).toContain(selected.from);
    expect(button("Reload history").props.disabled).toBe(false);
    const count = eventReads().length;
    state.eventRead = () => eventPage([reading(9, selected.to)]);
    await click("Reload history");
    expect(eventReads()).toHaveLength(count + 1);
    expect(requestRange(eventReads().at(-1)?.[0])).toEqual(selected);
    expect(formValues()).toEqual(forms);
    expect(text(eventRows()[0])).toContain("9.200");
  });
});

const reminderDayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function savedReminder(
  index = 1,
  days: readonly number[] = [1, 3, 5],
  status: Reminder["status"] = "active",
): Reminder {
  return {
    id: `6bcfa2bf-4950-43f7-9f24-${String(index).padStart(12, "0")}`,
    revision: "3",
    label: `Saved reminder ${index}`,
    localTime: "19:23",
    daysOfWeek: days,
    status,
    timeZone: "America/Chicago",
    channel: "local",
    consent: {
      policyVersion: "local-reminders-v1",
      grantedAt: instant,
      revokedAt: status === "revoked" ? instant : null,
    },
    deliveryPolicy: {
      title: "Nutrition Tracker",
      lockScreenText: "Time to check in.",
      includesHealthDetails: false,
    },
    createdAt: instant,
    updatedAt: instant,
  };
}
function reminderWorkspace() {
  const result = workspace();
  result.state.reminders = [
    savedReminder(),
    savedReminder(2, [7, 6], "paused"),
    savedReminder(3, [1, 2, 3, 4, 5, 6, 7], "revoked"),
  ];
  return result;
}
function reminderSection() {
  return requiredHistory(
    elements().find((node) => node.props["aria-labelledby"] === "reminders-heading"),
  );
}
function reminderForm() {
  return requiredHistory(elements(reminderSection()).find((node) => node.type === "form"));
}
function reminderField(label: string) {
  const wrapper = requiredHistory(
    elements(reminderForm()).find((node) => node.type === "label" && text(node).trim() === label),
  );
  return requiredHistory(elements(wrapper).find((node) => node.type === "input"));
}
function reminderCard(label: string) {
  return requiredHistory(
    elements(reminderSection()).find(
      (node) =>
        node.type === "li" &&
        elements(node).some((child) => child.type === "strong" && text(child) === label),
    ),
  );
}
function selectedReminderDays() {
  return reminderDayNames.filter((day) => reminderField(day).props.checked);
}
async function changeReminderInput(label: string, value: string) {
  invoke(reminderField(label), "onChange", { target: { value } });
  await hooks.settle();
}
async function toggleReminderDay(day: string) {
  invoke(reminderField(day), "onChange");
  await hooks.settle();
}
async function saveReminderForm() {
  invoke(reminderForm(), "onSubmit", { preventDefault() {} });
  await hooks.settle();
}
function reminderWrites(fetcher: ReturnType<typeof workspace>["fetcher"]) {
  return fetcher.mock.calls.filter(
    ([url, init]) =>
      url.startsWith("/api/retention/reminders") &&
      (init?.method === "POST" || init?.method === "PATCH"),
  );
}
function consentStructure() {
  const form = reminderForm();
  const children = (form.props.children as readonly unknown[]).filter(
    (child) => child !== null && child !== false,
  );
  const label = requiredHistory(
    elements(form).find((node) => node.props.className === "consentLine"),
  );
  const input = requiredHistory(elements(label).find((node) => node.type === "input"));
  return {
    formType: form.type,
    labelIndex: children.indexOf(label),
    labelType: label.type,
    inputType: input.type,
    inputProps: input.props,
  };
}

describe("reminder day presets", () => {
  it("changes only days, exposes pressed membership and leaves consent structure/cards/other inputs untouched without effects", async () => {
    const { fetcher } = reminderWorkspace();
    await mount();
    await changeReminderInput("Private in-app label", " Raw schedule ");
    await changeReminderInput("Local time", "06:37");
    await change("Name", " Unrelated custom draft ");
    await toggle(food());
    const formBefore = formValues(),
      cardsBefore = text(
        requiredHistory(elements(reminderSection()).find((node) => node.type === "ul")),
      ),
      message = status(),
      consent = consentStructure(),
      before = fetcher.mock.calls.length;
    const allocate = vi.fn(() => "a0ec1bb6-195f-44d3-a0b4-09d8cafbb6d0"),
      confirm = vi.fn(),
      permission = vi.fn();
    vi.stubGlobal("crypto", { randomUUID: allocate });
    vi.stubGlobal("window", { confirm });
    vi.stubGlobal("Notification", { requestPermission: permission });
    for (const [label, days] of [
      ["Weekdays", ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      ["Weekends", ["Sat", "Sun"]],
      ["Every day", reminderDayNames],
    ] as const) {
      expect(button(label).props.type).toBe("button");
      await click(label);
      expect(selectedReminderDays()).toEqual(days);
      expect(button(label).props["aria-pressed"]).toBe(true);
      expect(consentStructure()).toEqual(consent);
      expect(consent.inputProps).toEqual({ required: true, type: "checkbox" });
      expect(formValues()).toEqual(formBefore);
      expect(status()).toBe(message);
    }
    await toggleReminderDay("Wed");
    expect(selectedReminderDays()).toEqual(["Mon", "Tue", "Thu", "Fri", "Sat", "Sun"]);
    for (const label of ["Weekdays", "Weekends", "Every day"])
      expect(button(label).props["aria-pressed"]).toBe(false);
    expect(
      text(requiredHistory(elements(reminderSection()).find((node) => node.type === "ul"))),
    ).toBe(cardsBefore);
    expect(details(food()).props.hidden).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(allocate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });

  it("keeps an unordered saved Weekends array and exact ambiguous PATCH on same-value immediate Save", async () => {
    const { state, fetcher } = reminderWorkspace();
    await mount();
    await click("Edit", reminderCard("Saved reminder 2"));
    state.write = () => Response.json({ error: "Ambiguous save" }, { status: 503 });
    await saveReminderForm();
    const first = requiredHistory(reminderWrites(fetcher)[0]);
    const before = status(),
      form = reminderForm(),
      preset = button("Weekends");
    invoke(preset, "onClick");
    invoke(preset, "onClick");
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    const writes = reminderWrites(fetcher);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.body).toBe(first[1]?.body);
    expect(JSON.parse(String(first[1]?.body))).toEqual({
      label: "Saved reminder 2",
      localTime: "19:23",
      daysOfWeek: [7, 6],
      timeZone: "America/Chicago",
      status: "paused",
    });
    expect(first[0]).toBe(`/api/retention/reminders/${savedReminder(2).id}`);
    expect(new Headers(first[1]?.headers).get("if-match")).toBe('"3"');
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(status()).toBe(before);
    expect(button("Weekends").props["aria-pressed"]).toBe(true);
  });

  it.each(["Create", "paused revision"])(
    "submits exact canonical preset plus individual override only on explicit%s",
    async (mode) => {
      const { state, fetcher } = reminderWorkspace();
      await mount();
      if (mode === "paused revision") await click("Edit", reminderCard("Saved reminder 2"));
      await changeReminderInput("Private in-app label", " Morning schedule ");
      await changeReminderInput("Local time", "06:45");
      await click("Weekdays");
      await toggleReminderDay("Wed");
      const saved = {
        ...savedReminder(
          mode === "Create" ? 4 : 2,
          [1, 2, 4, 5],
          mode === "Create" ? "active" : "paused",
        ),
        label: "Morning schedule",
        localTime: "06:45",
        revision: "4",
      };
      state.write = () => Response.json({ data: { reminder: saved, replayed: false } });
      expect(reminderWrites(fetcher)).toHaveLength(0);
      await saveReminderForm();
      const [url, init] = requiredHistory(reminderWrites(fetcher)[0]);
      expect(init?.method).toBe(mode === "Create" ? "POST" : "PATCH");
      expect(url).toBe(
        mode === "Create"
          ? "/api/retention/reminders"
          : `/api/retention/reminders/${savedReminder(2).id}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        label: "Morning schedule",
        localTime: "06:45",
        daysOfWeek: [1, 2, 4, 5],
        timeZone: "America/Chicago",
        ...(mode === "Create" ? { channel: "local", consentGranted: true } : { status: "paused" }),
      });
      expect(new Headers(init?.headers).get("if-match")).toBe(mode === "Create" ? null : '"3"');
      expect(selectedReminderDays()).toEqual(reminderDayNames);
      expect(reminderField("Private in-app label").props.value).toBe("");
      expect(text(reminderCard("Morning schedule"))).toContain("Saved days: Mon, Tue, Thu, Fri");
    },
  );

  it("retains A-to-B-to-A canonical Create body/key and malformed success retries", async () => {
    const { state, fetcher } = reminderWorkspace();
    await mount();
    await changeReminderInput("Private in-app label", "Schedule");
    state.write = () => Response.json({ data: { reminder: { bad: true }, replayed: false } });
    await click("Weekdays");
    await saveReminderForm();
    await click("Weekends");
    await saveReminderForm();
    await click("Weekdays");
    await saveReminderForm();
    const writes = reminderWrites(fetcher);
    expect(writes).toHaveLength(3);
    expect(writes[2]?.[1]?.body).toBe(writes[0]?.[1]?.body);
    const keys = writes.map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(reminderField("Private in-app label").props.value).toBe("Schedule");
  });

  it("preserves empty-set validation and allows returning to a preset", async () => {
    const { fetcher } = reminderWorkspace();
    await mount();
    await changeReminderInput("Private in-app label", "Empty days");
    for (const day of reminderDayNames) await toggleReminderDay(day);
    expect(selectedReminderDays()).toEqual([]);
    await saveReminderForm();
    expect(reminderWrites(fetcher)).toHaveLength(0);
    expect(status()).toContain("at least one day");
    await click("Weekends");
    expect(selectedReminderDays()).toEqual(["Sat", "Sun"]);
  });

  it.each([
    "preset",
    "field",
    "toggle",
    "Edit",
    "Cancel",
    "full load",
    "background",
    "profile",
    "owner",
    "unmount",
  ])(
    "rejects retained reminder controls after%s without restoring old drafts or requests",
    async (transition) => {
      const view = visibility(),
        { state, fetcher } = reminderWorkspace();
      await mount();
      await click("Edit", reminderCard("Saved reminder 2"));
      const preset = button("Weekdays"),
        input = reminderField("Private in-app label"),
        day = reminderField("Mon"),
        edit = button("Edit", reminderCard("Saved reminder 1")),
        cancel = button("Cancel edit"),
        form = reminderForm();
      if (transition === "preset") await click("Every day");
      else if (transition === "field") await changeReminderInput("Private in-app label", "Changed");
      else if (transition === "toggle") await toggleReminderDay("Mon");
      else if (transition === "Edit") await click("Edit", reminderCard("Saved reminder 1"));
      else if (transition === "Cancel") await click("Cancel edit");
      else if (transition === "background") {
        await view.set("hidden");
        await view.set("visible");
      } else if (transition === "unmount") hooks.unmount();
      else {
        if (transition === "profile") state.timeZone = "UTC";
        if (transition === "owner") state.owner = otherOwner;
        hooks.replayEffects();
        await hooks.settle();
      }
      const before = fetcher.mock.calls.length,
        values = formValues(),
        rendered = text(),
        updates = hooks.afterClose();
      invoke(preset, "onClick");
      invoke(input, "onChange", { target: { value: "Stale" } });
      invoke(day, "onChange");
      invoke(edit, "onClick");
      invoke(cancel, "onClick");
      invoke(form, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(formValues()).toEqual(values);
      expect(text()).toBe(rendered);
      expect(hooks.afterClose()).toBe(updates);
    },
  );

  it.each(["background", "same-owner full load", "profile"])(
    "protects a live Save despite unrelated busy cleanup and preserves accepted cleanup after%s",
    async (transition) => {
      const view = visibility(),
        { state, fetcher } = reminderWorkspace();
      state.cursor = "private.next";
      state.continuation = () => page([], null);
      await mount();
      await click("Edit", reminderCard("Saved reminder 2"));
      await click("Weekdays");
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      const preset = button("Every day"),
        input = reminderField("Private in-app label"),
        edit = button("Edit", reminderCard("Saved reminder 1")),
        cancel = button("Cancel edit"),
        form = reminderForm();
      invoke(form, "onSubmit", { preventDefault() {} });
      invoke(preset, "onClick");
      invoke(input, "onChange", { target: { value: "Stale" } });
      invoke(edit, "onClick");
      invoke(cancel, "onClick");
      invoke(form, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      await click("Load more private foods");
      expect(button("Weekends").props.disabled).toBe(true);
      invoke(button("Weekends"), "onClick");
      await hooks.settle();
      expect(selectedReminderDays()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
      expect(reminderWrites(fetcher)).toHaveLength(1);
      if (transition === "background") await view.set("hidden");
      else {
        if (transition === "profile") state.timeZone = "UTC";
        hooks.replayEffects();
        await hooks.settle();
      }
      pending.resolve(
        Response.json({
          data: {
            reminder: { ...savedReminder(2, [1, 2, 3, 4, 5], "paused"), revision: "4" },
            replayed: false,
          },
        }),
      );
      await hooks.settle();
      if (transition === "background") await view.set("visible");
      expect(reminderField("Private in-app label").props.value).toBe("");
      expect(selectedReminderDays()).toEqual(reminderDayNames);
      expect(button("Weekdays").props.disabled).toBe(false);
      expect(status()).toContain("Reminder saved.");
      expect(text(reminderCard("Saved reminder 2"))).toContain(
        "Saved days: Mon, Tue, Wed, Thu, Fri",
      );
    },
  );

  it.each(["fetch", "json"])(
    "ignores old reminder receipt at%s while a replacement owner has a newer live Save",
    async (boundary) => {
      const { state, fetcher } = reminderWorkspace();
      state.cursor = "private.next";
      state.continuation = () => page([], null);
      await mount();
      await changeReminderInput("Private in-app label", "Owned schedule");
      await click("Weekdays");
      const delayed = deferred<Response>(),
        body = deferred<unknown>();
      const response = Response.json({ data: { reminder: savedReminder(), replayed: false } }),
        parse = vi.fn(() => body.promise);
      if (boundary === "json") response.json = parse;
      state.write = () => (boundary === "fetch" ? delayed.promise : response);
      await saveReminderForm();
      state.auth = () => session(otherOwner);
      await click("Load more private foods");
      expect(button("Weekdays").props.disabled).toBe(true);
      expect(reminderField("Private in-app label").props.value).toBe("");
      hooks.unmount();
      state.auth = null;
      state.owner = otherOwner;
      await mount();
      await changeReminderInput("Private in-app label", "Replacement schedule");
      await click("Weekends");
      const current = deferred<Response>();
      state.write = () => current.promise;
      await saveReminderForm();
      const before = fetcher.mock.calls.length,
        redirects = router.replace.mock.calls.length,
        rendered = text();
      if (boundary === "fetch") {
        const expired = Response.json({ error: "Expired" }, { status: 401 });
        expired.json = parse;
        delayed.resolve(expired);
      } else body.resolve({ data: { reminder: savedReminder(), replayed: false } });
      await hooks.settle();
      if (boundary === "fetch") expect(parse).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(router.replace.mock.calls).toHaveLength(redirects);
      expect(text()).toBe(rendered);
      expect(button("Weekdays").props.disabled).toBe(true);
      expect(reminderField("Private in-app label").props.value).toBe("Replacement schedule");
      invoke(reminderForm(), "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      current.resolve(
        Response.json({
          data: {
            reminder: { ...savedReminder(4, [6, 7]), label: "Replacement schedule" },
            replayed: false,
          },
        }),
      );
      await hooks.settle();
      expect(reminderField("Private in-app label").props.value).toBe("");
      expect(button("Weekdays").props.disabled).toBe(false);
      expect(text(reminderCard("Replacement schedule"))).toContain("Saved days: Sat, Sun");
    },
  );

  it("closes a current expired Save before JSON and permits a new private scope to save", async () => {
    const { state, fetcher } = reminderWorkspace();
    await mount();
    await changeReminderInput("Private in-app label", "Expiring schedule");
    await click("Weekdays");
    const parse = vi.fn();
    state.write = () => {
      const response = Response.json({ error: "Expired" }, { status: 401 });
      response.json = parse;
      return response;
    };
    await saveReminderForm();
    expect(parse).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(reminderField("Private in-app label").props.value).toBe("");
    expect(button("Weekdays").props.disabled).toBe(true);
    hooks.unmount();
    state.owner = otherOwner;
    await mount();
    await changeReminderInput("Private in-app label", "New owner schedule");
    await click("Weekends");
    state.write = () =>
      Response.json({
        data: {
          reminder: { ...savedReminder(4, [6, 7]), label: "New owner schedule" },
          replayed: false,
        },
      });
    await saveReminderForm();
    const writes = reminderWrites(fetcher);
    expect(writes).toHaveLength(2);
    expect(new Headers(writes[0]?.[1]?.headers).get("idempotency-key")).not.toBe(
      new Headers(writes[1]?.[1]?.headers).get("idempotency-key"),
    );
    expect(button("Weekdays").props.disabled).toBe(false);
    expect(reminderField("Private in-app label").props.value).toBe("");
  });
});

const duplicateHistoryDefinition = {
  ...historyDefinition,
  id: "4bcfa2bf-4950-43f7-9f24-000000000002",
  status: "archived" as const,
};
const emptyHistoryDefinition = {
  ...historyDefinition,
  id: "4bcfa2bf-4950-43f7-9f24-000000000003",
  name: "Height",
  dimension: "length" as const,
  canonicalUnit: "cm",
};
const missingHistoryMetric = "4bcfa2bf-4950-43f7-9f24-000000000004";
const otherMissingHistoryMetric = "4bcfa2bf-4950-43f7-9f24-000000000005";
function metricHistoryWorkspace() {
  const result = historyWorkspace();
  result.state.definitions = [
    historyDefinition,
    duplicateHistoryDefinition,
    emptyHistoryDefinition,
  ];
  const items = [
    { ...reading(1), value: "0.00000" },
    { ...reading(2), definitionId: duplicateHistoryDefinition.id, value: "-2.50000" },
    {
      ...reading(3),
      definitionId: otherMissingHistoryMetric,
      value: "7".repeat(160),
      source: { ...reading().source, kind: "apple_healthkit" as const, externalId: "import-3" },
    },
    { ...reading(4), definitionId: missingHistoryMetric },
    { ...reading(5), definitionId: otherMissingHistoryMetric },
  ];
  result.state.eventRead = () => eventPage(items);
  return { ...result, items };
}
function historyMetricControl() {
  const label = requiredHistory(
    elements(biometricSection()).find(
      (node) => node.type === "label" && text(node).startsWith("History metric"),
    ),
  );
  return requiredHistory(elements(label).find((node) => node.type === "select"));
}
function historyMetricOptions() {
  return elements(historyMetricControl())
    .filter((node) => node.type === "option")
    .map((node) => ({ id: node.props.value, label: text(node) }));
}
function historyFilterStatus() {
  return text(
    elements().find((node) => node.props.id === "biometric-history-filter-status") ?? null,
  );
}
async function chooseHistoryMetric(id: string) {
  const control = historyMetricControl();
  expect(control.props.disabled).toBe(false);
  invoke(control, "onChange", { target: { value: id } });
  await hooks.settle();
}
function inputsExceptHistoryMetric() {
  const metric = historyMetricControl();
  return elements()
    .filter(
      (node) => node !== metric && ["input", "select", "textarea"].includes(String(node.type)),
    )
    .map((node) => ({ type: node.type, value: node.props.value, checked: node.props.checked }));
}

describe("loaded biometric history metric filter", () => {
  it("does not invent loaded counts or expose private choices during initial unverified loading", async () => {
    const { state, fetcher } = metricHistoryWorkspace();
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    await mount();
    expect(historyFilterStatus()).toBe("");
    expect(historyStatus()).toContain("unavailable until your private data is verified");
    expect(historyMetricControl().props.disabled).toBe(true);
    expect(historyMetricOptions()).toEqual([{ id: "", label: "All metrics" }]);
    const requests = fetcher.mock.calls.length;
    invoke(historyMetricControl(), "onChange", { target: { value: historyDefinition.id } });
    invoke(button("All metrics"), "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(requests);
    pending.resolve(page(state.items));
    await hooks.settle();
    expect(historyFilterStatus()).toContain("Showing 5 of 5 loaded readings");
    expect(historyMetricControl().props.value).toBe("");
  });

  it("uses ordered exact IDs, distinguishes duplicate and unavailable metadata, and preserves every saved row without requests", async () => {
    const { items, fetcher } = metricHistoryWorkspace();
    await mount();
    const original = JSON.stringify(items),
      rows = eventRows().map((node) => text(node)),
      requests = fetcher.mock.calls.length;
    expect(historyMetricOptions()).toEqual([
      { id: "", label: "All metrics" },
      { id: historyDefinition.id, label: `Weight (kg) · ${historyDefinition.id}` },
      {
        id: duplicateHistoryDefinition.id,
        label: `Weight (kg) · ${duplicateHistoryDefinition.id}`,
      },
      { id: emptyHistoryDefinition.id, label: "Height (cm)" },
      {
        id: otherMissingHistoryMetric,
        label: `Metric unavailable (unit unavailable) · ${otherMissingHistoryMetric}`,
      },
      {
        id: missingHistoryMetric,
        label: `Metric unavailable (unit unavailable) · ${missingHistoryMetric}`,
      },
    ]);
    expect(historyFilterStatus()).toContain("Showing 5 of 5 loaded readings");
    const allocate = vi.fn();
    vi.stubGlobal("crypto", { randomUUID: allocate });
    await chooseHistoryMetric(duplicateHistoryDefinition.id);
    expect(eventRows().map((node) => text(node))).toEqual([rows[1]]);
    expect(historyFilterStatus()).toContain("Showing 1 of 5 loaded readings");
    await chooseHistoryMetric(otherMissingHistoryMetric);
    expect(eventRows().map((node) => text(node))).toEqual([rows[2], rows[4]]);
    expect(text(eventRows()[0])).toContain("7".repeat(160));
    expect(text(eventRows()[0])).toContain("unit unavailable · Metric unavailable");
    expect(text(eventRows()[0])).toContain("12:34:56 · UTC · apple_healthkit");
    expect(
      elements(eventRows()[0]).some((node) => node.type === "button" && text(node) === "Edit"),
    ).toBe(false);
    await click("All metrics");
    expect(eventRows().map((node) => text(node))).toEqual(rows);
    expect(button("All metrics").props.disabled).toBe(false);
    expect(historyFilterStatus()).toContain("only to loaded readings");
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(allocate).not.toHaveBeenCalled();
    expect(JSON.stringify(items)).toBe(original);
  });

  it("keeps current-ID resets true no-ops and rejects hidden/restored row or stale filter callbacks before effects", async () => {
    const { fetcher } = metricHistoryWorkspace();
    await mount();
    const edit = button("Edit", eventRows()[0]),
      oldDelete = button("Delete", eventRows()[0]),
      input = historyMetricControl(),
      reset = button("All metrics");
    invoke(reset, "onClick");
    invoke(reset, "onClick");
    invoke(input, "onChange", { target: { value: "" } });
    invoke(edit, "onClick");
    await hooks.settle();
    expect(text(eventForm())).toContain("Edit manual event");
    await click("Cancel", eventForm());
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const before = fetcher.mock.calls.length;
    invoke(historyMetricControl(), "onChange", {
      target: { value: duplicateHistoryDefinition.id },
    });
    invoke(edit, "onClick");
    invoke(oldDelete, "onClick");
    invoke(reset, "onClick");
    invoke(input, "onChange", { target: { value: "" } });
    await hooks.settle();
    expect(historyMetricControl().props.value).toBe(duplicateHistoryDefinition.id);
    expect(text(eventForm())).toContain("Log event");
    expect(confirm).not.toHaveBeenCalled();
    await click("All metrics");
    invoke(edit, "onClick");
    invoke(oldDelete, "onClick");
    await hooks.settle();
    expect(text(eventForm())).toContain("Log event");
    invoke(historyMetricControl(), "onChange", { target: { value: "unknown-unloaded-id" } });
    await hooks.settle();
    expect(historyMetricControl().props.value).toBe("");
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(confirm).not.toHaveBeenCalled();
    await chooseHistoryMetric(duplicateHistoryDefinition.id);
    const current = button("Edit", eventRows()[0]),
      same = historyMetricControl();
    invoke(same, "onChange", { target: { value: duplicateHistoryDefinition.id } });
    invoke(current, "onClick");
    await hooks.settle();
    expect(eventField("Exact value").props.value).toBe("-2.50000");
  });

  it("keeps every raw editor/trend/custom-food/reminder input and disclosure independent when its edited row is hidden", async () => {
    const { fetcher } = metricHistoryWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    await changeEvent("Local date", "2026-09-09");
    await changeEvent("Local time", "07:23");
    await change("From", "2026-08-01");
    await change("Name", " Unrelated custom name ");
    await changeReminderInput("Private in-app label", " Unrelated reminder ");
    await toggle(food());
    const inputs = inputsExceptHistoryMetric(),
      message = status(),
      before = fetcher.mock.calls.length;
    await chooseHistoryMetric(emptyHistoryDefinition.id);
    expect(eventRows()).toHaveLength(0);
    expect(historyFilterStatus()).toContain("Showing 0 of 5 loaded readings");
    expect(historyFilterStatus()).toContain("No loaded readings match this metric");
    expect(inputsExceptHistoryMetric()).toEqual(inputs);
    expect(status()).toBe(message);
    expect(details(food()).props.hidden).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(before);
    await click("All metrics");
    expect(inputsExceptHistoryMetric()).toEqual(inputs);
    expect(eventRows()).toHaveLength(5);
  });

  it("keeps zero-match continuation reachable and preserves overlap order, exact cursor and terminal-page meaning", async () => {
    const { state, items, fetcher, eventReads } = metricHistoryWorkspace();
    state.eventRead = () => eventPage(items, "filter.next");
    await mount();
    await chooseHistoryMetric(emptyHistoryDefinition.id);
    const pending = deferred<Response>();
    state.eventRead = () => pending.promise;
    const old = historyMetricControl(),
      reset = button("All metrics");
    invoke(button("Load older biometric events"), "onClick");
    invoke(old, "onChange", { target: { value: "" } });
    invoke(reset, "onClick");
    await hooks.settle();
    expect(historyMetricControl().props.disabled).toBe(true);
    expect(button("All metrics").props.disabled).toBe(true);
    expect(historyMetricControl().props.value).toBe(emptyHistoryDefinition.id);
    expect(eventRows()).toHaveLength(0);
    pending.resolve(
      eventPage(
        [
          { ...items[0], value: "999.000" } as BiometricEvent,
          { ...reading(6), definitionId: emptyHistoryDefinition.id },
        ],
        "filter.last",
      ),
    );
    await hooks.settle();
    expect(historyFilterStatus()).toContain("Showing 1 of 6 loaded readings");
    expect(text(eventRows()[0])).toContain("6.200 cm · Height");
    expect(requestRange(eventReads()[1]?.[0])).toEqual({
      ...requestRange(eventReads()[0]?.[0]),
      cursor: "filter.next",
    });
    const before = fetcher.mock.calls.length;
    await click("All metrics");
    expect(text(eventRows()[0])).toContain("0.00000 kg");
    expect(fetcher.mock.calls).toHaveLength(before);
    await chooseHistoryMetric(emptyHistoryDefinition.id);
    state.eventRead = () => eventPage([]);
    await click("Load older biometric events");
    expect(historyMetricControl().props.value).toBe(emptyHistoryDefinition.id);
    expect(historyFilterStatus()).toContain("Showing 1 of 6 loaded readings");
    expect(historyStatus()).toContain("No more readings in this window");
    expect(
      elements().some(
        (node) => node.type === "button" && text(node) === "Load older biometric events",
      ),
    ).toBe(false);
  });

  it.each(["503", "400"])(
    "retains the selected metric and truthful loaded count through continuation%s and explicit recovery",
    async (failure) => {
      const { state, items, eventReads } = metricHistoryWorkspace();
      state.eventRead = () => eventPage(items, "same.cursor");
      await mount();
      await chooseHistoryMetric(emptyHistoryDefinition.id);
      state.eventRead = () =>
        Response.json({ error: "Page unavailable" }, { status: Number(failure) });
      await click("Load older biometric events");
      expect(historyMetricControl().props.value).toBe(emptyHistoryDefinition.id);
      expect(historyFilterStatus()).toContain("Showing 0 of 5 loaded readings");
      expect(historyStatus()).not.toContain("No more readings in this window");
      state.eventRead = () =>
        eventPage([{ ...reading(6), definitionId: emptyHistoryDefinition.id }]);
      await click(failure === "400" ? "Reload history" : "Load older biometric events");
      expect(historyMetricControl().props.value).toBe(emptyHistoryDefinition.id);
      expect(eventRows()).toHaveLength(1);
      expect(requestRange(eventReads().at(-1)?.[0]).cursor).toBe(
        failure === "400" ? null : "same.cursor",
      );
    },
  );

  it("retains an unavailable selected ID across empty windows, reload and failed full Retry without inventing verified counts", async () => {
    const { state, eventReads } = metricHistoryWorkspace();
    await mount();
    await chooseHistoryMetric(missingHistoryMetric);
    state.eventRead = () => eventPage([]);
    await click("Earlier window");
    expect(historyMetricControl().props.value).toBe(missingHistoryMetric);
    expect(historyMetricOptions().at(-1)?.id).toBe(missingHistoryMetric);
    expect(historyMetricOptions().some((choice) => choice.id === otherMissingHistoryMetric)).toBe(
      false,
    );
    expect(historyFilterStatus()).toContain("Showing 0 of 0 loaded readings");
    await click("Reload history");
    await click("Newer window");
    await click("Earlier window");
    await click("Recent history");
    expect(historyMetricControl().props.value).toBe(missingHistoryMetric);
    state.read = () => Response.json({ error: "Failed full verification" }, { status: 503 });
    hooks.replayEffects();
    await hooks.settle();
    expect(historyMetricControl().props.value).toBe(missingHistoryMetric);
    // A failed same-scope full read retains the existing last-verified history snapshot.
    expect(historyFilterStatus()).toContain("Showing 0 of 0 loaded readings");
    expect(historyStatus()).toContain("Private data could not be verified");
    state.read = null;
    const prior = eventReads().length;
    await click("Retry private data");
    expect(eventReads()).toHaveLength(prior + 1);
    expect(historyMetricControl().props.value).toBe(missingHistoryMetric);
    expect(historyFilterStatus()).toContain("Showing 0 of 0 loaded readings");
  });

  it.each(["window", "reload", "full read", "profile", "owner", "background", "unmount"])(
    "fences retained select/reset/row actions through%s using existing history scope",
    async (transition) => {
      const view = visibility(),
        { state, fetcher } = metricHistoryWorkspace();
      await mount();
      await chooseHistoryMetric(duplicateHistoryDefinition.id);
      const input = historyMetricControl(),
        reset = button("All metrics"),
        edit = button("Edit", eventRows()[0]),
        remove = button("Delete", eventRows()[0]),
        confirm = vi.fn(() => true);
      vi.stubGlobal("window", { confirm });
      if (transition === "window") await click("Earlier window");
      else if (transition === "reload") await click("Reload history");
      else if (transition === "background") {
        await view.set("hidden");
        expect(historyMetricOptions()).toEqual([{ id: "", label: "All metrics" }]);
        expect(historyMetricControl().props.value).toBe("");
        await view.set("visible");
      } else if (transition === "unmount") hooks.unmount();
      else {
        if (transition === "profile") state.timeZone = "America/Chicago";
        if (transition === "owner") state.owner = otherOwner;
        hooks.replayEffects();
        await hooks.settle();
      }
      const before = fetcher.mock.calls.length,
        rendered = text(),
        inputs = inputsExceptHistoryMetric();
      invoke(input, "onChange", { target: { value: missingHistoryMetric } });
      invoke(reset, "onClick");
      invoke(edit, "onClick");
      invoke(remove, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(text()).toBe(rendered);
      expect(inputsExceptHistoryMetric()).toEqual(inputs);
      expect(confirm).not.toHaveBeenCalled();
      if (transition !== "unmount")
        expect(historyMetricControl().props.value).toBe(
          ["profile", "owner"].includes(transition) ? "" : duplicateHistoryDefinition.id,
        );
      if (transition === "owner")
        expect(historyMetricOptions()).toEqual([{ id: "", label: "All metrics" }]);
    },
  );

  it("preserves exact failed PATCH body/key and raw off-filter editor through local changes and retry", async () => {
    const { state, fetcher } = metricHistoryWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    state.write = () => Response.json({ error: "Ambiguous correction" }, { status: 503 });
    await saveReading();
    const first = requiredHistory(fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")),
      message = status();
    await chooseHistoryMetric(emptyHistoryDefinition.id);
    expect(eventRows()).toHaveLength(0);
    expect(status()).toBe(message);
    expect(eventField("Exact value").props.value).toBe("71.200000");
    expect(eventField("Local time").props.value).toBe("12:34");
    await saveReading();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(2);
    expect(first[1]?.body).toBe(JSON.stringify({ value: "71.200000" }));
    expect(writes[1]?.[1]?.body).toBe(first[1]?.body);
    expect(new Headers(writes[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(first[1]?.headers).get("if-match")).toBe('"1"');
  });

  it.each(["current", "background"])(
    "preserves accepted off-filter edit cleanup after%s and rejects filter changes during its live write",
    async (transition) => {
      const view = visibility(),
        { state, fetcher } = metricHistoryWorkspace();
      state.cursor = "private.next";
      state.continuation = () => page([], null);
      await mount();
      await click("Edit", eventRows()[0]);
      await changeEvent("Exact value", "71.9000");
      await chooseHistoryMetric(duplicateHistoryDefinition.id);
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      const input = historyMetricControl(),
        reset = button("All metrics");
      invoke(eventForm(), "onSubmit", { preventDefault() {} });
      invoke(input, "onChange", { target: { value: "" } });
      invoke(reset, "onClick");
      await hooks.settle();
      await click("Load more private foods");
      expect(historyMetricControl().props.disabled).toBe(true);
      expect(button("All metrics").props.disabled).toBe(true);
      invoke(historyMetricControl(), "onChange", { target: { value: "" } });
      await hooks.settle();
      expect(historyMetricControl().props.value).toBe(duplicateHistoryDefinition.id);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
      if (transition === "background") await view.set("hidden");
      pending.resolve(
        Response.json({
          data: { event: { ...reading(), revision: "2", value: "71.9000" }, replayed: false },
        }),
      );
      await hooks.settle();
      if (transition === "background") await view.set("visible");
      expect(historyMetricControl().props.value).toBe(duplicateHistoryDefinition.id);
      expect(eventField("Exact value").props.value).toBe("");
      expect(text(eventForm())).toContain("Log event");
      expect(eventRows()).toHaveLength(1);
      await click("All metrics");
      expect(text(eventRows()[0])).toContain("71.9000");
    },
  );
});
