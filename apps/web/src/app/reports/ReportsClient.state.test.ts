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
  const render = () => {
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

import { emptyNutritionReportFixture } from "../../test/nutrition-report-fixture";
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

  it.each(["date", "nutrient", "preset", "logout", "unmount"] as const)(
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
