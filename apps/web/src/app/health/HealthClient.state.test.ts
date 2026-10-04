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
    renderBeforeCommit() {
      // Refresh handlers for a render without committing intermediate effect
      // dependencies. The next render() compares against the last committed view.
      const committedEffects = slots.flatMap((slot, index) =>
        slot.effect ? [[index, slot] as const] : [],
      );
      const queuedEffects = [...effects];
      render(false);
      effects = queuedEffects;
      for (const [index, slot] of committedEffects) slots[index] = slot;
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
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import type { BiometricDefinition, BiometricEvent, Reminder } from "../../lib/retention";
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
function workspace() {
  const state = {
    picker: [] as readonly unknown[],
    trend: null as null | ((url: string) => Response | Promise<Response>),
    auth: null as null | (() => Response | Promise<Response>),
    owner,
    timeZone: "America/Chicago",
    sectionRead: null as null | ((url: string) => Response | Promise<Response> | undefined),
    read: null as null | (() => Response | Promise<Response>),
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
    const sectionResult = state.sectionRead?.(url);
    if (sectionResult !== undefined) return sectionResult;
    if (url === "/api/nutrients/targetable")
      return state.read ? state.read() : Response.json({ data: state.picker });
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
      fetcher.mock.calls.filter(
        ([, init]) =>
          init?.method === "POST" || init?.method === "DELETE" || init?.method === "PATCH",
      ),
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
  it("moves exact inclusive121day windows, keeps a captured Recent anchor and preserves every raw Health form", async () => {
    const { eventReads, fetcher } = historyWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.23000");
    await changeEvent("Local time", "13:14");
    await change("Private in-app label", " Raw reminder ");
    await change("From", "2026-08-01");
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
      const independent = deferred<Response>();
      state.sectionRead = (url) =>
        url === "/api/retention/integrations/health" ? independent.promise : undefined;
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
      // An independent Health read completes while the event write remains live.
      independent.resolve(Response.json({ data: [] }));
      await hooks.settle();
      expect(text()).not.toContain("Loading health integrations…");
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
      const independent = deferred<Response>();
      state.sectionRead = (url) =>
        url === "/api/retention/integrations/health" ? independent.promise : undefined;
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
      independent.resolve(Response.json({ data: [] }));
      await hooks.settle();
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
      const independent = deferred<Response>();
      state.sectionRead = (url) =>
        url === "/api/retention/integrations/health" ? independent.promise : undefined;
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
      independent.resolve(Response.json({ data: [] }));
      await hooks.settle();
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
      const independent = deferred<Response>();
      state.sectionRead = (url) =>
        url === "/api/retention/integrations/health" ? independent.promise : undefined;
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
      independent.resolve(Response.json({ data: [] }));
      await hooks.settle();
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
    const { state, fetcher, items } = metricHistoryWorkspace();
    const pending = deferred<Response>();
    state.eventRead = () => pending.promise;
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
    pending.resolve(eventPage(items));
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

  it("keeps every raw event/trend/reminder input independent when its edited row is hidden", async () => {
    const { fetcher } = metricHistoryWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    await changeEvent("Local date", "2026-09-09");
    await changeEvent("Local time", "07:23");
    await change("From", "2026-08-01");
    await changeReminderInput("Private in-app label", " Unrelated reminder ");
    const inputs = inputsExceptHistoryMetric(),
      message = status(),
      before = fetcher.mock.calls.length;
    await chooseHistoryMetric(emptyHistoryDefinition.id);
    expect(eventRows()).toHaveLength(0);
    expect(historyFilterStatus()).toContain("Showing 0 of 5 loaded readings");
    expect(historyFilterStatus()).toContain("No loaded readings match this metric");
    expect(inputsExceptHistoryMetric()).toEqual(inputs);
    expect(status()).toBe(message);
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
    // A failed nutrient-registry read does not invalidate the independently verified history.
    expect(historyFilterStatus()).toContain("Showing 0 of 0 loaded readings");
    expect(historyStatus()).not.toContain("could not be verified");
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
      const independent = deferred<Response>();
      state.sectionRead = (url) =>
        url === "/api/retention/integrations/health" ? independent.promise : undefined;
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
      independent.resolve(Response.json({ data: [] }));
      await hooks.settle();
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

function trendField(label: string) {
  const section = elements().find((node) => node.props["aria-labelledby"] === "trends-heading");
  const wrapper = elements(section).find(
    (node) => node.type === "label" && text((node.props.children as unknown[])[0]).trim() === label,
  );
  return requiredHistory(
    elements(wrapper).find((node) => node.type === "input" || node.type === "select"),
  );
}
function trendDates() {
  return { from: trendField("From").props.value, to: trendField("To").props.value };
}
function trendText() {
  return text(elements().find((node) => node.props.className === "trendTables"));
}
function inputsExceptTrendDates() {
  const dates = [trendField("From"), trendField("To")];
  return elements()
    .filter(
      (node) =>
        ["input", "select", "textarea"].includes(String(node.type)) && !dates.includes(node),
    )
    .map((node) => [node.type, node.props.value, node.props.checked]);
}
function trendResponse(path: string, timeZone: string) {
  const params = new URL(path, "http://127.0.0.1").searchParams;
  const from = params.get("from"),
    to = params.get("to");
  const point = {
    localDate: from,
    startsAt: `${from}T05:00:00.000Z`,
    endsAt: `${from}T23:00:00.000Z`,
  };
  if (path.includes("/biometrics?"))
    return Response.json({
      data: {
        definition: historyDefinition,
        from,
        to,
        timeZone,
        bucket: "day",
        points: [
          {
            ...point,
            count: 1,
            first: "0.00000",
            last: "0.00000",
            minimum: "0.00000",
            maximum: "0.00000",
          },
        ],
      },
    });
  const id = params.get("nutrientId") ?? "2";
  return Response.json({
    data: {
      nutrient: { id, code: "protein", name: "Response protein", unit: "g" },
      from,
      to,
      timeZone,
      bucket: "day",
      watermarkRevision: "1",
      points: [
        {
          ...point,
          aggregate: {
            nutrientId: id,
            code: "protein",
            name: "Response protein",
            unit: "g",
            knownAmount: "0",
            completeness: "partial",
            isExact: false,
            contributorCount: 2,
            quantifiedCount: 1,
            traceCount: 0,
            unknownCount: 1,
            unknownReasonCounts: {
              not_reported: 1,
              not_analyzed: 0,
              not_applicable: 0,
              withheld: 0,
            },
          },
        },
      ],
    },
  });
}
function trendWorkspace(now = "2026-09-14T03:00:00.000Z", timeZone = "America/Chicago") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const result = workspace();
  result.state.timeZone = timeZone;
  result.state.definitions = [historyDefinition];
  result.state.picker = [
    { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
    { id: "3", code: "fat", name: "Fat", unit: "g", category: "macronutrient" },
  ];
  result.state.trend = (path) => trendResponse(path, result.state.timeZone);
  return {
    ...result,
    trendReads: () =>
      result.fetcher.mock.calls.filter(([path]) => path.startsWith("/api/retention/trends/")),
  };
}

describe("Health trend date shortcuts", () => {
  it.each([
    [7, "2026-09-14T03:00:00.000Z", "America/Chicago", "2026-09-07", "2026-09-13"],
    [30, "2026-03-01T01:00:00.000Z", "Asia/Tokyo", "2026-01-31", "2026-03-01"],
    [90, "2026-01-02T01:00:00.000Z", "America/Chicago", "2025-10-04", "2026-01-01"],
    [7, "2024-03-03T12:00:00.000Z", "UTC", "2024-02-26", "2024-03-03"],
    [7, "2026-03-10T03:00:00.000Z", "America/Chicago", "2026-03-03", "2026-03-09"],
    [7, "2026-11-03T03:00:00.000Z", "America/Chicago", "2026-10-27", "2026-11-02"],
  ])("loads the inclusive %i-day pair for %s in %s", async (days, now, zone, from, to) => {
    const { fetcher, trendReads, writes } = trendWorkspace(String(now), String(zone));
    await mount();
    const before = fetcher.mock.calls.length;
    await click(`Last ${days} days`);
    expect(trendDates()).toEqual({ from, to });
    expect(fetcher.mock.calls.slice(before).map(([path]) => path.split("?")[0])).toEqual([
      "/api/retention/trends/nutrients",
      "/api/retention/trends/biometrics",
      "/api/auth/me",
      "/api/auth/me",
    ]);
    expect(
      trendReads()
        .slice(-2)
        .map(([path]) => {
          const params = new URL(path, "http://127.0.0.1").searchParams;
          return [params.get("from"), params.get("to")];
        }),
    ).toEqual([
      [from, to],
      [from, to],
    ]);
    expect(trendText()).toContain(String(from));
    expect(trendText()).toContain("0.00000 kg");
    expect(trendText()).toContain("≥ 0 g · Partial · 1/2 contributions quantified");
    expect(writes()).toHaveLength(0);
    for (const count of [7, 30, 90]) expect(button(`Last ${count} days`).props.type).toBe("button");
    expect(text()).toContain("Ranges end today in your profile time zone.");
  });

  it("samples the clock once per press and uses the new day on a later press", async () => {
    const { fetcher } = trendWorkspace();
    await mount();
    const BaseDate = Date;
    let captures = 0;
    vi.stubGlobal(
      "Date",
      class extends BaseDate {
        constructor(value?: string | number) {
          if (value === undefined) {
            captures += 1;
            super("2026-09-14T04:59:59.999Z");
          } else super(value);
        }
      },
    );
    invoke(button("Last 7 days"), "onClick");
    expect(captures).toBe(1);
    vi.stubGlobal("Date", BaseDate);
    await hooks.settle();
    expect(trendDates()).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    const before = fetcher.mock.calls.length;
    await click("Last 7 days");
    expect(fetcher.mock.calls).toHaveLength(before);
    vi.setSystemTime(new Date("2026-09-14T05:00:00.000Z"));
    await click("Last 7 days");
    expect(trendDates()).toEqual({ from: "2026-09-08", to: "2026-09-14" });
  });

  it.each(["pending", "failed"])(
    "leaves matching %s reads, results and feedback untouched",
    async (phase) => {
      const { state, fetcher, trendReads } = trendWorkspace();
      await mount();
      const pending = deferred<Response>();
      state.trend = (path) =>
        path.includes("/nutrients?") ? pending.promise : trendResponse(path, state.timeZone);
      await click("Last 7 days");
      if (phase === "failed") {
        pending.resolve(
          Response.json({ error: "Keep exact failed trend feedback" }, { status: 503 }),
        );
        await hooks.settle();
      }
      const before = fetcher.mock.calls.length,
        message = status(),
        result = trendText();
      const signal = trendReads().at(-2)?.[1]?.signal;
      const priorSignal = signal?.aborted;
      const matching = button("Last 7 days"),
        other = button("Last 30 days");
      invoke(matching, "onClick");
      invoke(matching, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(signal?.aborted).toBe(priorSignal);
      expect(status()).toBe(message);
      expect(trendText()).toBe(result);
      state.trend = (path) => trendResponse(path, state.timeZone);
      invoke(other, "onClick");
      await hooks.settle();
      expect(trendDates()).toEqual({ from: "2026-08-15", to: "2026-09-13" });
      pending.resolve(Response.json({ error: "Obsolete" }, { status: 503 }));
      await hooks.settle();
    },
  );

  it("preserves custom dates, selected series, every raw draft and an ambiguous write body/key", async () => {
    const { state, fetcher, writes } = trendWorkspace();
    state.eventRead = () => eventPage([reading()]);
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Local date", "2026-09-08");
    await changeEvent("Local time", "07:34");
    await changeEvent("Exact value", "0.00000");
    await changeReminderInput("Private in-app label", " Raw reminder ");
    await changeReminderInput("Local time", "07:06");
    invoke(trendField("Nutrient"), "onChange", { target: { value: "3" } });
    await hooks.settle();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await saveReading();
    const before = inputsExceptTrendDates();
    const historyBefore = text(biometricSection());
    await click("Last 90 days");
    expect(inputsExceptTrendDates()).toEqual(before);
    expect(trendField("Biometric").props.value).toBe(historyDefinition.id);
    expect(text(biometricSection())).toBe(historyBefore);
    expect(writes()).toHaveLength(1);
    pending.resolve(Response.json({ error: "Ambiguous biometric write" }, { status: 503 }));
    await hooks.settle();
    await change("From", "2026-08-01");
    await change("To", "2026-08-12");
    expect(trendDates()).toEqual({ from: "2026-08-01", to: "2026-08-12" });
    await click("Last 30 days");
    state.write = () => Response.json({ error: "Still ambiguous" }, { status: 503 });
    await saveReading();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBe('"1"');
    expect(
      fetcher.mock.calls
        .filter(([path]) => path.startsWith("/api/retention/trends/nutrients?"))
        .slice(-1)[0]?.[0],
    ).toContain("nutrientId=3");
  });

  it.each(["From", "To", "Nutrient", "Biometric"])(
    "rejects retained presets across raw %s A-B-A changes before effects",
    async (label) => {
      const { fetcher } = trendWorkspace();
      await mount();
      const stale = button("Last 90 days");
      const old = trendField(label),
        value = old.props.value;
      const replacement = label === "Nutrient" ? "3" : label === "Biometric" ? "" : "2026-08-01";
      invoke(old, "onChange", { target: { value: replacement } });
      invoke(stale, "onClick");
      hooks.renderWithoutEffects();
      expect(trendField(label).props.value).toBe(replacement);
      invoke(trendField(label), "onChange", { target: { value } });
      hooks.renderWithoutEffects();
      const dates = trendDates(),
        before = fetcher.mock.calls.length;
      invoke(stale, "onClick");
      hooks.renderWithoutEffects();
      expect(trendDates()).toEqual(dates);
      expect(fetcher.mock.calls).toHaveLength(before);
      await hooks.settle();
    },
  );

  it.each(["success", "401", "503"])(
    "aborts obsolete %s before a new pair paints and preserves the newer result",
    async (outcome) => {
      const { state, trendReads } = trendWorkspace();
      await mount();
      const pending = deferred<Response>();
      state.trend = () => pending.promise;
      await click("Last 7 days");
      const old = trendReads().slice(-2),
        stale = button("Last 90 days");
      state.trend = (path) => trendResponse(path, state.timeZone);
      invoke(button("Last 30 days"), "onClick");
      expect(old.every(([, init]) => init?.signal?.aborted)).toBe(true);
      invoke(stale, "onClick");
      await hooks.settle();
      const dates = trendDates(),
        result = trendText(),
        message = status();
      pending.resolve(
        outcome === "success"
          ? trendResponse(old[0]?.[0] ?? "", state.timeZone)
          : Response.json({ error: "obsolete response" }, { status: Number(outcome) }),
      );
      await hooks.settle();
      expect(trendDates()).toEqual(dates);
      expect(trendText()).toBe(result);
      expect(status()).toBe(message);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("preserves manually entered dates during initial loading and disables unverified shortcuts", async () => {
    const { state } = trendWorkspace();
    const pending = deferred<Response>();
    state.auth = () => pending.promise;
    hooks.mount(HealthClient);
    const stale = button("Last 90 days");
    expect(stale.props.disabled).toBe(true);
    hooks.renderWithoutEffects();
    invoke(trendField("From"), "onChange", { target: { value: "2026-08-01" } });
    hooks.renderWithoutEffects();
    invoke(trendField("To"), "onChange", { target: { value: "2026-08-12" } });
    hooks.renderWithoutEffects();
    invoke(stale, "onClick");
    state.auth = null;
    pending.resolve(session());
    await hooks.settle();
    expect(trendDates()).toEqual({ from: "2026-08-01", to: "2026-08-12" });
    expect(button("Last 90 days").props.disabled).toBe(false);
  });

  it("rejects full-refresh and profile-zone callbacks and uses the newly verified zone", async () => {
    const { state, fetcher } = trendWorkspace("2026-09-14T03:00:00.000Z");
    await mount();
    const stale = button("Last 7 days"),
      dates = trendDates();
    const pending = deferred<Response>();
    state.auth = () => pending.promise;
    hooks.replayEffects();
    invoke(stale, "onClick");
    hooks.renderWithoutEffects();
    expect(trendDates()).toEqual(dates);
    expect(button("Last 7 days").props.disabled).toBe(true);
    state.timeZone = "Asia/Tokyo";
    state.auth = null;
    pending.resolve(session(owner, state.timeZone));
    await hooks.settle();
    const before = fetcher.mock.calls.length;
    invoke(stale, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    await click("Last 7 days");
    expect(trendDates()).toEqual({ from: "2026-09-08", to: "2026-09-14" });
  });

  it("rejects hidden-before-event, restored, expired and unmounted shortcuts", async () => {
    const view = visibility();
    const { state, fetcher } = trendWorkspace();
    await mount();
    const stale = button("Last 90 days"),
      dates = trendDates(),
      before = fetcher.mock.calls.length;
    view.document.visibilityState = "hidden";
    invoke(stale, "onClick");
    hooks.renderWithoutEffects();
    expect(button("Last 90 days").props.disabled).toBe(true);
    expect(trendDates()).toEqual(dates);
    await view.set("visible");
    invoke(stale, "onClick");
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    const current = button("Last 90 days");
    state.owner = otherOwner;
    hooks.replayEffects();
    await hooks.settle();
    invoke(current, "onClick");
    await hooks.settle();
    expect(trendDates()).toEqual({ from: "", to: "" });
    expect(button("Last 90 days").props.disabled).toBe(true);
    expect(router.replace).toHaveBeenCalledWith("/login");
    hooks.unmount();
    const updates = hooks.afterClose(),
      requests = fetcher.mock.calls.length;
    invoke(current, "onClick");
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it("rejects unsupported derived dates locally without replacing current inputs", async () => {
    const { fetcher } = trendWorkspace();
    await mount();
    const before = fetcher.mock.calls.length,
      dates = trendDates(),
      message = status();
    vi.setSystemTime(new Date("0001-01-01T12:00:00.000Z"));
    await click("Last 90 days");
    expect(trendDates()).toEqual(dates);
    expect(status()).toBe(message);
    expect(fetcher.mock.calls).toHaveLength(before);
  });
});

describe("trend shortcut aggregate meaning", () => {
  it.each(["exact zero", "unknown", "no data"])(
    "keeps %s distinct after a shortcut",
    async (kind) => {
      const { state } = trendWorkspace();
      state.trend = async (path) => {
        const response = trendResponse(path, state.timeZone);
        if (!path.includes("/nutrients?")) return response;
        const body = await response.json();
        const aggregate = body.data.points[0].aggregate;
        if (kind === "no data") body.data.points[0].aggregate = null;
        else {
          aggregate.completeness = kind === "exact zero" ? "complete" : "unknown";
          aggregate.isExact = kind === "exact zero";
          aggregate.contributorCount = 1;
          aggregate.quantifiedCount = kind === "exact zero" ? 1 : 0;
          aggregate.unknownCount = kind === "exact zero" ? 0 : 1;
          aggregate.unknownReasonCounts.not_reported = aggregate.unknownCount;
        }
        return Response.json(body);
      };
      await mount();
      await click("Last 7 days");
      expect(trendText()).toContain(
        kind === "exact zero"
          ? "0 g · Complete coverage · quantified"
          : kind === "unknown"
            ? "Unknown · 0/1 contributions quantified"
            : "No data",
      );
      expect(trendText()).toContain("2026-09-07");
    },
  );
});

const trendSearchLabel = "Find a trend nutrient by name";
const clearTrendSearchLabel = "Clear trend nutrient filter";
function trendSearchStatus() {
  return text(elements().find((node) => node.props.id === "trend-nutrient-search-status"));
}
function trendNutrientOptions() {
  return elements(trendField("Nutrient"))
    .filter((node) => node.type === "option")
    .map((node) => ({ value: node.props.value, label: text(node) }));
}
function trendSearchWorkspace() {
  const result = trendWorkspace();
  result.state.picker = [
    { id: "3", code: "vitamin_c_first", name: "Vitamin C", unit: "mg", category: "vitamin" },
    { id: "2", code: "protein", name: "Protein", unit: "g", category: "macronutrient" },
    { id: "4", code: "vitamin_c_second", name: "Vitamin C", unit: "ug", category: "vitamin" },
    {
      id: "9007199254740993",
      code: "literal",
      name: "Literal [C].*",
      unit: "IU",
      category: "vitamin",
    },
    { id: "6", code: "sodium", name: "Sodium", unit: "mg", category: "mineral" },
  ];
  return result;
}
async function selectTrendNutrient(value: string) {
  invoke(trendField("Nutrient"), "onChange", { target: { value } });
  await hooks.settle();
}
function inputsExceptTrendSearch() {
  const search = field(trendSearchLabel);
  return elements()
    .filter(
      (node) => ["input", "select", "textarea"].includes(String(node.type)) && node !== search,
    )
    .map((node) => [node.type, node.props.value, node.props.checked]);
}

describe("web Health trend nutrient name search", () => {
  it("matches trimmed literal case-insensitive names while preserving raw text, loaded order, IDs and units", async () => {
    const { fetcher } = trendSearchWorkspace();
    await mount();
    await selectTrendNutrient("2");
    const before = fetcher.mock.calls.length,
      all = trendNutrientOptions();
    await change(trendSearchLabel, "  VITAMIN c  ");
    expect(field(trendSearchLabel).props.value).toBe("  VITAMIN c  ");
    expect(field(trendSearchLabel).props.maxLength).toBe(200);
    expect(trendSearchStatus()).toBe("2 matching of 5 loaded trend nutrients.");
    expect(trendNutrientOptions()).toEqual([
      { value: "3", label: "Vitamin C (mg)" },
      { value: "2", label: "Protein (g) · current selection, outside filter" },
      { value: "4", label: "Vitamin C (ug)" },
    ]);
    expect(trendField("Nutrient").props.value).toBe("2");
    await change(trendSearchLabel, "[c].*");
    expect(trendNutrientOptions()).toEqual([
      { value: "2", label: "Protein (g) · current selection, outside filter" },
      { value: "9007199254740993", label: "Literal [C].* (IU)" },
    ]);
    await click(clearTrendSearchLabel);
    expect(trendNutrientOptions()).toEqual(all);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(button(clearTrendSearchLabel).props.type).toBe("button");
  });

  it("keeps a zero-match selection represented and rejects excluded or unknown IDs without automatic substitution", async () => {
    const { fetcher } = trendSearchWorkspace();
    await mount();
    const before = fetcher.mock.calls.length,
      chosen = trendField("Nutrient").props.value;
    await change(trendSearchLabel, "not a loaded name");
    expect(trendSearchStatus()).toBe(
      "0 matching of 5 loaded trend nutrients. No loaded nutrients match this name.",
    );
    expect(trendNutrientOptions()).toEqual([
      { value: chosen, label: "Vitamin C (mg) · current selection, outside filter" },
    ]);
    await selectTrendNutrient("2");
    await selectTrendNutrient("999");
    await selectTrendNutrient(String(chosen));
    expect(trendField("Nutrient").props.value).toBe(chosen);
    expect(fetcher.mock.calls).toHaveLength(before);
    await click(clearTrendSearchLabel);
    expect(trendNutrientOptions()).toHaveLength(5);
  });

  it("changes selection only on the current matching exact ID and preserves the automatic read contract", async () => {
    const { fetcher, writes } = trendSearchWorkspace();
    await mount();
    const dates = trendDates();
    await change(trendSearchLabel, "[C].*");
    const before = fetcher.mock.calls.length;
    await selectTrendNutrient("9007199254740993");
    expect(trendField("Nutrient").props.value).toBe("9007199254740993");
    const requests = fetcher.mock.calls.slice(before).map(([path]) => path);
    expect(requests).toEqual([
      `/api/retention/trends/nutrients?nutrientId=9007199254740993&from=${dates.from}&to=${dates.to}`,
      "/api/auth/me",
    ]);
    expect(trendNutrientOptions()).toEqual([
      { value: "9007199254740993", label: "Literal [C].* (IU)" },
    ]);
    expect(writes()).toHaveLength(0);
    const after = fetcher.mock.calls.length;
    await selectTrendNutrient("9007199254740993");
    expect(fetcher.mock.calls).toHaveLength(after);
  });

  it("treats same raw query, empty Clear and overlength callbacks as true no-ops", async () => {
    const { fetcher } = trendSearchWorkspace();
    await mount();
    const clear = button(clearTrendSearchLabel),
      select = trendField("Nutrient");
    invoke(clear, "onClick");
    invoke(clear, "onClick");
    invoke(select, "onChange", { target: { value: "2" } });
    await hooks.settle();
    expect(trendField("Nutrient").props.value).toBe("2");
    const before = fetcher.mock.calls.length;
    await change(trendSearchLabel, " ".repeat(200));
    expect(field(trendSearchLabel).props.value).toBe(" ".repeat(200));
    const old = field(trendSearchLabel),
      currentClear = button(clearTrendSearchLabel);
    invoke(old, "onChange", { target: { value: "x".repeat(201) } });
    invoke(old, "onChange", { target: { value: " ".repeat(200) } });
    invoke(currentClear, "onClick");
    await hooks.settle();
    expect(field(trendSearchLabel).props.value).toBe("");
    expect(trendSearchStatus()).toBe("5 matching of 5 loaded trend nutrients.");
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it.each(["pending", "failed"])(
    "preserves %s trend reads, results and feedback through search and Clear",
    async (phase) => {
      const { state, fetcher, trendReads } = trendSearchWorkspace();
      await mount();
      const pending = deferred<Response>();
      state.trend = () => pending.promise.then((response) => response.clone());
      await click("Last 7 days");
      const reads = trendReads().slice(-2);
      if (phase === "failed") {
        pending.resolve(Response.json({ error: "Exact trend failure remains" }, { status: 503 }));
        await hooks.settle();
      }
      const before = fetcher.mock.calls.length,
        inputs = inputsExceptTrendSearch(),
        result = trendText(),
        message = status(),
        cardMessages = [text(trendCardStatus("nutrition")), text(trendCardStatus("biometric"))];
      const aborts = reads.map(([, init]) => init?.signal?.aborted);
      await change(trendSearchLabel, "Sodium");
      await click(clearTrendSearchLabel);
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(reads.map(([, init]) => init?.signal?.aborted)).toEqual(aborts);
      expect(inputsExceptTrendSearch()).toEqual(inputs);
      expect(trendText()).toBe(result);
      expect(status()).toBe(message);
      expect([text(trendCardStatus("nutrition")), text(trendCardStatus("biometric"))]).toEqual(
        cardMessages,
      );
      pending.resolve(Response.json({ error: "Current pending result" }, { status: 503 }));
      await hooks.settle();
      if (phase === "pending") {
        expect(text(trendCardStatus("nutrition"))).toContain("Current pending result");
        expect(text(trendCardStatus("biometric"))).toContain("Current pending result");
        expect(status()).toBe(message);
      }
    },
  );

  it.each(["exact zero", "unknown", "no data"])(
    "preserves %s rendering and all request state during local filtering",
    async (kind) => {
      const { state, fetcher } = trendSearchWorkspace();
      state.trend = async (path) => {
        const response = trendResponse(path, state.timeZone);
        if (!path.includes("/nutrients?")) return response;
        const body = await response.json(),
          aggregate = body.data.points[0].aggregate;
        if (kind === "no data") body.data.points[0].aggregate = null;
        else {
          aggregate.completeness = kind === "exact zero" ? "complete" : "unknown";
          aggregate.isExact = kind === "exact zero";
          aggregate.contributorCount = 1;
          aggregate.quantifiedCount = kind === "exact zero" ? 1 : 0;
          aggregate.unknownCount = kind === "exact zero" ? 0 : 1;
          aggregate.unknownReasonCounts.not_reported = aggregate.unknownCount;
        }
        return Response.json(body);
      };
      await mount();
      const result = trendText(),
        before = fetcher.mock.calls.length;
      expect(result).toContain(
        kind === "no data"
          ? "No data"
          : kind === "exact zero"
            ? "0 g · Complete coverage · quantified"
            : "Unknown · 0/1 contributions quantified",
      );
      await change(trendSearchLabel, "absent");
      await click(clearTrendSearchLabel);
      expect(trendText()).toBe(result);
      expect(fetcher.mock.calls).toHaveLength(before);
    },
  );

  it("preserves exact raw editors, history and an unrelated ambiguous write body/key", async () => {
    const { state, fetcher, writes } = trendSearchWorkspace();
    state.eventRead = () => eventPage([reading()]);
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Local date", "2026-09-08");
    await changeEvent("Local time", "07:34");
    await changeEvent("Exact value", "0.00000");
    await changeReminderInput("Private in-app label", " Raw reminder ");
    await changeReminderInput("Local time", "07:06");
    await click("Last 7 days");
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await saveReading();
    const before = fetcher.mock.calls.length,
      inputs = inputsExceptTrendSearch(),
      history = text(biometricSection()),
      result = trendText(),
      message = status();
    await change(trendSearchLabel, "Sodium");
    await click(clearTrendSearchLabel);
    expect(inputsExceptTrendSearch()).toEqual(inputs);
    expect(text(biometricSection())).toBe(history);
    expect(trendText()).toBe(result);
    expect(status()).toBe(message);
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(writes()).toHaveLength(1);
    pending.resolve(Response.json({ error: "Ambiguous biometric write" }, { status: 503 }));
    await hooks.settle();
    await change(trendSearchLabel, "none");
    await click(clearTrendSearchLabel);
    state.write = () => Response.json({ error: "Still ambiguous" }, { status: 503 });
    await saveReading();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[1]?.body).toBe(writes()[0]?.[1]?.body);
    expect(new Headers(writes()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes()[0]?.[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBe('"1"');
  });

  it("rejects old query, Clear and selection after a raw edit-and-restore cycle before effects", async () => {
    const { fetcher } = trendSearchWorkspace();
    await mount();
    const oldQuery = field(trendSearchLabel),
      oldClear = button(clearTrendSearchLabel),
      oldSelect = trendField("Nutrient"),
      before = fetcher.mock.calls.length;
    invoke(oldQuery, "onChange", { target: { value: "Sodium" } });
    invoke(oldSelect, "onChange", { target: { value: "2" } });
    invoke(oldClear, "onClick");
    hooks.renderWithoutEffects();
    expect(field(trendSearchLabel).props.value).toBe("Sodium");
    invoke(field(trendSearchLabel), "onChange", { target: { value: "" } });
    hooks.renderWithoutEffects();
    invoke(oldQuery, "onChange", { target: { value: "stale" } });
    invoke(oldSelect, "onChange", { target: { value: "2" } });
    invoke(oldClear, "onClick");
    hooks.renderWithoutEffects();
    expect(field(trendSearchLabel).props.value).toBe("");
    expect(trendField("Nutrient").props.value).toBe("3");
    expect(fetcher.mock.calls).toHaveLength(before);
    await selectTrendNutrient("2");
    expect(trendField("Nutrient").props.value).toBe("2");
  });

  it("does not invalidate retained date preset or unrelated editor callbacks while filtering", async () => {
    trendSearchWorkspace();
    await mount();
    const preset = button("Last 7 days"),
      reminderInput = reminderField("Private in-app label");
    invoke(field(trendSearchLabel), "onChange", { target: { value: "Sodium" } });
    invoke(reminderInput, "onChange", { target: { value: "still current" } });
    invoke(preset, "onClick");
    await hooks.settle();
    expect(field(trendSearchLabel).props.value).toBe("Sodium");
    expect(reminderField("Private in-app label").props.value).toBe("still current");
    expect(trendDates()).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it.each(["From", "To", "Nutrient", "Biometric"])(
    "rejects retained search controls after %s changes before effects",
    async (label) => {
      const { fetcher } = trendSearchWorkspace();
      await mount();
      const query = field(trendSearchLabel),
        select = trendField("Nutrient"),
        clear = button(clearTrendSearchLabel);
      const next = label === "Nutrient" ? "2" : label === "Biometric" ? "" : "2026-08-01";
      invoke(trendField(label), "onChange", { target: { value: next } });
      const before = fetcher.mock.calls.length;
      invoke(query, "onChange", { target: { value: "stale" } });
      invoke(select, "onChange", { target: { value: "6" } });
      invoke(clear, "onClick");
      hooks.renderWithoutEffects();
      expect(field(trendSearchLabel).props.value).toBe("");
      expect(trendField("Nutrient").props.value).toBe(label === "Nutrient" ? "2" : "3");
      expect(fetcher.mock.calls).toHaveLength(before);
      await hooks.settle();
    },
  );

  it("retains same-scope query and an unavailable selected ID after replacing loaded metadata", async () => {
    const { state, fetcher } = trendSearchWorkspace();
    await mount();
    await selectTrendNutrient("2");
    await change(trendSearchLabel, " vitamin ");
    const query = field(trendSearchLabel),
      select = trendField("Nutrient"),
      clear = button(clearTrendSearchLabel);
    const pending = deferred<Response>();
    state.read = () => pending.promise;
    state.picker = [
      {
        id: "4",
        code: "vitamin_c_second",
        name: "Current Vitamin C",
        unit: "ug",
        category: "vitamin",
      },
    ];
    hooks.replayEffects();
    invoke(query, "onChange", { target: { value: "stale" } });
    invoke(select, "onChange", { target: { value: "3" } });
    invoke(clear, "onClick");
    hooks.renderWithoutEffects();
    expect(field(trendSearchLabel).props.value).toBe("");
    expect(trendField("Nutrient").props.disabled).toBe(true);
    expect(trendNutrientOptions()).toEqual([{ value: "", label: "Trend nutrients unavailable" }]);
    expect(trendSearchStatus()).toContain("Loading");
    pending.resolve(Response.json({ data: state.picker }));
    await hooks.settle();
    expect(field(trendSearchLabel).props.value).toBe(" vitamin ");
    expect(trendField("Nutrient").props.value).toBe("2");
    expect(trendNutrientOptions()).toEqual([
      { value: "2", label: "Current selection unavailable in the loaded list" },
      { value: "4", label: "Current Vitamin C (ug)" },
    ]);
    expect(trendSearchStatus()).toBe("1 matching of 1 loaded trend nutrients.");
    const before = fetcher.mock.calls.length;
    invoke(query, "onChange", { target: { value: "stale" } });
    invoke(select, "onChange", { target: { value: "3" } });
    invoke(clear, "onClick");
    await selectTrendNutrient("2");
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(field(trendSearchLabel).props.value).toBe(" vitamin ");
  });

  it.each(["empty", "failed", "loading"])(
    "distinguishes a %s registry without claiming matches or guessing metadata",
    async (phase) => {
      const { state, fetcher } = trendSearchWorkspace();
      const pending = deferred<Response>();
      state.picker = [];
      if (phase === "failed")
        state.read = () =>
          Response.json({ error: "Fixture registry load failed" }, { status: 503 });
      if (phase === "loading") state.read = () => pending.promise;
      await mount();
      const before = fetcher.mock.calls.length;
      invoke(field(trendSearchLabel), "onChange", { target: { value: "private" } });
      invoke(button(clearTrendSearchLabel), "onClick");
      invoke(trendField("Nutrient"), "onChange", { target: { value: "2" } });
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(trendSearchStatus()).toBe(
        phase === "empty"
          ? "No trend nutrients are available in the loaded list."
          : phase === "loading"
            ? "Loading the trend nutrient list…"
            : "The trend nutrient list is unavailable. Reload this page to try again.",
      );
      expect(trendNutrientOptions()).toEqual([
        {
          value: "",
          label: phase === "empty" ? "No trend nutrient selected" : "Trend nutrients unavailable",
        },
      ]);
      pending.resolve(Response.json({ data: state.picker }));
      await hooks.settle();
    },
  );

  it.each(["America/Chicago", "Asia/Tokyo"])(
    "fences profile refresh to %s and retains only same-scope query",
    async (zone) => {
      const { state, fetcher } = trendSearchWorkspace();
      await mount();
      await changeReminderInput("Private in-app label", "Preserved reminder draft");
      await change(trendSearchLabel, " vitamin ");
      const query = field(trendSearchLabel),
        select = trendField("Nutrient"),
        clear = button(clearTrendSearchLabel);
      const pending = deferred<Response>();
      state.auth = () => pending.promise.then((response) => response.clone());
      hooks.replayEffects();
      await hooks.settle();
      const during = fetcher.mock.calls.length;
      invoke(query, "onChange", { target: { value: "stale" } });
      invoke(select, "onChange", { target: { value: "2" } });
      invoke(clear, "onClick");
      hooks.renderWithoutEffects();
      expect(field(trendSearchLabel).props.disabled).toBe(true);
      expect(fetcher.mock.calls).toHaveLength(during);
      pending.resolve(session(owner, zone));
      await hooks.settle();
      const before = fetcher.mock.calls.length;
      invoke(query, "onChange", { target: { value: "stale" } });
      invoke(select, "onChange", { target: { value: "2" } });
      invoke(clear, "onClick");
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(before);
      expect(field(trendSearchLabel).props.value).toBe(
        zone === "America/Chicago" ? " vitamin " : "",
      );
      expect(reminderField("Private in-app label").props.value).toBe("Preserved reminder draft");
      expect(field(trendSearchLabel).props.disabled).toBe(false);
    },
  );

  it("hides background query/metadata before effects, rejects restored callbacks and clears private closure", async () => {
    const view = visibility(),
      { state, fetcher } = trendSearchWorkspace();
    await mount();
    await change(trendSearchLabel, " private name ");
    const query = field(trendSearchLabel),
      select = trendField("Nutrient"),
      clear = button(clearTrendSearchLabel),
      before = fetcher.mock.calls.length;
    view.document.visibilityState = "hidden";
    invoke(query, "onChange", { target: { value: "stale" } });
    invoke(select, "onChange", { target: { value: "2" } });
    invoke(clear, "onClick");
    hooks.renderWithoutEffects();
    expect(field(trendSearchLabel).props.value).toBe("");
    expect(trendNutrientOptions()).toEqual([{ value: "", label: "Trend nutrients unavailable" }]);
    await view.set("visible");
    invoke(query, "onChange", { target: { value: "stale" } });
    invoke(select, "onChange", { target: { value: "2" } });
    invoke(clear, "onClick");
    await hooks.settle();
    expect(field(trendSearchLabel).props.value).toBe(" private name ");
    expect(fetcher.mock.calls).toHaveLength(before);
    const current = field(trendSearchLabel);
    state.owner = otherOwner;
    hooks.replayEffects();
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(field(trendSearchLabel).props.value).toBe("");
    expect(trendNutrientOptions()).toEqual([{ value: "", label: "Trend nutrients unavailable" }]);
    hooks.unmount();
    const updates = hooks.afterClose(),
      requests = fetcher.mock.calls.length;
    invoke(current, "onChange", { target: { value: "stale" } });
    invoke(select, "onChange", { target: { value: "2" } });
    invoke(clear, "onClick");
    expect(hooks.afterClose()).toBe(updates);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });
});

describe("independent private health section loading", () => {
  it.each([
    ["/api/retention/reminders", "reminders"],
    ["/api/retention/integrations/health", "health integrations"],
  ])(
    "keeps nutrients and history usable while %s waits, fails and retries alone",
    async (path, label) => {
      const { state, fetcher } = historyWorkspace();
      const pending = deferred<Response>();
      state.sectionRead = (url) => (url === path ? pending.promise : undefined);
      await mount();
      expect(text()).toContain(`Loading ${label}…`);
      expect(field(trendSearchLabel).props.disabled).toBe(false);
      expect(button("Reload history").props.disabled).toBe(false);
      await change("From", "2026-08-01");
      await changeEvent("Exact value", "73.12300");
      pending.resolve(Response.json({ error: "Section unavailable" }, { status: 503 }));
      await hooks.settle();
      expect(button(`Retry ${label}`).props.disabled).toBe(false);
      expect(field(trendSearchLabel).props.disabled).toBe(false);
      expect(button("Reload history").props.disabled).toBe(false);
      const before = fetcher.mock.calls.length;
      state.sectionRead = null;
      await click(`Retry ${label}`);
      const privatePaths = fetcher.mock.calls
        .slice(before)
        .map(([url]) => url)
        .filter((url) => url !== "/api/auth/me");
      expect(privatePaths).toEqual([path]);
      expect(field("From").props.value).toBe("2026-08-01");
      expect(fetcher.mock.calls.some(([url]) => url.includes("custom-foods"))).toBe(false);
      expect(text(eventForm())).toContain("Log event");
      expect(elements(eventForm()).find((node) => node.props.value === "73.12300")).toBeDefined();
      expect(text()).not.toContain(`Retry ${label}`);
    },
  );

  it("keeps biometric reads available when the nutrient registry fails", async () => {
    const { state } = historyWorkspace();
    state.sectionRead = (url) =>
      url === "/api/nutrients/targetable"
        ? Response.json({ error: "Metadata unavailable" }, { status: 503 })
        : undefined;
    await mount();
    expect(button("Retry nutrient choices").props.disabled).toBe(false);
    expect(button("Reload history").props.disabled).toBe(false);
    expect(eventRows()).not.toHaveLength(0);
  });

  it("closes all sections when an unrelated delayed request reports unauthorized", async () => {
    const { state } = historyWorkspace();
    const pending = deferred<Response>();
    state.sectionRead = (url) => (url === "/api/retention/reminders" ? pending.promise : undefined);
    await mount();
    const oldReload = button("Reload history");
    pending.resolve(Response.json({ error: "Expired" }, { status: 401 }));
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(eventRows()).toHaveLength(0);
    invoke(oldReload, "onClick");
    await hooks.settle();
    expect(eventRows()).toHaveLength(0);
  });
});

describe("Health request independence", () => {
  it("loads its nutrient registry and Health sections without loading or displaying custom foods", async () => {
    const { fetcher } = trendWorkspace();
    await mount();
    const paths = fetcher.mock.calls.map(([url]) => url);
    expect(paths).toContain("/api/nutrients/targetable");
    expect(paths).toContain("/api/retention/biometrics/definitions");
    expect(paths).toContain("/api/retention/reminders");
    expect(paths).toContain("/api/retention/integrations/health");
    expect(paths.some((url) => url.startsWith("/api/retention/trends/"))).toBe(true);
    expect(paths.some((url) => url.includes("custom-foods"))).toBe(false);
    expect(text()).not.toContain("Create private food");
    expect(trendText()).toContain("Response protein");
  });
});

describe("independent Health trend cards", () => {
  it.each([
    ["nutrients", "pending"],
    ["nutrients", "failed"],
    ["biometrics", "pending"],
    ["biometrics", "failed"],
  ])("installs the healthy peer while %s is %s", async (blocked, phase) => {
    const { state, trendReads, writes } = trendWorkspace();
    const pending = deferred<Response>();
    state.trend = (path) =>
      path.includes(`/${blocked}?`)
        ? phase === "pending"
          ? pending.promise
          : Response.json({ error: `${blocked} unavailable` }, { status: 503 })
        : trendResponse(path, state.timeZone);
    await mount();
    expect(trendReads().some(([path]) => path.includes("/nutrients?"))).toBe(true);
    expect(trendReads().some(([path]) => path.includes("/biometrics?"))).toBe(true);
    expect(trendText()).toContain(
      blocked === "nutrients" ? "0.00000 kg" : "≥ 0 g · Partial · 1/2 contributions quantified",
    );
    expect(trendText()).not.toContain(blocked === "nutrients" ? "≥ 0 g" : "0.00000 kg");
    expect(writes()).toHaveLength(0);
  });

  it.each(["nutrients", "biometrics"])(
    "retries only the failed %s card and preserves its healthy peer",
    async (failed) => {
      const { state, trendReads, writes } = trendWorkspace();
      state.trend = (path) =>
        path.includes(`/${failed}?`)
          ? Response.json({ error: `${failed} unavailable` }, { status: 503 })
          : trendResponse(path, state.timeZone);
      await mount();
      const before = trendReads().length;
      const retry = button(
        failed === "nutrients" ? "Retry nutrition trend" : "Retry biometric trend",
      );
      const pending = deferred<Response>();
      state.trend = (path) =>
        path.includes(`/${failed}?`) ? pending.promise : trendResponse(path, state.timeZone);
      invoke(retry, "onClick");
      await hooks.settle();
      expect(
        trendReads()
          .slice(before)
          .map(([path]) => path.split("?")[0]),
      ).toEqual([`/api/retention/trends/${failed}`]);
      expect(trendText()).toContain(
        failed === "nutrients" ? "0.00000 kg" : "≥ 0 g · Partial · 1/2 contributions quantified",
      );
      const current = requiredHistory(trendReads().at(-1));
      pending.resolve(trendResponse(current[0], state.timeZone));
      await hooks.settle();
      expect(trendText()).toContain("0.00000 kg");
      expect(trendText()).toContain("≥ 0 g · Partial · 1/2 contributions quantified");
      expect(writes()).toHaveLength(0);
    },
  );

  it.each(["2026-08-01", ""])(
    "hides both old results before effects after changing From to %s",
    async (from) => {
      const { fetcher } = trendWorkspace();
      await mount();
      expect(trendText()).toContain("0.00000 kg");
      expect(trendText()).toContain("≥ 0 g");
      const before = fetcher.mock.calls.length;
      invoke(trendField("From"), "onChange", { target: { value: from } });
      hooks.renderWithoutEffects();
      expect(trendDates().from).toBe(from);
      expect(trendText()).not.toContain("0.00000 kg");
      expect(trendText()).not.toContain("≥ 0 g");
      expect(fetcher.mock.calls).toHaveLength(before);
    },
  );

  it("clears Biometric None immediately without refetching or hiding nutrition", async () => {
    const { trendReads } = trendWorkspace();
    await mount();
    const before = trendReads().length;
    invoke(trendField("Biometric"), "onChange", { target: { value: "" } });
    hooks.renderWithoutEffects();
    expect(trendText()).not.toContain("0.00000 kg");
    expect(trendText()).toContain("≥ 0 g · Partial · 1/2 contributions quantified");
    hooks.render();
    await hooks.settle();
    expect(trendReads()).toHaveLength(before);
  });
});

function trendCardStatus(kind: "nutrition" | "biometric") {
  return requiredHistory(elements().find((node) => node.props.id === `${kind}-trend-status`));
}

describe("Health trend card context and recovery", () => {
  it.each(["nutrients", "biometrics"])(
    "keeps %s loading, error, and empty feedback scoped to its live region",
    async (kind) => {
      const { state, trendReads } = trendWorkspace();
      const pending = deferred<Response>();
      state.trend = (path) =>
        path.includes(`/${kind}?`) ? pending.promise : trendResponse(path, state.timeZone);
      await mount();
      const label = kind === "nutrients" ? "nutrition" : "biometric";
      expect(trendCardStatus(label).props["aria-live"]).toBe("polite");
      expect(text(trendCardStatus(label))).toMatch(/loading/i);
      expect(trendText()).toContain(kind === "nutrients" ? "0.00000 kg" : "≥ 0 g");
      pending.resolve(Response.json({ data: { malformed: true } }));
      await hooks.settle();
      expect(text(trendCardStatus(label))).not.toMatch(/loading/i);
      expect(button(`Retry ${label} trend`).props.disabled).not.toBe(true);
      state.trend = async (path) => {
        const body = await trendResponse(path, state.timeZone).json();
        body.data.points = [];
        return Response.json(body);
      };
      const before = trendReads().length;
      await click(`Retry ${label} trend`);
      expect(
        trendReads()
          .slice(before)
          .map(([path]) => path.split("?")[0]),
      ).toEqual([`/api/retention/trends/${kind}`]);
      expect(text(trendCardStatus(label))).toMatch(/no .*data|no .*record|no .*point/i);
      expect(trendText()).toContain(kind === "nutrients" ? "0.00000 kg" : "≥ 0 g");
    },
  );

  it.each([
    ["From", ""],
    ["To", ""],
    ["From", "2026-02-30"],
    ["From", "not-a-date"],
    ["From", "2026-09-14"],
  ])(
    "hides old rows for invalid %s=%s without fetching and recovers with a valid preset",
    async (label, value) => {
      const { trendReads } = trendWorkspace();
      await mount();
      const before = trendReads().length;
      invoke(trendField(label), "onChange", { target: { value } });
      hooks.renderWithoutEffects();
      expect(trendText()).not.toContain("0.00000 kg");
      expect(trendText()).not.toContain("≥ 0 g");
      hooks.render();
      await hooks.settle();
      expect(trendReads()).toHaveLength(before);
      expect(text(trendCardStatus("nutrition"))).toMatch(/range|date/i);
      expect(text(trendCardStatus("biometric"))).toMatch(/range|date/i);
      await click("Last 7 days");
      expect(trendReads()).toHaveLength(before + 2);
      expect(trendText()).toContain("2026-09-07");
      expect(trendText()).toContain("0.00000 kg");
      expect(trendText()).toContain("≥ 0 g");
    },
  );

  it("accepts a single-day inclusive range and makes equal range and series selections no-ops", async () => {
    const { trendReads, fetcher } = trendWorkspace();
    await mount();
    invoke(trendField("From"), "onChange", { target: { value: String(trendDates().to) } });
    await hooks.settle();
    expect(
      trendReads()
        .slice(-2)
        .map(([path]) => requestRange(path)),
    ).toEqual([
      { from: "2026-09-13", to: "2026-09-13", cursor: null, limit: null },
      { from: "2026-09-13", to: "2026-09-13", cursor: null, limit: null },
    ]);
    const before = fetcher.mock.calls.length,
      result = trendText();
    for (const label of ["From", "To", "Nutrient", "Biometric"]) {
      const input = trendField(label);
      invoke(input, "onChange", { target: { value: input.props.value } });
    }
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(trendText()).toBe(result);
  });

  it.each(["Nutrient", "Biometric"])(
    "hides only replaced %s rows before effects and requests only that series",
    async (label) => {
      const { state, trendReads } = trendWorkspace();
      const second = {
        ...historyDefinition,
        id: "4bcfa2bf-4950-43f7-9f24-000000000002",
        name: "Second metric",
      };
      state.definitions = [historyDefinition, second];
      state.trend = async (path) => {
        const body = await trendResponse(path, state.timeZone).json();
        if (path.includes(second.id)) body.data.definition = second;
        return Response.json(body);
      };
      await mount();
      const before = trendReads().length;
      invoke(trendField(label), "onChange", {
        target: { value: label === "Nutrient" ? "3" : second.id },
      });
      hooks.renderWithoutEffects();
      expect(trendText()).not.toContain(label === "Nutrient" ? "≥ 0 g" : "0.00000 kg");
      expect(trendText()).toContain(label === "Nutrient" ? "0.00000 kg" : "≥ 0 g");
      hooks.render();
      await hooks.settle();
      expect(
        trendReads()
          .slice(before)
          .map(([path]) => path.split("?")[0]),
      ).toEqual([`/api/retention/trends/${label === "Nutrient" ? "nutrients" : "biometrics"}`]);
      expect(trendText()).toContain("0.00000 kg");
      expect(trendText()).toContain("≥ 0 g");
    },
  );

  it.each(["profile", "owner"])(
    "hides obsolete rows after a verified %s replacement before effects",
    async (scope) => {
      const { state, trendReads } = trendWorkspace();
      await mount();
      const pending = deferred<Response>();
      state.trend = () => pending.promise;
      state.timeZone = scope === "profile" ? "Asia/Tokyo" : state.timeZone;
      state.owner = scope === "owner" ? otherOwner : owner;
      hooks.replayEffects();
      await new Promise((resolve) => setTimeout(resolve, 0));
      hooks.renderWithoutEffects();
      expect(trendText()).not.toContain("0.00000 kg");
      expect(trendText()).not.toContain("≥ 0 g");
      if (scope === "owner") expect(router.replace).toHaveBeenCalledWith("/login");
      else {
        expect(router.replace).not.toHaveBeenCalled();
        const before = trendReads().length;
        state.trend = (path) => trendResponse(path, state.timeZone);
        hooks.render();
        await hooks.settle();
        expect(trendReads().length).toBeGreaterThan(before);
        expect(trendText()).toContain("Asia/Tokyo");
        expect(trendText()).toContain("0.00000 kg");
      }
    },
  );

  it.each(["nutrients", "biometrics"])(
    "rejects retained %s Retry after range edit-and-restore and deduplicates a current Retry",
    async (kind) => {
      const { state, trendReads } = trendWorkspace();
      state.trend = (path) =>
        path.includes(`/${kind}?`)
          ? Response.json({ error: "Try again" }, { status: 503 })
          : trendResponse(path, state.timeZone);
      await mount();
      const label = kind === "nutrients" ? "Retry nutrition trend" : "Retry biometric trend";
      const stale = button(label),
        original = trendDates().from;
      invoke(trendField("From"), "onChange", { target: { value: "2026-08-01" } });
      hooks.renderWithoutEffects();
      invoke(trendField("From"), "onChange", { target: { value: original } });
      hooks.renderWithoutEffects();
      const before = trendReads().length;
      invoke(stale, "onClick");
      expect(trendReads()).toHaveLength(before);
      hooks.render();
      await hooks.settle();
      const pending = deferred<Response>();
      state.trend = (path) =>
        path.includes(`/${kind}?`) ? pending.promise : trendResponse(path, state.timeZone);
      const current = button(label),
        currentBefore = trendReads().length;
      invoke(current, "onClick");
      invoke(current, "onClick");
      await hooks.settle();
      expect(
        trendReads()
          .slice(currentBefore)
          .map(([path]) => path.split("?")[0]),
      ).toEqual([`/api/retention/trends/${kind}`]);
    },
  );

  it.each(["success", "503", "401"])(
    "ignores a late %s JSON/read result across replacement, unmount, and private closure",
    async (outcome) => {
      for (const ending of ["replacement", "unmount", "closure"]) {
        const { state, trendReads, fetcher } = trendWorkspace();
        await mount();
        const pending = deferred<Response>();
        state.trend = (path) =>
          path.includes("/biometrics?") ? pending.promise : trendResponse(path, state.timeZone);
        await click("Last 7 days");
        const old = requiredHistory(
          trendReads()
            .filter(([path]) => path.includes("/biometrics?"))
            .at(-1),
        );
        if (ending === "replacement") {
          state.trend = (path) => trendResponse(path, state.timeZone);
          await click("Last 30 days");
        } else if (ending === "unmount") hooks.unmount();
        else {
          state.owner = otherOwner;
          hooks.replayEffects();
          await hooks.settle();
          expect(router.replace).toHaveBeenCalledWith("/login");
        }
        expect(old[1]?.signal?.aborted).toBe(true);
        const before = fetcher.mock.calls.length,
          updates = hooks.afterClose(),
          redirects = router.replace.mock.calls.length;
        const result = trendText(),
          message = status();
        const response =
          outcome === "success"
            ? trendResponse(old[0], state.timeZone)
            : Response.json({ error: "obsolete private result" }, { status: Number(outcome) });
        const readBody = vi.spyOn(response, "json");
        pending.resolve(response);
        await hooks.settle();
        expect(fetcher.mock.calls).toHaveLength(before);
        expect(hooks.afterClose()).toBe(updates);
        expect(router.replace).toHaveBeenCalledTimes(redirects);
        expect(trendText()).toBe(result);
        expect(status()).toBe(message);
        expect(readBody).not.toHaveBeenCalled();
        hooks.unmount();
        vi.clearAllMocks();
      }
    },
  );

  it("ignores parsed old data that completes after a range replacement", async () => {
    const { state, trendReads, fetcher } = trendWorkspace();
    await mount();
    const body = deferred<unknown>();
    let requested = "";
    state.trend = (path) => {
      if (!path.includes("/nutrients?")) return trendResponse(path, state.timeZone);
      requested = path;
      const response = Response.json({});
      vi.spyOn(response, "json").mockImplementation(() => body.promise);
      return response;
    };
    await click("Last 7 days");
    expect(requested).not.toBe("");
    const old = requiredHistory(
      trendReads()
        .filter(([path]) => path.includes("/nutrients?"))
        .at(-1),
    );
    state.trend = (path) => trendResponse(path, state.timeZone);
    await click("Last 30 days");
    expect(old[1]?.signal?.aborted).toBe(true);
    const before = fetcher.mock.calls.length,
      result = trendText();
    body.resolve(await trendResponse(requested, "America/Chicago").json());
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(before);
    expect(trendText()).toBe(result);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(["nutrients", "biometrics"])(
    "closes every private view for a current %s 401 before reading JSON",
    async (kind) => {
      const { state } = trendWorkspace();
      state.eventRead = () => eventPage([reading()]);
      await mount();
      const unauthorized = Response.json({ error: "expired" }, { status: 401 });
      const readBody = vi.spyOn(unauthorized, "json");
      state.trend = (path) =>
        path.includes(`/${kind}?`) ? unauthorized : trendResponse(path, state.timeZone);
      await click("Last 7 days");
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(readBody).not.toHaveBeenCalled();
      expect(trendText()).not.toContain("0.00000 kg");
      expect(trendText()).not.toContain("≥ 0 g");
      expect(eventRows()).toHaveLength(0);
      expect(trendDates()).toEqual({ from: "", to: "" });
    },
  );
});

describe("Health trend response scope verification", () => {
  it.each([
    ["nutrients", "identity"],
    ["nutrients", "range"],
    ["nutrients", "timeZone"],
    ["biometrics", "identity"],
    ["biometrics", "range"],
    ["biometrics", "timeZone"],
  ])(
    "rejects a %s response with the wrong %s while preserving its peer",
    async (kind, mismatch) => {
      const { state, trendReads } = trendWorkspace();
      state.trend = async (path) => {
        const body = await trendResponse(path, state.timeZone).json();
        if (path.includes(`/${kind}?`)) {
          if (mismatch === "identity") {
            if (kind === "nutrients") body.data.nutrient.id = "999";
            else body.data.definition.id = "4bcfa2bf-4950-43f7-9f24-000000000099";
          } else if (mismatch === "range") body.data.to = "2026-09-12";
          else body.data.timeZone = "Asia/Tokyo";
        }
        return Response.json(body);
      };
      await mount();
      const retryLabel = kind === "nutrients" ? "Retry nutrition trend" : "Retry biometric trend";
      expect(button(retryLabel).props.disabled).not.toBe(true);
      expect(trendText()).not.toContain(kind === "nutrients" ? "≥ 0 g" : "0.00000 kg");
      expect(trendText()).toContain(kind === "nutrients" ? "0.00000 kg" : "≥ 0 g");
      const before = trendReads().length;
      state.trend = (path) => trendResponse(path, state.timeZone);
      await click(retryLabel);
      expect(
        trendReads()
          .slice(before)
          .map(([path]) => path.split("?")[0]),
      ).toEqual([`/api/retention/trends/${kind}`]);
      expect(trendText()).toContain("0.00000 kg");
      expect(trendText()).toContain("≥ 0 g");
    },
  );

  it("revalidates both cards under a changed same-owner profile without installing the earlier zone result", async () => {
    const { state, trendReads } = trendWorkspace();
    await mount();
    const pending = deferred<Response>();
    state.trend = (path) =>
      path.includes("/nutrients?") ? pending.promise : trendResponse(path, state.timeZone);
    await click("Last 7 days");
    const old = requiredHistory(
      trendReads()
        .filter(([path]) => path.includes("/nutrients?"))
        .at(-1),
    );
    const newReads = deferred<Response>();
    state.timeZone = "Asia/Tokyo";
    state.trend = () => newReads.promise;
    pending.resolve(trendResponse(old[0], "America/Chicago"));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(trendText()).not.toContain("0.00000 kg");
    expect(trendText()).not.toContain("≥ 0 g");
    expect(trendText()).not.toContain("Buckets use America/Chicago");
    expect(
      trendReads()
        .slice(-2)
        .map(([path]) => path.split("?")[0]),
    ).toEqual(["/api/retention/trends/nutrients", "/api/retention/trends/biometrics"]);
    state.trend = (path) => trendResponse(path, state.timeZone);
    await click("Last 30 days");
    expect(trendText()).toContain("Asia/Tokyo");
    expect(trendText()).toContain("0.00000 kg");
    expect(trendText()).toContain("≥ 0 g");
    const result = trendText();
    newReads.resolve(Response.json({ error: "obsolete zone response" }, { status: 401 }));
    await hooks.settle();
    expect(trendText()).toBe(result);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("rejects Retry before a visibility event and rejects the old Retry after restoring visibility", async () => {
    const view = visibility();
    const { state, trendReads } = trendWorkspace();
    state.trend = (path) =>
      path.includes("/nutrients?")
        ? Response.json({ error: "Try again" }, { status: 503 })
        : trendResponse(path, state.timeZone);
    await mount();
    const stale = button("Retry nutrition trend"),
      before = trendReads().length;
    expect(trendText()).toContain("0.00000 kg");
    view.document.visibilityState = "hidden";
    invoke(stale, "onClick");
    hooks.renderWithoutEffects();
    expect(trendReads()).toHaveLength(before);
    await view.set("visible");
    const restored = trendReads().length;
    invoke(stale, "onClick");
    await hooks.settle();
    expect(trendReads()).toHaveLength(restored);
  });

  it.each(["nutrients", "biometrics"])(
    "verifies ownership after the %s read before exposing it",
    async (kind) => {
      const { state, trendReads } = trendWorkspace();
      await mount();
      const pending = deferred<Response>();
      state.trend = (path) =>
        path.includes(`/${kind}?`) ? pending.promise : trendResponse(path, state.timeZone);
      await click("Last 7 days");
      expect(trendText()).toContain(kind === "nutrients" ? "0.00000 kg" : "≥ 0 g");
      const old = requiredHistory(
        trendReads()
          .filter(([path]) => path.includes(`/${kind}?`))
          .at(-1),
      );
      state.owner = otherOwner;
      pending.resolve(trendResponse(old[0], state.timeZone));
      await hooks.settle();
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(trendText()).not.toContain("0.00000 kg");
      expect(trendText()).not.toContain("≥ 0 g");
      expect(trendDates()).toEqual({ from: "", to: "" });
    },
  );
});

describe("batched Health trend restoration", () => {
  it.each(["range", "nutrient", "biometric"])(
    "reloads restored %s after A-to-B-to-A renders commit together",
    async (kind) => {
      const { state, trendReads } = trendWorkspace();
      const second = {
        ...historyDefinition,
        id: "4bcfa2bf-4950-43f7-9f24-000000000002",
        name: "Second metric",
      };
      state.definitions = [historyDefinition, second];
      await mount();
      expect(trendText()).toContain("≥ 0 g");
      expect(trendText()).toContain("0.00000 kg");
      const before = trendReads().length;
      const label = kind === "range" ? "From" : kind === "nutrient" ? "Nutrient" : "Biometric";
      const original = trendField(label).props.value;
      const replacement = kind === "range" ? "2026-08-01" : kind === "nutrient" ? "3" : second.id;
      invoke(trendField(label), "onChange", { target: { value: replacement } });
      hooks.renderBeforeCommit();
      expect(trendField(label).props.value).toBe(replacement);
      invoke(trendField(label), "onChange", { target: { value: original } });
      hooks.renderBeforeCommit();
      expect(trendField(label).props.value).toBe(original);
      expect(trendReads()).toHaveLength(before);
      if (kind !== "biometric") expect(trendText()).not.toContain("≥ 0 g");
      if (kind !== "nutrient") expect(trendText()).not.toContain("0.00000 kg");
      if (kind !== "range")
        expect(trendText()).toContain(kind === "nutrient" ? "0.00000 kg" : "≥ 0 g");
      hooks.render();
      await hooks.settle();
      expect(
        trendReads()
          .slice(before)
          .map(([path]) => path.split("?")[0]),
      ).toEqual(
        kind === "range"
          ? ["/api/retention/trends/nutrients", "/api/retention/trends/biometrics"]
          : [`/api/retention/trends/${kind === "nutrient" ? "nutrients" : "biometrics"}`],
      );
      expect(trendText()).toContain("≥ 0 g");
      expect(trendText()).toContain("0.00000 kg");
      expect(text(trendCardStatus("nutrition"))).not.toMatch(/loading/i);
      expect(text(trendCardStatus("biometric"))).not.toMatch(/loading/i);
    },
  );
});

describe("Health manual-event editor replacement protection", () => {
  function replacementWorkspace() {
    const result = historyWorkspace();
    const first = reading(1);
    const second = reading(2, "2026-09-10T11:22:33.456Z");
    result.state.eventRead = () => eventPage([first, second]);
    return { ...result, first, second };
  }

  function replacementDraft() {
    return [
      ["Metric", elements(eventForm()).find((node) => node.type === "select")?.props.value],
      ...["Exact value", "Local date", "Local time"].map((label) => [
        label,
        eventField(label).props.value,
      ]),
    ];
  }

  it.each([0, 1])(
    "preserves every raw correction field when row %s Edit is invoked",
    async (row) => {
      const { fetcher } = replacementWorkspace();
      await mount();
      await click("Edit", eventRows()[0]);
      await changeEvent("Exact value", "  invalid raw decimal  ");
      await changeEvent("Local date", "2026-09-09");
      await changeEvent("Local time", "00:45");
      const before = replacementDraft();
      const count = fetcher.mock.calls.length;
      invoke(button("Edit", eventRows()[row]), "onClick");
      await hooks.settle();
      expect(replacementDraft()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(count);
      expect(eventRows().map((node) => button("Edit", node).props.disabled)).toEqual([true, true]);
    },
  );

  it("keeps the first opened editor when a second retained row Edit runs before paint", async () => {
    const { first, fetcher } = replacementWorkspace();
    await mount();
    const firstEdit = button("Edit", eventRows()[0]);
    const secondEdit = button("Edit", eventRows()[1]);
    const count = fetcher.mock.calls.length;
    invoke(firstEdit, "onClick");
    invoke(secondEdit, "onClick");
    await hooks.settle();
    expect(eventField("Exact value").props.value).toBe(first.value);
    expect(eventField("Local time").props.value).toBe("12:34");
    expect(fetcher.mock.calls).toHaveLength(count);
  });

  it("retires an editor-era callback across raw changes and Cancel while fresh Edit resumes", async () => {
    const { second, fetcher } = replacementWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    const stale = button("Edit", eventRows()[1]);
    await changeEvent("Exact value", "71.200000");
    await click("Cancel", eventForm());
    const before = replacementDraft();
    const count = fetcher.mock.calls.length;
    invoke(stale, "onClick");
    await hooks.settle();
    expect(text(eventForm())).toContain("Log event");
    expect(replacementDraft()).toEqual(before);
    expect(fetcher.mock.calls).toHaveLength(count);
    await click("Edit", eventRows()[1]);
    expect(eventField("Exact value").props.value).toBe(second.value);
    expect(eventField("Local time").props.value).toBe("11:22");
  });

  it("restores current Edit after accepted Save and preserves unchanged seconds and milliseconds", async () => {
    const { state, first, second, writes } = replacementWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    state.write = () =>
      Response.json({
        data: { event: { ...first, revision: "2", value: "71.200000" }, replayed: false },
      });
    await saveReading();
    const saved = requiredHistory(writes()[0]);
    expect(saved[0]).toBe(`/api/retention/biometrics/events/${first.id}`);
    expect(saved[1]?.method).toBe("PATCH");
    expect(saved[1]?.body).toBe(JSON.stringify({ value: "71.200000" }));
    expect(new Headers(saved[1]?.headers).get("if-match")).toBe('"1"');
    expect(text(eventForm())).toContain("Log event");
    expect(eventRows().map((node) => button("Edit", node).props.disabled)).toEqual([false, false]);
    await click("Edit", eventRows()[1]);
    expect(eventField("Exact value").props.value).toBe(second.value);
    expect(writes()).toHaveLength(1);
  });

  it("retains the original ambiguous PATCH body and key after a blocked replacement", async () => {
    const { state, first, writes } = replacementWorkspace();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    state.write = () => Response.json({ error: "Unknown outcome" }, { status: 503 });
    await saveReading();
    const original = requiredHistory(writes()[0]);
    const before = replacementDraft();
    invoke(button("Edit", eventRows()[1]), "onClick");
    await hooks.settle();
    expect(replacementDraft()).toEqual(before);
    await saveReading();
    const retry = requiredHistory(writes()[1]);
    expect(writes()).toHaveLength(2);
    expect(retry[0]).toBe(`/api/retention/biometrics/events/${first.id}`);
    expect(retry[1]?.body).toBe(original[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
      new Headers(original[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(retry[1]?.headers).get("if-match")).toBe('"1"');
  });

  it.each(["read", "write"])(
    "preserves existing admission fences during a pending %s",
    async (phase) => {
      const { state, first, second, fetcher, writes } = replacementWorkspace();
      await mount();
      await click("Edit", eventRows()[0]);
      await changeEvent("Exact value", "71.200000");
      const oldEdit = button("Edit", eventRows()[1]);
      const pending = deferred<Response>();
      if (phase === "read") {
        state.eventRead = () => pending.promise;
        invoke(button("Reload history"), "onClick");
      } else {
        state.write = () => pending.promise;
        invoke(eventForm(), "onSubmit", { preventDefault() {} });
      }
      const before = replacementDraft();
      const count = fetcher.mock.calls.length;
      invoke(oldEdit, "onClick");
      await hooks.settle();
      expect(replacementDraft()).toEqual(before);
      expect(fetcher.mock.calls).toHaveLength(count);
      pending.resolve(
        phase === "read"
          ? eventPage([first, second])
          : Response.json({ error: "Unknown outcome" }, { status: 503 }),
      );
      await hooks.settle();
      expect(replacementDraft()).toEqual(before);
      expect(writes()).toHaveLength(phase === "read" ? 0 : 1);
    },
  );

  it("keeps the later repeated-minute instant and exact value-only retry while Edit is blocked", async () => {
    const { state, writes } = historyWorkspace("2026-11-01T12:00:00.000Z");
    state.timeZone = "America/Chicago";
    const first = {
      ...reading(1, "2026-11-01T07:34:56.789Z"),
      localDate: "2026-11-01",
      timeZone: "America/Chicago",
    };
    const second = {
      ...reading(2, "2026-11-01T08:22:33.456Z"),
      localDate: "2026-11-01",
      timeZone: "America/Chicago",
    };
    state.eventRead = () => eventPage([first, second]);
    const rows = () =>
      elements(biometricSection()).filter(
        (node) =>
          node.type === "li" &&
          elements(node).some(
            (child) => child.type === "small" && text(child).includes(" · America/Chicago · "),
          ),
      );
    await mount();
    await click("Edit", rows()[0]);
    expect(eventField("Local time").props.value).toBe("01:34");
    await changeEvent("Exact value", "71.200000");
    state.write = () => Response.json({ error: "Unknown outcome" }, { status: 503 });
    await saveReading();
    const original = requiredHistory(writes()[0]);
    invoke(button("Edit", rows()[1]), "onClick");
    await hooks.settle();
    state.write = () =>
      Response.json({
        data: { event: { ...first, revision: "2", value: "71.200000" }, replayed: true },
      });
    await saveReading();
    const retry = requiredHistory(writes()[1]);
    expect(writes()).toHaveLength(2);
    expect(retry[0]).toBe(original[0]);
    expect(retry[1]?.body).toBe(JSON.stringify({ value: "71.200000" }));
    expect(retry[1]?.body).toBe(original[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
      new Headers(original[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(retry[1]?.headers).get("if-match")).toBe('"1"');
    expect(text(rows()[0])).toContain("01:34:56");
    expect(text(eventForm())).toContain("Log event");
    expect(button("Edit", rows()[1]).props.disabled).toBe(false);
  });
});

describe("Health accepted Delete editor retirement", () => {
  function deletionWorkspace() {
    const result = historyWorkspace();
    const first = reading(1);
    const second = reading(2, "2026-09-10T11:22:33.456Z");
    result.state.eventRead = () => eventPage([first, second]);
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    return { ...result, first, second };
  }
  const deleted = (replayed = false) => Response.json({ data: { event: null, replayed } });
  function draftValues() {
    return ["Exact value", "Local date", "Local time"].map(
      (label) => eventField(label).props.value,
    );
  }
  async function rawCorrection() {
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    await changeEvent("Local date", "2026-09-09");
    await changeEvent("Local time", "00:45");
  }

  it("retires the same reading correction after ordinary confirmed Delete succeeds", async () => {
    const { state, first, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    state.write = () => deleted();
    const remove = button("Delete", eventRows()[0]);
    expect(remove.props.disabled).toBe(false);
    await click("Delete", eventRows()[0]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[0]).toBe(`/api/retention/biometrics/events/${first.id}`);
    expect(writes()[0]?.[1]?.method).toBe("DELETE");
    expect(eventRows()).toHaveLength(1);
    expect(status()).toContain("Manual biometric event deleted.");
    expect(text(eventForm())).toContain("Log event");
    expect(text(eventForm())).not.toContain("Save event");
    expect(eventField("Exact value").props.value).toBe("");
  });

  it("retires the pre-delete Save callback instead of PATCHing the deleted identity", async () => {
    const { state, first, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const oldForm = eventForm();
    state.write = (_url, init) =>
      init.method === "DELETE"
        ? deleted()
        : Response.json({ data: { event: first, replayed: false } });
    await click("Delete", eventRows()[0]);
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes()).toHaveLength(1);
    expect(eventRows()).toHaveLength(1);
  });

  it("preserves all raw fields while deleting another reading", async () => {
    const { state, second, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    await changeEvent("Exact value", " invalid raw decimal ");
    const before = draftValues();
    state.write = () => deleted();
    await click("Delete", eventRows()[1]);
    expect(writes()[0]?.[0]).toBe(`/api/retention/biometrics/events/${second.id}`);
    expect(draftValues()).toEqual(before);
    expect(text(eventForm())).toContain("Save event");
    expect(eventRows()).toHaveLength(1);
  });

  it("retains the correction when the ordinary confirmation is cancelled", async () => {
    const { writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const before = draftValues();
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    await click("Delete", eventRows()[0]);
    expect(writes()).toHaveLength(0);
    expect(draftValues()).toEqual(before);
    expect(eventRows()).toHaveLength(2);
  });

  it.each([400, 412])("retains the correction after rejected Delete %s", async (statusCode) => {
    const { state, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const before = draftValues();
    state.write = () => Response.json({ error: "Not deleted." }, { status: statusCode });
    await click("Delete", eventRows()[0]);
    expect(writes()).toHaveLength(1);
    expect(draftValues()).toEqual(before);
    expect(text(eventForm())).toContain("Save event");
    expect(eventRows()).toHaveLength(2);
  });

  it("retains uncertain Delete bytes and key, then retires its unchanged editor after exact replay", async () => {
    const { state, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const before = draftValues();
    state.write = () => Response.json({ error: "Unknown outcome." }, { status: 503 });
    await click("Delete", eventRows()[0]);
    expect(draftValues()).toEqual(before);
    expect(eventRows()).toHaveLength(2);
    state.write = () => deleted(true);
    await click("Delete", eventRows()[0]);
    expect(writes()).toHaveLength(2);
    const original = requiredHistory(writes()[0]);
    const replay = requiredHistory(writes()[1]);
    expect(replay[0]).toBe(original[0]);
    expect(replay[1]?.method).toBe("DELETE");
    expect(replay[1]?.body).toBe(original[1]?.body);
    expect(replay[1]?.headers).toEqual(original[1]?.headers);
    expect(new Headers(replay[1]?.headers).get("if-match")).toBe('"1"');
    expect(text(eventForm())).toContain("Log event");
    expect(eventField("Exact value").props.value).toBe("");
    expect(eventRows()).toHaveLength(1);
  });

  it("retires the same reading after raw fields change during pending Delete", async () => {
    const { state, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await click("Delete", eventRows()[0]);
    await changeEvent("Exact value", " newer invalid correction ");
    await changeEvent("Local date", "2026-09-08");
    await changeEvent("Local time", "02:34");
    const pendingForm = eventForm();
    pending.resolve(deleted());
    await hooks.settle();
    expect(text(eventForm())).toContain("Log event");
    expect(eventField("Exact value").props.value).toBe("");
    expect(eventRows()).toHaveLength(1);
    invoke(pendingForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes()).toHaveLength(1);
  });

  it("preserves a newer independent Log draft after Cancel during pending same-reading Delete", async () => {
    const { state, writes } = deletionWorkspace();
    await mount();
    await rawCorrection();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await click("Delete", eventRows()[0]);
    await click("Cancel", eventForm());
    await changeEvent("Exact value", " new invalid value ");
    await changeEvent("Local date", "2026-09-08");
    await changeEvent("Local time", "02:34");
    const before = draftValues();
    pending.resolve(deleted());
    await hooks.settle();
    expect(draftValues()).toEqual(before);
    expect(text(eventForm())).toContain("Log event");
    expect(writes()).toHaveLength(1);
    expect(eventRows()).toHaveLength(1);
  });

  it("preserves a new Log draft when Delete started with no correction open", async () => {
    const { state, writes } = deletionWorkspace();
    await mount();
    await changeEvent("Exact value", " untouched Log draft ");
    const before = draftValues();
    state.write = () => deleted();
    await click("Delete", eventRows()[0]);
    expect(draftValues()).toEqual(before);
    expect(text(eventForm())).toContain("Log event");
    expect(writes()).toHaveLength(1);
  });
});

describe("Health pending definition editor", () => {
  const secondDefinition: BiometricDefinition = {
    ...historyDefinition,
    id: "4bcfa2bf-4950-43f7-9f24-000000000002",
    name: "Height",
    dimension: "length",
    canonicalUnit: "cm",
  };
  function definitionForm() {
    const form = elements().find(
      (node) => node.type === "form" && text(node).includes("metric definition"),
    );
    if (!form) throw new Error("Missing definition form");
    return form;
  }
  function definitionField(label: string) {
    const parent = elements(definitionForm()).find(
      (node) => node.type === "label" && text(node).startsWith(label),
    );
    const node = elements(parent ?? null).find((item) =>
      ["input", "select"].includes(String(item.type)),
    );
    if (!node) throw new Error(`Missing definition field ${label}`);
    return node;
  }
  function revise(index: number) {
    const node = elements().filter(
      (item) => item.type === "button" && text(item) === "Revise name",
    )[index];
    if (!node) throw new Error("Missing definition revision control");
    return node;
  }
  function definitionDraft() {
    return ["Name", "Dimension", "Canonical unit"].map(
      (label) => definitionField(label).props.value,
    );
  }
  async function setup(revision = false) {
    const result = workspace();
    result.state.definitions = [historyDefinition, secondDefinition];
    await mount();
    if (revision) {
      invoke(revise(0), "onClick");
      await hooks.settle();
    }
    invoke(definitionField("Name"), "onChange", { target: { value: "  Raw metric  " } });
    if (!revision) {
      invoke(definitionField("Dimension"), "onChange", { target: { value: "count" } });
      invoke(definitionField("Canonical unit"), "onChange", { target: { value: "  reps  " } });
    }
    await hooks.settle();
    return result;
  }
  function saved(revision = false) {
    return Response.json({
      data: {
        replayed: false,
        definition: {
          ...historyDefinition,
          id: revision ? historyDefinition.id : "4bcfa2bf-4950-43f7-9f24-000000000003",
          revision: revision ? "2" : "1",
          name: "Raw metric",
          dimension: revision ? "mass" : "count",
          canonicalUnit: revision ? "kg" : "reps",
        },
      },
    });
  }
  function submit(form = definitionForm()) {
    invoke(form, "onSubmit", { preventDefault: () => undefined });
  }
  function requestIdentity(
    call: ReturnType<ReturnType<typeof workspace>["writes"]>[number] | undefined,
  ) {
    if (!call) throw new Error("Missing definition write");
    return {
      url: call[0],
      method: call[1]?.method,
      body: call[1]?.body,
      key: new Headers(call[1]?.headers).get("idempotency-key"),
      revision: new Headers(call[1]?.headers).get("if-match"),
    };
  }

  for (const revision of [false, true]) {
    const mode = revision ? "PATCH" : "POST";
    it(`${mode} freezes ordinary controls and preserves the submitted draft`, async () => {
      const { state, writes } = await setup(revision);
      const before = definitionDraft();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      submit();
      await hooks.settle();
      expect(definitionField("Name").props.disabled).toBe(true);
      expect(definitionField("Dimension").props.disabled).toBe(true);
      expect(definitionField("Canonical unit").props.disabled).toBe(true);
      expect(revise(1).props.disabled).toBe(true);
      if (revision) expect(button("Cancel", definitionForm()).props.disabled).toBe(true);
      expect(definitionDraft()).toEqual(before);
      expect(writes()).toHaveLength(1);
      pending.resolve(saved(revision));
      await hooks.settle();
      expect(definitionDraft()).toEqual(["Weight", "mass", "kg"]);
      expect(status()).toContain("Metric definition saved");
      expect(revise(1).props.disabled).not.toBe(true);
    });

    it(`${mode} blocks retained changes, replacement and duplicate Submit before repaint`, async () => {
      const { state, writes } = await setup(revision);
      const before = definitionDraft();
      const form = definitionForm();
      const fields = ["Name", "Dimension", "Canonical unit"].map(definitionField);
      const replacement = revise(1);
      const cancel = revision ? button("Cancel", form) : null;
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      submit(form);
      fields.forEach((node, index) => {
        invoke(node, "onChange", { target: { value: ["discarded", "other", "unit"][index] } });
      });
      if (cancel) invoke(cancel, "onClick");
      invoke(replacement, "onClick");
      submit(form);
      await hooks.settle();
      expect(definitionDraft()).toEqual(before);
      expect(writes()).toHaveLength(1);
      const first = requestIdentity(writes()[0]);
      expect(first.method).toBe(mode);
      expect(first.revision).toBe(revision ? '"1"' : null);
      expect(first.body).toBe(
        JSON.stringify(
          revision
            ? { name: "Raw metric", notes: null }
            : { name: "Raw metric", dimension: "count", canonicalUnit: "reps", notes: null },
        ),
      );
      pending.resolve(saved(revision));
      await hooks.settle();
    });

    for (const code of [400, 412, 503]) {
      it(`${mode} ${code} reopens exact raw fields and retries the exact operation`, async () => {
        const { state, writes } = await setup(revision);
        const before = definitionDraft();
        state.write = () => Response.json({ error: "Definition failed" }, { status: code });
        submit();
        await hooks.settle();
        expect(definitionDraft()).toEqual(before);
        expect(definitionField("Name").props.disabled).not.toBe(true);
        const original = requestIdentity(writes()[0]);
        submit();
        await hooks.settle();
        expect(requestIdentity(writes()[1])).toEqual(original);
        invoke(definitionField("Name"), "onChange", { target: { value: "  Reopened  " } });
        await hooks.settle();
        expect(definitionField("Name").props.value).toBe("  Reopened  ");
        if (revision) {
          await click("Cancel", definitionForm());
          expect(definitionDraft()).toEqual(["Weight", "mass", "kg"]);
        }
        invoke(revise(1), "onClick");
        await hooks.settle();
        expect(definitionDraft()).toEqual(["Height", "length", "cm"]);
      });
    }
  }

  it("merges ordinary same-render field changes and submits the latest complete draft", async () => {
    const { state, writes } = await setup();
    const form = definitionForm();
    const name = definitionField("Name");
    invoke(name, "onChange", { target: { value: "2" } });
    invoke(name, "onChange", { target: { value: "23" } });
    invoke(definitionField("Dimension"), "onChange", { target: { value: "duration" } });
    invoke(definitionField("Canonical unit"), "onChange", { target: { value: " min " } });
    state.write = () => Response.json({ error: "Held draft" }, { status: 400 });
    submit(form);
    await hooks.settle();
    expect(definitionDraft()).toEqual(["23", "duration", " min "]);
    expect(requestIdentity(writes()[0]).body).toBe(
      JSON.stringify({ name: "23", dimension: "duration", canonicalUnit: "min", notes: null }),
    );
  });

  it("rejects old editor callbacks after Cancel and replacement without blocking fresh revision", async () => {
    const { state, writes } = await setup(true);
    const form = definitionForm();
    const name = definitionField("Name");
    const replacement = revise(1);
    await click("Cancel", form);
    invoke(revise(1), "onClick");
    await hooks.settle();
    const before = definitionDraft();
    invoke(name, "onChange", { target: { value: "stale" } });
    invoke(replacement, "onClick");
    submit(form);
    await hooks.settle();
    expect(definitionDraft()).toEqual(before);
    expect(writes()).toHaveLength(0);
    state.write = () => Response.json({ error: "Current revision" }, { status: 400 });
    submit();
    await hooks.settle();
    expect(requestIdentity(writes()[0]).url).toContain(secondDefinition.id);
  });

  it("keeps canonical dimension and unit immutable for retained revision handlers", async () => {
    const { state, writes } = await setup(true);
    invoke(definitionField("Dimension"), "onChange", { target: { value: "other" } });
    invoke(definitionField("Canonical unit"), "onChange", { target: { value: "changed" } });
    await hooks.settle();
    expect(definitionDraft()).toEqual(["  Raw metric  ", "mass", "kg"]);
    state.write = () => Response.json({ error: "Current revision" }, { status: 400 });
    submit();
    await hooks.settle();
    expect(requestIdentity(writes()[0]).body).toBe(
      JSON.stringify({ name: "Raw metric", notes: null }),
    );
  });

  it("retires successful Submit and input callbacks before a fresh editor is opened", async () => {
    const { state, writes } = await setup();
    const form = definitionForm();
    const name = definitionField("Name");
    state.write = () => saved();
    submit(form);
    await hooks.settle();
    invoke(name, "onChange", { target: { value: "stale success" } });
    submit(form);
    await hooks.settle();
    expect(definitionDraft()).toEqual(["Weight", "mass", "kg"]);
    expect(writes()).toHaveLength(1);
  });

  it("preserves raw draft and uncertain identity after a malformed successful response", async () => {
    const { state, writes } = await setup();
    const before = definitionDraft();
    state.write = () => Response.json({ data: {} });
    submit();
    await hooks.settle();
    expect(definitionDraft()).toEqual(before);
    expect(status()).not.toContain("Metric definition saved");
    const original = requestIdentity(writes()[0]);
    state.write = () => saved();
    submit();
    await hooks.settle();
    expect(requestIdentity(writes()[1])).toEqual(original);
    expect(status()).toContain("Metric definition saved");
  });

  for (const code of [200, 401]) {
    it(`ignores late ${code} after unmount without private navigation or state writes`, async () => {
      const { state, writes } = await setup();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      const form = definitionForm();
      const name = definitionField("Name");
      submit(form);
      await hooks.settle();
      hooks.unmount();
      const closed = hooks.afterClose();
      invoke(name, "onChange", { target: { value: "closed" } });
      submit(form);
      pending.resolve(code === 200 ? saved() : new Response(null, { status: code }));
      await hooks.settle();
      expect(hooks.afterClose()).toBe(closed);
      expect(router.replace).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(1);
    });
  }

  it("retires pending publication and old controls across hide and return", async () => {
    const view = visibility();
    const { state, writes } = await setup();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    const form = definitionForm();
    const name = definitionField("Name");
    const before = definitionDraft();
    submit(form);
    await hooks.settle();
    await view.set("hidden");
    await view.set("visible");
    invoke(name, "onChange", { target: { value: "retired" } });
    submit(form);
    pending.resolve(saved());
    await hooks.settle();
    expect(definitionDraft()).toEqual(before);
    expect(status()).not.toContain("Metric definition saved");
    expect(writes()).toHaveLength(1);
    expect(definitionField("Name").props.disabled).not.toBe(true);
  });

  it("closes a current unauthorized request without publishing its error afterward", async () => {
    const { state } = await setup();
    state.write = () => new Response(null, { status: 401 });
    submit();
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(text()).not.toContain("Metric could not be created");
  });
  for (const replacement of ["profile", "owner"]) {
    it(`retires a pending response and controls after ${replacement} changes`, async () => {
      const { state, writes } = await setup();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      const form = definitionForm();
      const name = definitionField("Name");
      submit(form);
      await hooks.settle();
      state.auth = () =>
        replacement === "owner" ? session(otherOwner) : session(owner, "Asia/Tokyo");
      hooks.replayEffects();
      await hooks.settle();
      const before = text();
      const navigation = router.replace.mock.calls.length;
      invoke(name, "onChange", { target: { value: "obsolete profile" } });
      submit(form);
      pending.resolve(new Response(null, { status: 401 }));
      await hooks.settle();
      expect(text()).toBe(before);
      expect(router.replace.mock.calls).toHaveLength(navigation);
      expect(writes()).toHaveLength(1);
    });
  }

  it("checks ownership again after successful JSON parsing finishes late", async () => {
    const { state, writes } = await setup();
    const pending = deferred<unknown>();
    const response = saved();
    const body = await response.clone().json();
    const readJson = vi.fn(() => pending.promise);
    Object.defineProperty(response, "json", { value: readJson });
    state.write = () => response;
    submit();
    await hooks.settle();
    expect(readJson).toHaveBeenCalledOnce();
    hooks.unmount();
    const closed = hooks.afterClose();
    pending.resolve(body);
    await hooks.settle();
    expect(hooks.afterClose()).toBe(closed);
    expect(writes()).toHaveLength(1);
  });

  it("ignores completion after normal Sign out has closed the private workspace", async () => {
    const { state, writes } = await setup(true);
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    const form = definitionForm();
    const name = definitionField("Name");
    submit(form);
    await hooks.settle();
    await click("Sign out");
    const before = text();
    const navigation = router.replace.mock.calls.length;
    invoke(name, "onChange", { target: { value: "closed" } });
    submit(form);
    pending.resolve(saved(true));
    await hooks.settle();
    expect(text()).toBe(before);
    expect(router.replace.mock.calls).toHaveLength(navigation);
    expect(writes().filter(([url]) => url.includes("biometrics/definitions"))).toHaveLength(1);
  });

  it("preserves raw fields and the exact retry after a transport failure", async () => {
    const { state, writes } = await setup(true);
    const before = definitionDraft();
    state.write = () => {
      throw new Error("Synthetic transport failure");
    };
    submit();
    await hooks.settle();
    expect(definitionDraft()).toEqual(before);
    expect(definitionField("Name").props.disabled).not.toBe(true);
    const original = requestIdentity(writes()[0]);
    state.write = () => saved(true);
    submit();
    await hooks.settle();
    expect(requestIdentity(writes()[1])).toEqual(original);
    expect(status()).toContain("Metric definition saved");
  });
});

describe("Health deleted reminder editor", () => {
  function setup() {
    const result = reminderWorkspace();
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    return result;
  }
  function deleted(index = 1, replayed = false) {
    return Response.json({
      data: {
        reminder: { ...savedReminder(index, [1, 3, 5], "revoked"), revision: "4" },
        replayed,
      },
    });
  }
  function draft() {
    return {
      label: reminderField("Private in-app label").props.value,
      time: reminderField("Local time").props.value,
      days: selectedReminderDays(),
      editing: text(reminderForm()).includes("Save reminder"),
    };
  }
  async function raw(index = 1) {
    await click("Edit", reminderCard(`Saved reminder ${index}`));
    await changeReminderInput("Private in-app label", " Raw correction ");
    await changeReminderInput("Local time", "07:08");
    await click("Weekends");
  }

  it("retires the accepted same-reminder editor and its retained controls before ordinary new Create", async () => {
    const { state, writes } = setup();
    await mount();
    await raw();
    const form = reminderForm(),
      input = reminderField("Private in-app label");
    state.write = () => deleted();
    await click("Delete", reminderCard("Saved reminder 1"));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[0]).toBe(`/api/retention/reminders/${savedReminder().id}`);
    expect(writes()[0]?.[1]?.method).toBe("DELETE");
    expect(writes()[0]?.[1]?.body).toBeUndefined();
    expect(new Headers(writes()[0]?.[1]?.headers).get("if-match")).toBe('"3"');
    expect(text(reminderCard("Saved reminder 1"))).toContain("revoked");
    expect(draft()).toEqual({ label: "", time: "20:00", days: reminderDayNames, editing: false });
    invoke(input, "onChange", { target: { value: "retired" } });
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes()).toHaveLength(1);
    expect(draft().label).toBe("");
    await changeReminderInput("Private in-app label", "New reminder");
    state.write = () =>
      Response.json({
        data: { reminder: { ...savedReminder(4), label: "New reminder" }, replayed: false },
      });
    await saveReminderForm();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.[0]).toBe("/api/retention/reminders");
    expect(writes()[1]?.[1]?.method).toBe("POST");
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBeNull();
  });

  it("retires the same reminder even after raw fields change during pending Delete", async () => {
    const { state, writes } = setup();
    await mount();
    await raw();
    const pending = deferred<Response>();
    state.write = () => pending.promise;
    await click("Delete", reminderCard("Saved reminder 1"));
    await changeReminderInput("Private in-app label", " newer raw correction ");
    await changeReminderInput("Local time", "");
    await click("Every day");
    const form = reminderForm();
    pending.resolve(deleted());
    await hooks.settle();
    expect(draft()).toEqual({ label: "", time: "20:00", days: reminderDayNames, editing: false });
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes()).toHaveLength(1);
  });

  it("disables Edit for a revoked reminder returned by the list", async () => {
    setup();
    await mount();
    expect(button("Edit", reminderCard("Saved reminder 3")).props.disabled).toBe(true);
  });

  it("rejects a retained revoked-row Edit callback without replacing a raw draft", async () => {
    const { writes } = setup();
    await mount();
    await raw(2);
    const before = draft();
    invoke(button("Edit", reminderCard("Saved reminder 3")), "onClick");
    await hooks.settle();
    expect(draft()).toEqual(before);
    expect(writes()).toHaveLength(0);
  });

  it("keeps an old active-row Edit callback rejected after the row is replaced by a revoked receipt", async () => {
    const { state, writes } = setup();
    await mount();
    const retained = button("Edit", reminderCard("Saved reminder 1"));
    state.write = () => deleted();
    await click("Delete", reminderCard("Saved reminder 1"));
    const before = draft();
    invoke(retained, "onClick");
    await hooks.settle();
    expect(draft()).toEqual(before);
    expect(writes()).toHaveLength(1);
  });

  it("preserves an unrelated raw editor when another reminder is deleted", async () => {
    const { state, writes } = setup();
    await mount();
    await raw(2);
    const before = draft();
    state.write = () => deleted();
    await click("Delete", reminderCard("Saved reminder 1"));
    expect(draft()).toEqual(before);
    expect(writes()).toHaveLength(1);
  });

  it.each(["new", "other"])(
    "preserves the independent%s draft installed while same-reminder Delete is pending",
    async (next) => {
      const { state, writes } = setup();
      await mount();
      await raw();
      const pending = deferred<Response>();
      state.write = () => pending.promise;
      await click("Delete", reminderCard("Saved reminder 1"));
      await click("Cancel edit", reminderForm());
      if (next === "other") await click("Edit", reminderCard("Saved reminder 2"));
      await changeReminderInput("Private in-app label", " independent raw label ");
      await changeReminderInput("Local time", "09:10");
      await click("Weekdays");
      const before = draft();
      pending.resolve(deleted());
      await hooks.settle();
      expect(draft()).toEqual(before);
      expect(writes()).toHaveLength(1);
    },
  );

  it.each(["rejected", "malformed", "transport"])(
    "preserves raw fields and exact Delete identity after%s failure until accepted retry",
    async (failure) => {
      const { state, writes } = setup();
      await mount();
      await raw();
      const before = draft();
      state.write = () => {
        if (failure === "transport") throw new Error("Synthetic lost response");
        return failure === "rejected"
          ? Response.json({ error: "Synthetic rejection" }, { status: 400 })
          : Response.json({ data: { reminder: { id: savedReminder().id }, replayed: false } });
      };
      await click("Delete", reminderCard("Saved reminder 1"));
      expect(draft()).toEqual(before);
      expect(text(reminderCard("Saved reminder 1"))).toContain("active");
      const first = requiredHistory(writes()[0]);
      state.write = () => deleted(1, true);
      await click("Delete", reminderCard("Saved reminder 1"));
      const second = requiredHistory(writes()[1]);
      expect(second[0]).toBe(first[0]);
      expect(second[1]).toEqual(first[1]);
      expect(writes()).toHaveLength(2);
      expect(draft().editing).toBe(false);
      expect(draft().label).toBe("");
    },
  );

  it("preserves the editor and sends nothing when normal Delete confirmation is declined", async () => {
    const { writes } = setup();
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    await mount();
    await raw();
    const before = draft();
    await click("Delete", reminderCard("Saved reminder 1"));
    expect(draft()).toEqual(before);
    expect(writes()).toHaveLength(0);
  });

  it("leaves existing Pause behavior and its open editor unchanged", async () => {
    const { state, writes } = setup();
    await mount();
    await raw();
    const before = draft();
    state.write = () =>
      Response.json({
        data: {
          reminder: { ...savedReminder(1, [1, 3, 5], "paused"), revision: "4" },
          replayed: false,
        },
      });
    await click("Pause", reminderCard("Saved reminder 1"));
    expect(draft()).toEqual(before);
    expect(writes()[0]?.[1]?.method).toBe("PATCH");
  });
});

describe("Health archived metric new Log admission", () => {
  const other = { ...emptyHistoryDefinition, name: "Second active metric" };
  const archived = { ...historyDefinition, status: "archived" as const, revision: "2" };
  function setup() {
    const result = historyWorkspace();
    result.state.definitions = [historyDefinition, other];
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    result.state.write = (_url, init) =>
      init.method === "DELETE"
        ? Response.json({ data: { definition: archived } })
        : Response.json({ data: { event: reading(), replayed: false } });
    return result;
  }
  function metric() {
    return requiredHistory(elements(eventForm()).find((node) => node.type === "select"));
  }
  function archiveButton() {
    const row = requiredHistory(
      elements(biometricSection()).find(
        (node) => node.type === "li" && text(node).startsWith("Weight (kg)"),
      ),
    );
    return button("Archive", row);
  }
  function draft() {
    return [
      metric().props.value,
      ...["Exact value", "Local date", "Local time"].map((label) => eventField(label).props.value),
    ];
  }
  async function raw(value = "71.200000") {
    await changeEvent("Exact value", value);
    await changeEvent("Local date", "2026-09-09");
    await changeEvent("Local time", "07:23");
  }
  async function archive() {
    invoke(archiveButton(), "onClick");
    await hooks.settle();
  }

  it("blocks actual new POST after ordinary Archive and keeps its original metric and raw fields", async () => {
    const { writes } = setup();
    await mount();
    await raw();
    const before = draft();
    await archive();
    expect(status()).toContain("Metric archived");
    await saveReading();
    expect(writes().map(([, init]) => init?.method)).toEqual(["DELETE"]);
    expect(draft()).toEqual(before);
    expect(button("Log event").props.disabled).toBe(true);
  });

  it("represents the archived selection explicitly without reassigning an invalid raw draft", async () => {
    setup();
    await mount();
    await raw(" 003x ");
    const before = draft();
    await archive();
    expect(draft()).toEqual(before);
    const option = elements(metric()).find(
      (node) => node.type === "option" && node.props.value === historyDefinition.id,
    );
    expect(option).toBeDefined();
    expect(text(option)).toContain("archived");
    expect(text(eventForm())).toContain("Choose an active metric");
    expect(button("Log event").props.disabled).toBe(true);
  });

  it("rejects the pre-Archive submit callback after acceptance before React paints", async () => {
    const { state, writes } = setup();
    await mount();
    await raw();
    const before = draft(),
      form = eventForm(),
      pending = deferred<Response>();
    state.write = (_url, init) =>
      init.method === "DELETE"
        ? pending.promise
        : Response.json({ data: { event: reading(), replayed: false } });
    invoke(archiveButton(), "onClick");
    pending.resolve(Response.json({ data: { definition: archived } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes().map(([, init]) => init?.method)).toEqual(["DELETE"]);
    expect(draft()).toEqual(before);
  });

  it("keeps archived trend selection available while blocking new Log", async () => {
    const { state, writes, fetcher } = setup();
    state.definitions = [other, archived];
    await mount();
    await raw();
    const label = requiredHistory(
      elements().find((node) => node.type === "label" && text(node).startsWith("BiometricNone")),
    );
    const select = requiredHistory(elements(label).find((node) => node.type === "select"));
    invoke(select, "onChange", { target: { value: archived.id } });
    await hooks.settle();
    await saveReading();
    expect(writes()).toHaveLength(0);
    expect(metric().props.value).toBe(archived.id);
    expect(
      fetcher.mock.calls.some(
        ([url]) => url.startsWith("/api/retention/trends/biometrics?") && url.includes(archived.id),
      ),
    ).toBe(true);
  });

  it("logs retained exact values only after deliberately choosing an active metric", async () => {
    const { state, writes } = setup();
    await mount();
    await raw();
    await archive();
    invoke(metric(), "onChange", { target: { value: other.id } });
    await hooks.settle();
    state.write = () =>
      Response.json({
        data: {
          event: {
            ...reading(),
            definitionId: other.id,
            value: "71.200000",
            measuredAt: "2026-09-09T07:23:00.000Z",
            localDate: "2026-09-09",
          },
          replayed: false,
        },
      });
    expect(button("Log event").props.disabled).toBe(false);
    await saveReading();
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1]?.[1]?.body))).toEqual({
      definitionId: other.id,
      value: "71.200000",
      measuredAt: "2026-09-09T07:23:00.000Z",
    });
    expect(new Headers(writes()[1]?.[1]?.headers).get("if-match")).toBeNull();
  });

  it("preserves an unrelated active selection and its enabled raw draft", async () => {
    const { writes } = setup();
    await mount();
    invoke(metric(), "onChange", { target: { value: other.id } });
    await hooks.settle();
    await raw("00x");
    const before = draft();
    await archive();
    expect(draft()).toEqual(before);
    expect(button("Log event").props.disabled).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("leaves a canceled Archive and the new reading unchanged", async () => {
    const { writes } = setup();
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    await mount();
    await raw();
    const before = draft();
    await archive();
    expect(writes()).toHaveLength(0);
    expect(draft()).toEqual(before);
    expect(button("Log event").props.disabled).toBe(false);
  });

  it.each(["rejected", "malformed", "transport"])(
    "preserves the new draft after %s Archive and exact archive retry identity",
    async (failure) => {
      const { state, writes } = setup();
      await mount();
      await raw();
      const before = draft();
      state.write = () => {
        if (failure === "transport") throw new Error("Lost archive receipt");
        return failure === "rejected"
          ? Response.json({ error: "No archive" }, { status: 400 })
          : Response.json({ data: { id: historyDefinition.id } });
      };
      await archive();
      expect(draft()).toEqual(before);
      expect(button("Log event").props.disabled).toBe(false);
      const first = requiredHistory(writes()[0]);
      await archive();
      const retry = requiredHistory(writes()[1]);
      expect(retry[0]).toBe(first[0]);
      expect(retry[1]?.body).toBe(first[1]?.body);
      expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
        new Headers(first[1]?.headers).get("idempotency-key"),
      );
      expect(new Headers(retry[1]?.headers).get("if-match")).toBe('"1"');
    },
  );

  it("keeps an archived historical correction and exact uncertain PATCH retry available", async () => {
    const { state, writes } = setup();
    await mount();
    await click("Edit", eventRows()[0]);
    await changeEvent("Exact value", "71.200000");
    await archive();
    expect(button("Save event").props.disabled).toBe(false);
    state.write = () => Response.json({ error: "Unknown outcome" }, { status: 503 });
    await saveReading();
    const first = requiredHistory(writes()[1]);
    state.write = () =>
      Response.json({
        data: { event: { ...reading(), revision: "2", value: "71.200000" }, replayed: true },
      });
    await saveReading();
    const retry = requiredHistory(writes()[2]);
    expect(retry[0]).toBe(`/api/retention/biometrics/events/${reading().id}`);
    expect(retry[1]?.method).toBe("PATCH");
    expect(retry[1]?.body).toBe(JSON.stringify({ value: "71.200000" }));
    expect(retry[1]?.body).toBe(first[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first[1]?.headers).get("idempotency-key"),
    );
    expect(new Headers(retry[1]?.headers).get("if-match")).toBe('"1"');
    expect(text(eventRows()[0])).toContain("12:34:56");
    expect(button("Log event").props.disabled).toBe(true);
  });
});
