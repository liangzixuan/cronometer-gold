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
  const render = () => {
    cursor = 0;
    dirty = false;
    tree = component();
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
function session(id = owner, revision = "4") {
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
        timeZone: "America/Chicago",
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
