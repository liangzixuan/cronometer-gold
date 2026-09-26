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
    // Model ref attachment before passive effects; this is not a layout engine.
    const attachRefs = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) attachRefs(child);
        return;
      }
      if (!value || typeof value !== "object" || !("props" in value)) return;
      const props = (value as { props: Record<string, unknown> }).props;
      const ref = props.ref as { current: unknown } | undefined;
      if (ref && !ref.current) {
        const attributes = new Map<string, string>();
        if (typeof props["data-print-authorized"] === "string") {
          attributes.set("data-print-authorized", props["data-print-authorized"]);
        }
        ref.current = {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
          getAttribute: (name: string) => attributes.get(name) ?? null,
        };
      }
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

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { nutritionReportDates, parseNutritionReport } from "../../lib/nutrition-reports";
import {
  emptyNutritionReportFixture,
  zeroTargetNutritionReportFixture,
} from "../../test/nutrition-report-fixture";
import { ReportsClient } from "./ReportsClient";

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
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const anotherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
function session(id = owner, revision = "4", timeZone = "America/Chicago") {
  return Response.json({
    data: {
      user: {
        id,
        email: id === owner ? "owner@example.test" : "other@example.test",
        emailVerified: true,
      },
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
        revision,
      },
    },
  });
}
function reportResponse(url: string) {
  const query = new URL(url, "https://app.example.test").searchParams;
  return Response.json(
    emptyNutritionReportFixture(query.get("from") ?? "2026-09-01", query.get("to") ?? "2026-09-01"),
  );
}
let printEvents: EventTarget;
let nativePrint: ReturnType<typeof vi.fn>;
beforeEach(() => {
  printEvents = new EventTarget();
  nativePrint = vi.fn();
  vi.stubGlobal("window", {
    addEventListener: printEvents.addEventListener.bind(printEvents),
    removeEventListener: printEvents.removeEventListener.bind(printEvents),
    print: nativePrint,
  });
});

afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("actual reports component lifecycle", () => {
  it("loads a coherent report after StrictMode mount setup-cleanup-setup", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : reportResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    hooks.replayEffects();
    await hooks.settle();
    expect(text()).toContain("1 profile-local day loaded from one coherent snapshot.");
    expect(text()).toContain("Exact daily evidence");
    expect(button("Update report").props.disabled).toBe(false);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("ignores a late first-generation 401 after the active StrictMode session is ready", async () => {
    let firstSession: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      firstSession = resolve;
    });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          calls += 1;
          return calls === 1 ? delayed : session();
        }
        return reportResponse(url);
      }),
    );
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    hooks.replayEffects();
    await hooks.settle();
    firstSession?.(Response.json({ error: "Old session ended." }, { status: 401 }));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).toContain("1 profile-local day loaded from one coherent snapshot.");
    expect(text()).toContain("owner@example.test");
  });

  it("keeps genuine sign-out closed if effects are later replayed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        return url === "/api/auth/me" ? session() : reportResponse(url);
      }),
    );
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    await hooks.settle();
    expect(text()).toContain("Exact daily evidence");
    (button("Sign out").props.onClick as () => void)();
    await hooks.settle();
    hooks.replayEffects();
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(text()).toContain("Closing your private report…");
    expect(text()).not.toContain("owner@example.test");
    expect(text()).not.toContain("Exact daily evidence");
  });

  it("ignores stale profile revalidation JSON before it can close the new report generation", async () => {
    let rangeDate = "2026-09-01";
    let authCalls = 0;
    let finishOldProfile: ((body: unknown) => void) | undefined;
    const delayed = new Promise<unknown>((resolve) => {
      finishOldProfile = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          if (authCalls === 1) return session(owner, "3");
          if (authCalls === 2) {
            const response = session();
            response.json = () => delayed;
            return response;
          }
          return session();
        }
        return reportResponse(url);
      }),
    );
    hooks.mount(() => ReportsClient({ initialFrom: rangeDate, initialTo: rangeDate }));
    await hooks.settle();
    expect(authCalls).toBe(2);
    rangeDate = "2026-09-02";
    hooks.render();
    await hooks.settle();
    expect(text()).toContain("2026-09-02 through 2026-09-02");
    finishOldProfile?.(await session(anotherOwner).json());
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).toContain("2026-09-02 through 2026-09-02");
    expect(text()).toContain("owner@example.test");
  });
});

function printGate(): string | null {
  const node = elements().find((item) => "data-print-authorized" in item.props);
  const ref = node?.props.ref as { current: { getAttribute(name: string): string | null } };
  return ref.current.getAttribute("data-print-authorized");
}
function printedComponent(): ElementNode | undefined {
  return elements().find(
    (node) => typeof node.type === "function" && node.type.name === "PrintableNutritionReport",
  );
}
function inputDate(index: number, value: string) {
  const node = elements().filter((item) => item.type === "input" && item.props.type === "date")[
    index
  ];
  if (!node) throw new Error("Missing editable report field.");
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
}
function nutrient(value: string) {
  const node = elements().find((item) => item.type === "select");
  if (!node) throw new Error("Missing editable report field.");
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
}
function startPrint() {
  (button("Print current report").props.onClick as () => void)();
}
function readyFetcher() {
  const fetcher = vi.fn(async (url: string) =>
    url === "/api/auth/me" ? session() : reportResponse(url),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("actual current-report print lifecycle", () => {
  it("keeps direct browser printing neutral while loading, ready, and after report failure", async () => {
    const fetcher = readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    expect(button("Print current report").props.disabled).toBe(true);
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
    expect(printedComponent()).toBeUndefined();
    await hooks.settle();
    expect(button("Print current report").props.disabled).toBe(false);
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
    expect(printedComponent()).toBeUndefined();
    fetcher.mockImplementation(async (url: string) =>
      url === "/api/auth/me"
        ? session()
        : Response.json({ error: "Temporary report failure." }, { status: 503 }),
    );
    (button("7 days").props.onClick as () => void)();
    await hooks.settle();
    expect(button("Print current report").props.disabled).toBe(true);
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
    expect(printedComponent()).toBeUndefined();
    expect(nativePrint).not.toHaveBeenCalled();
  });

  it("prints only the loaded 31-day snapshot and selected nutrient after session-only verification", async () => {
    const fetcher = readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-08-02", initialTo: "2026-09-01" }));
    await hooks.settle();
    nutrient("15");
    await hooks.settle();
    const reportsBefore = fetcher.mock.calls.filter(([url]) =>
      url.startsWith("/api/reports/nutrition?"),
    ).length;
    expect(reportsBefore).toBe(1);
    nativePrint.mockImplementation(() => {
      expect(printGate()).toBe("false");
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("true");
      const printable = printedComponent();
      expect(printable?.props.nutrientId).toBe("15");
      expect(printable?.props.report).toEqual(
        emptyNutritionReportFixture("2026-08-02", "2026-09-01").data,
      );
      printEvents.dispatchEvent(new Event("afterprint"));
      expect(printGate()).toBe("false");
    });
    startPrint();
    await hooks.settle();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([url]) => url.startsWith("/api/reports/nutrition?")),
    ).toHaveLength(reportsBefore);
    expect(printedComponent()).toBeUndefined();
    expect(button("Print current report").props.disabled).toBe(false);
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
  });

  it.each(["date", "nutrient", "preset", "period", "diary", "logout", "unmount"] as const)(
    "revokes a pending verification immediately on %s and ignores its late JSON",
    async (change) => {
      let finishJson: ((value: unknown) => void) | undefined;
      const delayed = new Promise<unknown>((resolve) => {
        finishJson = resolve;
      });
      let authCalls = 0;
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        if (url !== "/api/auth/me") return reportResponse(url);
        authCalls += 1;
        const response = session();
        if (authCalls === 2) response.json = () => delayed;
        return response;
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
      await hooks.settle();
      const oldHandler = button("Print current report").props.onClick as () => void;
      startPrint();
      await hooks.settle();
      if (change === "date") inputDate(0, "2026-08-31");
      if (change === "nutrient") nutrient("2");
      if (change === "preset") (button("7 days").props.onClick as () => void)();
      if (change === "period") (button("Next period").props.onClick as () => void)();
      if (change === "diary") (button("Open diary for 2026-09-01").props.onClick as () => void)();
      if (change === "logout") (button("Sign out").props.onClick as () => void)();
      if (change === "unmount") hooks.unmount();
      // Even a retained handler before React rerenders cannot start another verification.
      oldHandler();
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("false");
      finishJson?.(await session(anotherOwner).json());
      await hooks.settle();
      expect(nativePrint).not.toHaveBeenCalled();
      expect(printedComponent()).toBeUndefined();
      expect(hooks.afterClose()).toBe(0);
      expect(router.replace.mock.calls.filter(([url]) => url === "/login")).toHaveLength(
        change === "logout" ? 1 : 0,
      );
    },
  );

  it.each(["owner", "revision", "zone", "expired"] as const)(
    "refuses printing when the verification detects a changed %s",
    async (mismatch) => {
      let authCalls = 0;
      const fetcher = vi.fn(async (url: string) => {
        if (url !== "/api/auth/me") return reportResponse(url);
        authCalls += 1;
        if (authCalls === 1) return session();
        if (mismatch === "owner") return session(anotherOwner);
        if (mismatch === "revision") return session(owner, "5");
        if (mismatch === "zone") return session(owner, "4", "America/New_York");
        return Response.json({ error: "Session expired." }, { status: 401 });
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
      await hooks.settle();
      const requestCount = fetcher.mock.calls.length;
      startPrint();
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(requestCount + 1);
      expect(nativePrint).not.toHaveBeenCalled();
      expect(printedComponent()).toBeUndefined();
      expect(text()).not.toContain("Exact daily evidence");
      expect(button("Print current report").props.disabled).toBe(true);
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("false");
    },
  );

  it("ignores late old verification 401 without closing a newer selected nutrient", async () => {
    let finishResponse: ((value: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      finishResponse = resolve;
    });
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url !== "/api/auth/me") return reportResponse(url);
        authCalls += 1;
        return authCalls === 2 ? delayed : session();
      }),
    );
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    await hooks.settle();
    startPrint();
    await hooks.settle();
    nutrient("2");
    await hooks.settle();
    finishResponse?.(Response.json({ error: "Old session ended." }, { status: 401 }));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).toContain("Exact daily evidence");
    expect(nativePrint).not.toHaveBeenCalled();
  });

  it.each(["ignored", "throws", "beforeprint-only"] as const)(
    "cleans up when the native print call is %s",
    async (behavior) => {
      readyFetcher();
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
      await hooks.settle();
      nativePrint.mockImplementation(() => {
        if (behavior === "throws") throw new Error("Native dialog unavailable.");
        if (behavior === "beforeprint-only") {
          printEvents.dispatchEvent(new Event("beforeprint"));
          expect(printGate()).toBe("true");
        }
      });
      startPrint();
      await hooks.settle();
      expect(nativePrint).toHaveBeenCalledTimes(1);
      expect(printedComponent()).toBeUndefined();
      expect(button("Print current report").props.disabled).toBe(false);
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("false");
      if (behavior === "throws") expect(text()).toContain("The print dialog could not open.");
    },
  );

  it("cannot rearm a captured print from a retained old-nutrient callback", async () => {
    const fetcher = readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    await hooks.settle();
    const oldHandler = button("Print current report").props.onClick as () => void;
    nutrient("2");
    await hooks.settle();
    const requestCount = fetcher.mock.calls.length;
    oldHandler();
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(requestCount);
    expect(nativePrint).not.toHaveBeenCalled();
  });
});

describe("print handoff boundaries", () => {
  it.each(["date", "nutrient", "logout"] as const)(
    "closes the synchronous DOM gate when %s changes before native beforeprint",
    async (change) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/auth/logout") return new Response(null, { status: 204 });
          return url === "/api/auth/me" ? session() : reportResponse(url);
        }),
      );
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
      await hooks.settle();
      nativePrint.mockImplementation(() => {
        expect(printedComponent()).toBeDefined();
        if (change === "date") inputDate(0, "2026-08-31");
        if (change === "nutrient") nutrient("2");
        if (change === "logout") (button("Sign out").props.onClick as () => void)();
        printEvents.dispatchEvent(new Event("beforeprint"));
        expect(printGate()).toBe("false");
      });
      startPrint();
      await hooks.settle();
      expect(nativePrint).toHaveBeenCalledTimes(1);
      expect(printedComponent()).toBeUndefined();
      expect(printGate()).toBe("false");
    },
  );

  it("keeps a failed session verification retryable without refetching the report", async () => {
    let authCalls = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url !== "/api/auth/me") return reportResponse(url);
      authCalls += 1;
      return authCalls === 2
        ? Response.json({ error: "Session verification unavailable." }, { status: 503 })
        : session();
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    await hooks.settle();
    startPrint();
    await hooks.settle();
    expect(nativePrint).not.toHaveBeenCalled();
    expect(text()).toContain("Session verification unavailable.");
    expect(text()).toContain("Exact daily evidence");
    expect(button("Print current report").props.disabled).toBe(false);
    startPrint();
    await hooks.settle();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url.startsWith("/api/reports/nutrition?")),
    ).toHaveLength(1);
  });

  it("cannot print the prior route range while the replacement session is being verified", async () => {
    let date = "2026-09-01";
    let finishSession: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      finishSession = resolve;
    });
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url !== "/api/auth/me") return reportResponse(url);
        authCalls += 1;
        return authCalls === 2 ? delayed : session();
      }),
    );
    hooks.mount(() => ReportsClient({ initialFrom: date, initialTo: date }));
    await hooks.settle();
    date = "2026-09-02";
    hooks.render();
    await hooks.settle();
    // An unrelated rerender must not reopen the old report while auth is pending.
    hooks.render();
    startPrint();
    await hooks.settle();
    expect(nativePrint).not.toHaveBeenCalled();
    expect(authCalls).toBe(2);
    finishSession?.(session());
    await hooks.settle();
    expect(text()).toContain("2026-09-02 through 2026-09-02");
    expect(button("Print current report").props.disabled).toBe(false);
  });
});

function invoke(node: ElementNode, action = "onClick", ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
function dateFields() {
  return elements().filter((node) => node.type === "input" && node.props.type === "date");
}
function currentDates() {
  return dateFields().map((node) => node.props.value);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node);
  await hooks.settle();
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing observed test value.");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function utcReportResponse(url: string) {
  const query = new URL(url, "https://app.example.test").searchParams;
  const from = query.get("from") ?? "2026-09-01";
  const to = query.get("to") ?? from;
  const fixture = emptyNutritionReportFixture(from, to);
  fixture.data.timeZone = "UTC";
  fixture.data.days = nutritionReportDates(from, to).map((localDate) => {
    const next = new Date(`${localDate}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      localDate,
      startsAt: `${localDate}T00:00:00.000Z`,
      endsAt: next.toISOString(),
      entryCount: 0,
      sourceDiaries: [],
      sourceTimeZones: [],
    };
  });
  return Response.json(fixture);
}

describe("actual adjacent report periods", () => {
  it.each([
    [1, "2026-09-01", "2026-09-02", "2026-09-02"],
    [7, "2026-09-07", "2026-09-08", "2026-09-14"],
    [14, "2026-09-14", "2026-09-15", "2026-09-28"],
    [30, "2026-09-30", "2026-10-01", "2026-10-30"],
    [31, "2026-10-01", "2026-10-02", "2026-11-01"],
  ] as const)(
    "moves a loaded %i-day interval and preserves selected nutrient",
    async (_days, to, nextFrom, nextTo) => {
      const fetcher = vi.fn(async (url: string) =>
        url === "/api/auth/me" ? session(owner, "4", "UTC") : utcReportResponse(url),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: to }));
      expect(button("Previous period").props.disabled).toBe(true);
      expect(button("Next period").props.disabled).toBe(true);
      await hooks.settle();
      nutrient("15");
      await hooks.settle();
      await click("Next period");
      expect(currentDates()).toEqual([nextFrom, nextTo]);
      expect(elements().find((node) => node.type === "select")?.props.value).toBe("15");
      expect(router.replace).toHaveBeenLastCalledWith(`/reports?from=${nextFrom}&to=${nextTo}`, {
        scroll: false,
      });
      await click("Previous period");
      expect(currentDates()).toEqual(["2026-09-01", to]);
      expect(elements().find((node) => node.type === "select")?.props.value).toBe("15");
      expect(
        fetcher.mock.calls.filter(([url]) => url.startsWith("/api/reports/nutrition?")),
      ).toHaveLength(3);
    },
  );

  it("performs one read for a moved target including its owned URL-prop echo, then verifies an unrelated external range", async () => {
    const fetcher = readyFetcher();
    let props = { initialFrom: "2026-09-01", initialTo: "2026-09-07" };
    hooks.mount(() => ReportsClient(props));
    await hooks.settle();
    await click("Next period");
    props = { initialFrom: "2026-09-08", initialTo: "2026-09-14" };
    hooks.render();
    await hooks.settle();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url.startsWith("/api/reports/nutrition?")),
    ).toHaveLength(2);
    props = { initialFrom: "2026-09-15", initialTo: "2026-09-21" };
    hooks.render();
    await hooks.settle();
    expect(currentDates()).toEqual(["2026-09-15", "2026-09-21"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([url]) => url.startsWith("/api/reports/nutrition?")),
    ).toHaveLength(3);
  });

  it("rejects prior-route and new controls during an external route render before its effects", async () => {
    const fetcher = readyFetcher();
    let props = { initialFrom: "2026-09-01", initialTo: "2026-09-07" };
    hooks.mount(() => ReportsClient(props));
    await hooks.settle();
    const oldNext = button("Next period");
    const oldFrom = required(dateFields()[0]);
    const requests = fetcher.mock.calls.length;
    props = { initialFrom: "2026-09-15", initialTo: "2026-09-21" };
    hooks.renderWithoutEffects();
    invoke(oldNext);
    invoke(oldFrom, "onChange", { target: { value: "2026-08-01" } });
    invoke(button("Next period"));
    expect(button("Next period").props.disabled).toBe(true);
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(router.replace).not.toHaveBeenCalled();
    hooks.render();
    await hooks.settle();
    expect(currentDates()).toEqual(["2026-09-15", "2026-09-21"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(2);
  });

  it("keeps a pending moved-range response current across its exact owned URL echo", async () => {
    const pending = deferred<Response>();
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url) =>
      url.includes("from=2026-09-08") ? pending.promise : original(url),
    );
    let props = { initialFrom: "2026-09-01", initialTo: "2026-09-07" };
    hooks.mount(() => ReportsClient(props));
    await hooks.settle();
    await click("Next period");
    props = { initialFrom: "2026-09-08", initialTo: "2026-09-14" };
    hooks.render();
    await hooks.settle();
    pending.resolve(reportResponse("/api/reports/nutrition?from=2026-09-08&to=2026-09-14"));
    await hooks.settle();
    expect(text()).toContain("2026-09-08 through 2026-09-14");
    expect(text()).toContain("Exact daily evidence");
    expect(fetcher.mock.calls.filter(([url]) => url.includes("from=2026-09-08"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/auth/me")).toHaveLength(1);
  });

  it.each(["report", "profile"] as const)(
    "ignores a delayed moved-period %s 401 between external-route render and effects",
    async (boundary) => {
      const pending = deferred<Response>();
      let authCalls = 0;
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authCalls += 1;
          return boundary === "profile" && authCalls === 2 ? pending.promise : session();
        }
        if (!url.includes("from=2026-09-08")) return reportResponse(url);
        if (boundary === "report") return pending.promise;
        const body = await reportResponse(url).json();
        body.data.profileRevision = "5";
        return Response.json(body);
      });
      vi.stubGlobal("fetch", fetcher);
      let props = { initialFrom: "2026-09-01", initialTo: "2026-09-07" };
      hooks.mount(() => ReportsClient(props));
      await hooks.settle();
      await click("Next period");
      props = { initialFrom: "2026-09-15", initialTo: "2026-09-21" };
      hooks.renderWithoutEffects();
      pending.resolve(Response.json({ error: "Expired old route" }, { status: 401 }));
      await hooks.settle();
      expect(router.replace.mock.calls.some(([url]) => url === "/login")).toBe(false);
      hooks.render();
      await hooks.settle();
      expect(text()).toContain("2026-09-15 through 2026-09-21");
      expect(text()).toContain("Exact daily evidence");
    },
  );

  it("ignores old initial-auth 401 before replacement route effects start", async () => {
    const pending = deferred<Response>();
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/me"
          ? ++authCalls === 1
            ? pending.promise
            : session()
          : reportResponse(url),
      ),
    );
    let props = { initialFrom: "2026-09-01", initialTo: "2026-09-07" };
    hooks.mount(() => ReportsClient(props));
    props = { initialFrom: "2026-09-15", initialTo: "2026-09-21" };
    hooks.renderWithoutEffects();
    pending.resolve(Response.json({ error: "Expired old route" }, { status: 401 }));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    hooks.render();
    await hooks.settle();
    expect(text()).toContain("2026-09-15 through 2026-09-21");
  });

  it("revalidates an updated profile without reading the same target twice", async () => {
    let reportReads = 0;
    let authReads = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return session(owner, ++authReads === 1 ? "4" : "5");
      reportReads += 1;
      const response = reportResponse(url);
      const body = await response.json();
      if (reportReads > 1) body.data.profileRevision = "5";
      return Response.json(body);
    });
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    await click("Next period");
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(text()).toContain("Exact daily evidence");
    expect(reportReads).toBe(2);
    expect(authReads).toBe(2);
    expect(button("Next period").props.disabled).toBe(false);
  });

  it("disables navigation for unapplied or invalid date edits, preserves them, and rejects old controls after edit-restore", async () => {
    const fetcher = readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    const retained = button("Next period");
    const requests = fetcher.mock.calls.length;
    inputDate(0, "");
    invoke(retained);
    await hooks.settle();
    expect(currentDates()).toEqual(["", "2026-09-07"]);
    expect(button("Previous period").props.disabled).toBe(true);
    expect(button("Next period").props.disabled).toBe(true);
    expect(text()).toContain(
      "Choose Update report to apply your dates before moving to another period.",
    );
    nutrient("15");
    await hooks.settle();
    expect(elements().find((node) => node.type === "select")?.props.value).toBe("15");
    expect(button("Next period").props.disabled).toBe(true);
    inputDate(0, "2026-09-01");
    await hooks.settle();
    expect(button("Next period").props.disabled).toBe(false);
    invoke(retained);
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(currentDates()).toEqual(["2026-09-01", "2026-09-07"]);
    await click("Next period");
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
  });

  it("keeps the existing preset anchor on the edited To date", async () => {
    readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    inputDate(1, "2026-09-21");
    await hooks.settle();
    await click("7 days");
    expect(currentDates()).toEqual(["2026-09-15", "2026-09-21"]);
  });

  it("clears old evidence and blocks duplicate, opposite, field, preset, submit and nutrient handlers before paint", async () => {
    const pending = deferred<Response>();
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url) =>
      url.includes("from=2026-09-08") ? pending.promise : original(url),
    );
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    nutrient("2");
    await hooks.settle();
    const next = button("Next period");
    const previous = button("Previous period");
    const from = required(dateFields()[0]);
    const to = required(dateFields()[1]);
    const preset = button("30 days");
    const form = required(elements().find((node) => node.type === "form"));
    const select = required(elements().find((node) => node.type === "select"));
    invoke(next);
    invoke(next);
    invoke(previous);
    invoke(from, "onChange", { target: { value: "2026-08-01" } });
    invoke(to, "onChange", { target: { value: "2026-08-31" } });
    invoke(preset);
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(select, "onChange", { target: { value: "15" } });
    printEvents.dispatchEvent(new Event("beforeprint"));
    expect(printGate()).toBe("false");
    await hooks.settle();
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(text()).not.toContain("Exact daily evidence");
    expect(button("Next period").props.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("from=2026-09-08"))).toHaveLength(1);
    pending.resolve(reportResponse("/api/reports/nutrition?from=2026-09-08&to=2026-09-14"));
    await hooks.settle();
    expect(elements().find((node) => node.type === "select")?.props.value).toBe("2");
    invoke(next);
    await hooks.settle();
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed target selected and retries it once without restoring the old report", async () => {
    let targets = 0;
    const fetcher = readyFetcher();
    const original = required(fetcher.getMockImplementation());
    fetcher.mockImplementation(async (url) =>
      url.includes("from=2026-09-08") && ++targets === 1
        ? Response.json({ error: "Target temporarily unavailable" }, { status: 503 })
        : original(url),
    );
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    nutrient("9");
    await hooks.settle();
    const oldPrevious = button("Previous period");
    await click("Next period");
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(text()).not.toContain("Exact daily evidence");
    expect(button("Previous period").props.disabled).toBe(true);
    expect(button("Next period").props.disabled).toBe(true);
    invoke(oldPrevious);
    const retry = button("Retry report");
    invoke(retry);
    invoke(retry);
    await hooks.settle();
    expect(targets).toBe(2);
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(elements().find((node) => node.type === "select")?.props.value).toBe("9");
  });

  it.each(["0002-01-01", "9998-12-31"] as const)(
    "disables only the unavailable direction for loaded %s",
    async (date) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url === "/api/auth/me" ? session(owner, "4", "UTC") : utcReportResponse(url),
        ),
      );
      hooks.mount(() => ReportsClient({ initialFrom: date, initialTo: date }));
      await hooks.settle();
      expect(text()).toContain("Exact daily evidence");
      expect(button("Previous period").props.disabled).toBe(date === "0002-01-01");
      expect(button("Next period").props.disabled).toBe(date === "9998-12-31");
      await click(date === "0002-01-01" ? "Next period" : "Previous period");
      expect(currentDates()).toEqual(
        date === "0002-01-01" ? ["0002-01-02", "0002-01-02"] : ["9998-12-30", "9998-12-30"],
      );
    },
  );

  it.each(["owner", "expired"] as const)(
    "closes a moved report when the response detects %s and rejects retained controls",
    async (failure) => {
      const fetcher = readyFetcher();
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url) => {
        if (!url.includes("from=2026-09-08")) return original(url);
        if (failure === "expired") return Response.json({ error: "Expired" }, { status: 401 });
        const body = await reportResponse(url).json();
        body.data.ownerUserId = anotherOwner;
        return Response.json(body);
      });
      hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
      await hooks.settle();
      const retained = button("Next period");
      await click("Next period");
      expect(router.replace).toHaveBeenLastCalledWith("/login");
      expect(text()).not.toContain("Exact daily evidence");
      expect(button("Next period").props.disabled).toBe(true);
      const requests = fetcher.mock.calls.length;
      invoke(retained);
      await hooks.settle();
      expect(fetcher.mock.calls).toHaveLength(requests);
    },
  );

  it("rejects navigation while initial session is unverified and after unmount", async () => {
    const auth = deferred<Response>();
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? auth.promise : reportResponse(url),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    const initial = button("Next period");
    invoke(initial);
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(1);
    auth.resolve(session());
    await hooks.settle();
    const ready = button("Next period");
    hooks.unmount();
    const requests = fetcher.mock.calls.length;
    invoke(initial);
    invoke(ready);
    await hooks.settle();
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(0);
  });

  it("revokes an active print gate when moving periods during the native print call", async () => {
    readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-07" }));
    await hooks.settle();
    nativePrint.mockImplementation(() => {
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("true");
      invoke(button("Next period"));
      expect(printGate()).toBe("false");
    });
    startPrint();
    await hooks.settle();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(currentDates()).toEqual(["2026-09-08", "2026-09-14"]);
    expect(printedComponent()).toBeUndefined();
  });
});

type SourceCoverage = "zero" | "partial" | "trace" | "unknown";
function sourceDiaryFixture(
  reportDate = "2026-09-01",
  sourceDates = ["2026-09-02", "2026-08-31", "2026-09-02"],
  coverage: SourceCoverage = "unknown",
) {
  const base = emptyNutritionReportFixture(reportDate);
  const nextDate = new Date(`${reportDate}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const count = sourceDates.length;
  const complete = coverage === "zero" || coverage === "trace";
  const unknownCount = coverage === "unknown" ? count : coverage === "partial" ? count - 1 : 0;
  return {
    data: {
      ...base.data,
      timeZone: "UTC",
      days: base.data.days.map((day) => ({
        ...day,
        startsAt: `${reportDate}T00:00:00.000Z`,
        endsAt: nextDate.toISOString(),
        entryCount: count,
        sourceDiaries: sourceDates.map((localDate, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          localDate,
          revision: String(index + 1),
        })),
        sourceTimeZones: ["Pacific/Kiritimati", "Pacific/Pago_Pago"],
      })),
      series: base.data.series.map((series) => ({
        ...series,
        summary: {
          diaryDays: 1,
          completeDays: complete ? 1 : 0,
          exactDays: coverage === "zero" ? 1 : 0,
          partialDays: coverage === "partial" ? 1 : 0,
          unknownDays: coverage === "unknown" ? 1 : 0,
          traceDays: coverage === "trace" ? 1 : 0,
          missingDays: 0,
        },
        points: series.points.map((point) => ({
          ...point,
          aggregate: {
            nutrientId: series.nutrient.id,
            code: series.nutrient.code,
            name: series.nutrient.name,
            unit: series.nutrient.unit,
            knownAmount: coverage === "partial" ? "0.123456789" : "0",
            completeness: complete ? "complete" : coverage,
            isExact: coverage === "zero",
            contributorCount: count,
            quantifiedCount: coverage === "zero" ? count : coverage === "partial" ? 1 : 0,
            traceCount: coverage === "trace" ? count : 0,
            unknownCount,
            unknownReasonCounts: {
              not_reported: unknownCount,
              not_analyzed: 0,
              not_applicable: 0,
              withheld: 0,
            },
          },
          knownPercentOfScale: coverage === "partial" ? "12.346" : "0",
        })),
      })),
    },
  };
}
function sourceDiaryFetcher(
  reportDate = "2026-09-01",
  sourceDates?: string[],
  coverage?: SourceCoverage,
) {
  const fixture = sourceDiaryFixture(reportDate, sourceDates, coverage);
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url === "/api/auth/me"
      ? session(owner, "4", "UTC")
      : url.includes(`from=${reportDate}&to=${reportDate}`)
        ? Response.json(fixture)
        : utcReportResponse(url),
  );
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, fixture };
}
function diaryButtons() {
  return elements().filter(
    (node) => node.type === "button" && text(node).startsWith("Open diary for "),
  );
}
async function mountSourceDay(reportDate = "2026-09-01") {
  hooks.mount(() => ReportsClient({ initialFrom: reportDate, initialTo: reportDate }));
  await hooks.settle();
}

describe("actual report source diary navigation", () => {
  it.each(["2026-08-31", "2026-09-02"])(
    "opens the selected contributing date %s with no prior reads, deduplicating other source IDs",
    async (date) => {
      const { fetcher, fixture } = sourceDiaryFetcher();
      const before = JSON.stringify(fixture);
      expect(parseNutritionReport(fixture).days[0]?.sourceDiaries).toHaveLength(3);
      await mountSourceDay();
      expect(diaryButtons().map((node) => text(node))).toEqual([
        "Open diary for 2026-08-31",
        "Open diary for 2026-09-02",
      ]);
      expect(
        elements().some((node) => node.type === "time" && node.props.dateTime === "2026-09-01"),
      ).toBe(true);
      expect(text()).toContain("Report days are grouped in UTC. Source diary dates may differ.");
      expect(text()).toContain(
        "These actions open the current diary; its entries and revisions may have changed since this snapshot.",
      );
      expect(fetcher.mock.calls).toHaveLength(2);
      expect(router.push).not.toHaveBeenCalled();
      expect(
        diaryButtons().every(
          (node) => node.props.type === "button" && node.props.href === undefined,
        ),
      ).toBe(true);
      await click(`Open diary for ${date}`);
      expect(router.push).toHaveBeenCalledExactlyOnceWith(`/dashboard?date=${date}`);
      expect(fetcher.mock.calls).toHaveLength(2);
      expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
        true,
      );
      expect(JSON.stringify(fixture)).toBe(before);
    },
  );

  it("opens the report date for a missing day without changing Missing evidence", async () => {
    const fetcher = readyFetcher();
    await mountSourceDay();
    expect(diaryButtons().map((node) => text(node))).toEqual(["Open diary for 2026-09-01"]);
    expect(text()).toContain("Missing");
    await click("Open diary for 2026-09-01");
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard?date=2026-09-01");
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it.each([
    ["zero", "0 kcal"],
    ["partial", ">0 kcal"],
    ["trace", "At least 0 kcal"],
    ["unknown", "Unknown"],
  ] as const)(
    "retains %s nutrient evidence while deriving destinations solely from source diaries",
    async (coverage, expectedAmount) => {
      sourceDiaryFetcher("2026-09-01", ["2026-08-31", "2026-08-31"], coverage);
      await mountSourceDay();
      expect(diaryButtons().map((node) => text(node))).toEqual(["Open diary for 2026-08-31"]);
      const table = required(elements().find((node) => node.props.className === "reportTable"));
      expect(
        elements(table).some((node) => node.type === "td" && text(node) === expectedAmount),
      ).toBe(true);
      nutrient("15");
      await hooks.settle();
      expect(diaryButtons().map((node) => text(node))).toEqual(["Open diary for 2026-08-31"]);
    },
  );

  it.each([
    ["0002-01-01", "0001-12-31"],
    ["9998-12-31", "9999-01-01"],
  ] as const)(
    "keeps the source diary domain beyond report bound %s",
    async (reportDate, sourceDate) => {
      sourceDiaryFetcher(reportDate, [sourceDate]);
      await mountSourceDay(reportDate);
      await click(`Open diary for ${sourceDate}`);
      expect(router.push).toHaveBeenCalledExactlyOnceWith(`/dashboard?date=${sourceDate}`);
    },
  );

  it("disables actions for dirty dates and rejects the old action after restoring those dates", async () => {
    const { fetcher } = sourceDiaryFetcher();
    await mountSourceDay();
    const retained = button("Open diary for 2026-08-31");
    inputDate(0, "");
    invoke(retained);
    await hooks.settle();
    expect(diaryButtons().every((node) => node.props.disabled === true)).toBe(true);
    expect(text()).toContain("Choose Update report to apply your dates before opening a diary.");
    inputDate(0, "2026-09-01");
    await hooks.settle();
    invoke(retained);
    await hooks.settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(fetcher.mock.calls).toHaveLength(2);
    await click("Open diary for 2026-08-31");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate and alternate destinations before paint and while departure is pending", async () => {
    const { fetcher } = sourceDiaryFetcher();
    await mountSourceDay();
    const first = button("Open diary for 2026-08-31");
    const second = button("Open diary for 2026-09-02");
    invoke(first);
    invoke(first);
    invoke(second);
    hooks.render();
    await hooks.settle();
    expect(diaryButtons().every((node) => node.props.disabled === true)).toBe(true);
    invoke(button("Open diary for 2026-09-02"));
    await hooks.settle();
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard?date=2026-08-31");
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(printGate()).toBe("false");
  });

  it("offers a fresh retry if routing throws without reusing the retained action", async () => {
    sourceDiaryFetcher();
    await mountSourceDay();
    const retained = button("Open diary for 2026-08-31");
    router.push.mockImplementationOnce(() => {
      throw new Error("Router unavailable");
    });
    invoke(retained);
    await hooks.settle();
    expect(text()).toContain("Diary navigation could not start. Try Open diary again.");
    invoke(retained);
    await hooks.settle();
    expect(router.push).toHaveBeenCalledTimes(1);
    await click("Open diary for 2026-08-31");
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it.each([
    "period",
    "route",
    "owner",
    "profile",
    "expired",
    "logout",
    "unmounted",
    "effect-replay",
  ] as const)("rejects a retained diary action after %s", async (transition) => {
    const { fetcher } = sourceDiaryFetcher();
    let props = { initialFrom: "2026-09-01", initialTo: "2026-09-01" };
    hooks.mount(() => ReportsClient(props));
    await hooks.settle();
    const retained = button("Open diary for 2026-08-31");
    if (transition === "period") await click("Next period");
    if (transition === "route") {
      props = { initialFrom: "2026-09-03", initialTo: "2026-09-03" };
      hooks.renderWithoutEffects();
    }
    if (["owner", "profile", "expired"].includes(transition)) {
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        url !== "/api/auth/me"
          ? original(url, init)
          : transition === "expired"
            ? Response.json({ error: "Expired" }, { status: 401 })
            : session(
                transition === "owner" ? anotherOwner : owner,
                transition === "profile" ? "5" : "4",
                "UTC",
              ),
      );
      startPrint();
      await hooks.settle();
    }
    if (transition === "logout") {
      const original = required(fetcher.getMockImplementation());
      fetcher.mockImplementation(async (url, init) =>
        url === "/api/auth/logout" ? new Response(null, { status: 204 }) : original(url, init),
      );
      await click("Sign out");
    }
    if (transition === "unmounted") hooks.unmount();
    if (transition === "effect-replay") {
      hooks.replayEffects();
      await hooks.settle();
    }
    const requests = fetcher.mock.calls.length;
    const updates = hooks.afterClose();
    invoke(retained);
    await hooks.settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(hooks.afterClose()).toBe(updates);
    if (transition === "route") {
      hooks.render();
      await hooks.settle();
      expect(currentDates()).toEqual(["2026-09-03", "2026-09-03"]);
    }
  });

  it("has no available diary actions while loading or after a report failure, and rejects the old source callback", async () => {
    const pending = deferred<Response>();
    const { fetcher } = sourceDiaryFetcher();
    const original = required(fetcher.getMockImplementation());
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    expect(diaryButtons()).toHaveLength(0);
    await hooks.settle();
    const retained = button("Open diary for 2026-08-31");
    fetcher.mockImplementation(async (url, init) =>
      url.includes("from=2026-09-02") ? pending.promise : original(url, init),
    );
    await click("Next period");
    expect(diaryButtons()).toHaveLength(0);
    invoke(retained);
    pending.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(diaryButtons()).toHaveLength(0);
    invoke(retained);
    await hooks.settle();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("revokes an active print gate before router navigation and retains exact printable evidence", async () => {
    const { fixture } = sourceDiaryFetcher();
    await mountSourceDay();
    nativePrint.mockImplementation(() => {
      expect(printedComponent()?.props.report).toEqual(fixture.data);
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("true");
      router.push.mockImplementationOnce(() => {
        expect(printGate()).toBe("false");
      });
      invoke(button("Open diary for 2026-08-31"));
    });
    startPrint();
    await hooks.settle();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard?date=2026-08-31");
    expect(printedComponent()).toBeUndefined();
    expect(printGate()).toBe("false");
  });
});

function dayInspectorButton(date: string, expanded = false): ElementNode {
  const label = `${expanded ? "Hide" : "View"} all nutrients for ${date}`;
  const matches = elements().filter(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  );
  expect(matches, label).toHaveLength(1);
  return matches[0] as ElementNode;
}
function dayInspector(date: string): ElementNode {
  const matches = elements().filter(
    (node) => node.type === "section" && node.props.id === `report-day-inspector-${date}`,
  );
  expect(matches).toHaveLength(1);
  return matches[0] as ElementNode;
}

describe("web report day inspector", () => {
  it("shows all 15 exact nutrient rows from the same report without a new request", async () => {
    const fixture = zeroTargetNutritionReportFixture();
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : Response.json(fixture),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-01" }));
    await hooks.settle();
    const before = fetcher.mock.calls.length;
    const open = dayInspectorButton("2026-09-01");
    expect(open.props["aria-expanded"]).toBe(false);
    (open.props.onClick as () => void)();
    await hooks.settle();
    const detail = dayInspector("2026-09-01");
    const body = elements(detail).find((node) => node.type === "tbody");
    const rows = elements(body).filter((node) => node.type === "tr");
    expect(rows).toHaveLength(15);
    for (const [index, series] of fixture.data.series.entries()) {
      expect(text(rows[index])).toContain(`${series.nutrient.name} (${series.nutrient.unit})`);
      expect(text(rows[index])).toContain(`1 ${series.nutrient.unit}`);
    }
    expect(dayInspectorButton("2026-09-01", true).props["aria-controls"]).toBe(detail.props.id);
    const firstCells = elements(rows[0]).filter((node) => node.type === "td");
    const secondCells = elements(rows[1]).filter((node) => node.type === "td");
    expect(firstCells.slice(-3).map((node) => text(node))).toEqual([
      "target 0 kcal · user_fixed 1",
      "target percentage unavailable because the saved target is zero",
      "Goal r3 · version 22222222",
    ]);
    expect(secondCells.slice(-3).map((node) => text(node))).toEqual([
      "No saved threshold",
      "Not compared",
      "Goal r3 · version 22222222",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});

function inspections() {
  return elements().filter(
    (node) =>
      node.type === "section" &&
      typeof node.props.id === "string" &&
      node.props.id.startsWith("report-day-inspector-"),
  );
}
async function openInspector(date = "2026-09-01") {
  const node = dayInspectorButton(date);
  expect(node.props.disabled).toBe(false);
  invoke(node);
  await hooks.settle();
  return dayInspector(date);
}

describe("web report day inspector evidence and lifecycle", () => {
  it("keeps quantified zero, exact decimals, trace, partial and unknown evidence distinct", async () => {
    const fixture = sourceDiaryFixture("2026-09-01", undefined, "zero");
    const variants = ["zero", "partial", "trace", "unknown"] as const;
    fixture.data.series = fixture.data.series.map((series, index) => {
      const variant = variants[index % variants.length] as SourceCoverage;
      return sourceDiaryFixture("2026-09-01", undefined, variant).data.series[index] ?? series;
    });
    expect(parseNutritionReport(fixture).series).toHaveLength(15);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/me" ? session(owner, "4", "UTC") : Response.json(fixture),
      ),
    );
    await mountSourceDay();
    const original = JSON.stringify(fixture);
    const detail = await openInspector();
    const rows = elements(elements(detail).find((node) => node.type === "tbody")).filter(
      (node) => node.type === "tr",
    );
    expect(text(rows[0])).toContain("0 kcalComplete for logged diary contributions.");
    expect(text(rows[1])).toContain(
      "At least 0.1 gKnown lower bound; 2 of 3 contributions lack values.",
    );
    expect(text(rows[2])).toContain("At least 0 gKnown lower bound with 3 trace contributions.");
    expect(text(rows[3])).toContain(
      "UnknownAmount unknown because every diary contribution lacks a quantified value.",
    );
    expect(text(detail)).toContain("No saved goal");
    expect(text(detail)).toContain("Not compared");
    expect(JSON.stringify(fixture)).toBe(original);
  });

  it("keeps all 15 nutrient names and units for a missing day without inventing zeros", async () => {
    readyFetcher();
    await mountSourceDay();
    const detail = await openInspector();
    const rows = elements(elements(detail).find((node) => node.type === "tbody")).filter(
      (node) => node.type === "tr",
    );
    const fixture = emptyNutritionReportFixture();
    expect(rows).toHaveLength(15);
    fixture.data.series.forEach((series, index) => {
      expect(text(rows[index])).toContain(
        `${series.nutrient.name} (${series.nutrient.unit})Missing`,
      );
      expect(text(rows[index])).toContain("No diary entries; this is missing, not zero.");
    });
  });

  it("switches and closes exactly one day, rejecting duplicate and superseded same-render actions", async () => {
    const fetcher = readyFetcher();
    hooks.mount(() => ReportsClient({ initialFrom: "2026-09-01", initialTo: "2026-09-02" }));
    await hooks.settle();
    const first = dayInspectorButton("2026-09-01");
    const staleSecond = dayInspectorButton("2026-09-02");
    invoke(first);
    invoke(first);
    invoke(staleSecond);
    await hooks.settle();
    expect(inspections()).toHaveLength(1);
    dayInspector("2026-09-01");
    const oldHide = dayInspectorButton("2026-09-01", true);
    await openInspector("2026-09-02");
    invoke(oldHide);
    await hooks.settle();
    expect(inspections()).toHaveLength(1);
    dayInspector("2026-09-02");
    const hide = dayInspectorButton("2026-09-02", true);
    invoke(hide);
    invoke(hide);
    invoke(first);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves chart and selected-nutrient print scope, even when the print dialog blurs the window", async () => {
    const { fetcher, fixture } = sourceDiaryFetcher();
    await mountSourceDay();
    await openInspector();
    const retained = dayInspectorButton("2026-09-01", true);
    nutrient("15");
    await hooks.settle();
    invoke(retained);
    await hooks.settle();
    expect(inspections()).toHaveLength(1);
    expect(elements().find((node) => node.type === "select")?.props.value).toBe("15");
    expect(fetcher).toHaveBeenCalledTimes(2);
    nativePrint.mockImplementation(() => {
      expect(printedComponent()?.props.nutrientId).toBe("15");
      expect(printedComponent()?.props.report).toEqual(fixture.data);
      printEvents.dispatchEvent(new Event("blur"));
      printEvents.dispatchEvent(new Event("beforeprint"));
      expect(printGate()).toBe("true");
    });
    startPrint();
    await hooks.settle();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(inspections()).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    printEvents.dispatchEvent(new Event("focus"));
    await hooks.settle();
    await openInspector();
  });

  it("retires inspection on a date edit and cannot revive it by returning to the original date", async () => {
    const fetcher = readyFetcher();
    await mountSourceDay();
    const beforeOpen = dayInspectorButton("2026-09-01");
    await openInspector();
    const retained = dayInspectorButton("2026-09-01", true);
    inputDate(0, "2026-08-31");
    invoke(retained);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    expect(dayInspectorButton("2026-09-01").props.disabled).toBe(true);
    inputDate(0, "2026-09-01");
    await hooks.settle();
    invoke(beforeOpen);
    invoke(retained);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    await openInspector();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps controls live for unchanged dates without closing the chosen day", async () => {
    readyFetcher();
    await mountSourceDay();
    await openInspector();
    const hide = dayInspectorButton("2026-09-01", true);
    inputDate(0, "2026-09-01");
    inputDate(1, "2026-09-01");
    invoke(hide);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    await openInspector();
  });

  it("binds replacement evidence at the same range and rejects retained prior-snapshot controls", async () => {
    const first = zeroTargetNutritionReportFixture();
    let fixture: unknown = first;
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : Response.json(fixture),
    );
    vi.stubGlobal("fetch", fetcher);
    await mountSourceDay();
    await openInspector();
    const old = dayInspectorButton("2026-09-01", true);
    fixture = emptyNutritionReportFixture();
    const form = required(elements().find((node) => node.type === "form"));
    invoke(form, "onSubmit", { preventDefault: vi.fn() });
    invoke(old);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    invoke(old);
    const detail = await openInspector();
    expect(text(detail)).toContain("MissingNo diary entries");
    expect(text(detail)).not.toContain("target 0 kcal");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["period", "route", "logout", "expired", "profile", "effect-replay"] as const)(
    "retires the selected day and stale callbacks across %s",
    async (transition) => {
      const fetcher = readyFetcher();
      let props = { initialFrom: "2026-09-01", initialTo: "2026-09-01" };
      hooks.mount(() => ReportsClient(props));
      await hooks.settle();
      const staleOpen = dayInspectorButton("2026-09-01");
      await openInspector();
      const staleHide = dayInspectorButton("2026-09-01", true);
      if (transition === "period") invoke(button("Next period"));
      if (transition === "route") {
        props = { initialFrom: "2026-09-03", initialTo: "2026-09-03" };
        hooks.renderWithoutEffects();
      }
      if (transition === "logout") {
        fetcher.mockImplementation(async (url: string) =>
          url === "/api/auth/logout" ? new Response(null, { status: 204 }) : session(),
        );
        invoke(button("Sign out"));
      }
      if (transition === "expired" || transition === "profile") {
        fetcher.mockImplementation(async () =>
          transition === "expired" ? new Response(null, { status: 401 }) : session(owner, "5"),
        );
        startPrint();
      }
      if (transition === "effect-replay") hooks.replayEffects();
      invoke(staleOpen);
      invoke(staleHide);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      invoke(staleOpen);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      if (transition === "route") {
        hooks.render();
        await hooks.settle();
        await openInspector("2026-09-03");
      }
    },
  );

  it.each(["hidden", "unfocused"] as const)(
    "starts closed and unavailable in an initially %s document",
    async (initial) => {
      const events = new EventTarget();
      const documentState = {
        visibilityState: initial === "hidden" ? "hidden" : "visible",
        hasFocus: () => initial === "hidden",
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      };
      vi.stubGlobal("document", documentState);
      readyFetcher();
      await mountSourceDay();
      const unavailable = dayInspectorButton("2026-09-01");
      expect(unavailable.props.disabled).toBe(true);
      invoke(unavailable);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      documentState.visibilityState = "visible";
      documentState.hasFocus = () => true;
      printEvents.dispatchEvent(new Event("focus"));
      await hooks.settle();
      invoke(unavailable);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      await openInspector();
    },
  );

  it.each(["blur", "visibility"] as const)(
    "clears on %s and allows only a new choice after returning",
    async (change) => {
      const events = new EventTarget();
      const documentState = {
        visibilityState: "visible",
        hasFocus: () => true,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      };
      vi.stubGlobal("document", documentState);
      const fetcher = readyFetcher();
      await mountSourceDay();
      await openInspector();
      const retained = dayInspectorButton("2026-09-01", true);
      if (change === "blur") printEvents.dispatchEvent(new Event("blur"));
      else {
        documentState.visibilityState = "hidden";
        events.dispatchEvent(new Event("visibilitychange"));
      }
      invoke(retained);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      documentState.visibilityState = "visible";
      printEvents.dispatchEvent(new Event("focus"));
      await hooks.settle();
      invoke(retained);
      await hooks.settle();
      expect(inspections()).toHaveLength(0);
      await openInspector();
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("does not write state through retained lifecycle or day callbacks after unmount", async () => {
    const listen = vi.spyOn(window, "addEventListener");
    const fetcher = readyFetcher();
    await mountSourceDay();
    await openInspector();
    const retained = dayInspectorButton("2026-09-01", true);
    const blur = required(listen.mock.calls.find(([name]) => name === "blur"))[1] as EventListener;
    const focus = required(
      listen.mock.calls.find(([name]) => name === "focus"),
    )[1] as EventListener;
    hooks.unmount();
    invoke(retained);
    blur(new Event("blur"));
    focus(new Event("focus"));
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps original source diary dates and closes disclosure synchronously when navigation starts", async () => {
    const { fetcher } = sourceDiaryFetcher();
    await mountSourceDay();
    await openInspector();
    const retained = dayInspectorButton("2026-09-01", true);
    expect(text()).toContain("These actions open the current diary;");
    invoke(button("Open diary for 2026-08-31"));
    invoke(retained);
    await hooks.settle();
    expect(inspections()).toHaveLength(0);
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard?date=2026-08-31");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
