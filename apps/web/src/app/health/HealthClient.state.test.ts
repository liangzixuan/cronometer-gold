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

import type { CustomFood } from "../../lib/retention";
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
    auth: null as null | (() => Response | Promise<Response>),
    cursor: null as string | null,
    owner,
    timeZone: "America/Chicago",
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
    if (url === "/api/retention/custom-foods?limit=50")
      return state.read ? state.read() : page(state.items, state.cursor);
    if (url.startsWith("/api/retention/custom-foods?limit=50&cursor=")) {
      if (!state.continuation) throw new Error("Unexpected continuation.");
      return state.continuation();
    }
    if (url === "/api/nutrients/targetable") return Response.json({ data: state.picker });
    if (url.startsWith("/api/retention/trends/"))
      return Response.json({ error: "No trend fixture" }, { status: 503 });
    if (url.startsWith("/api/retention/biometrics/events?"))
      return Response.json({ data: [], page: { nextCursor: null } });
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
    expect(details(first).props.hidden).toBe(true);
    await view.set("visible");
    await toggle(first);
    const oldHide = disclosure(first);
    await view.set("hidden");
    expect(details(first).props.hidden).toBe(true);
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
    expect(details(first).props.hidden).toBe(true);
    expect(disclosure(first).props.disabled).toBe(true);
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
