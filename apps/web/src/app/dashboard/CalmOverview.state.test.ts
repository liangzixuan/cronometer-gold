import { afterEach, describe, expect, it, vi } from "vitest";

// Runs the actual component and its effects with deterministic synchronous hooks.
// This observes request/state transitions; browser layout and concurrent React are
// separate acceptance evidence, not claims made by this harness.
const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let closed = false;
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
          const next =
            typeof change === "function" ? (change as (current: T) => T)(slot.value as T) : change;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        },
      ] as const;
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return;
      const slot: Slot = { ...(deps ? { deps } : {}) };
      slots[index] = slot;
      effects.push(() => {
        old?.cleanup?.();
        slot.cleanup = effect();
      });
    },
    mount(next: () => unknown) {
      slots = [];
      effects = [];
      closed = false;
      component = next;
      render();
    },
    async settle() {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty && !closed) render();
      }
    },
    tree: () => tree,
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
  useEffect: hooks.useEffect,
}));

import { noteSession } from "../../lib/day-notes.test-fixtures";
import { type DiaryDay, type DiaryEntry, type DiaryNutrient, parseSession } from "../../lib/diary";
import type { GoalProgressRowView, GoalProgressView } from "../../lib/recipes-goals";
import { CalmOverview } from "./CalmOverview";

const session = parseSession(noteSession());
function nutrient(overrides: Partial<DiaryNutrient> = {}): DiaryNutrient {
  return {
    nutrientId: "1",
    code: "energy",
    name: "Energy",
    unit: "kcal",
    knownAmount: "125.5",
    completeness: "complete",
    isExact: true,
    contributorCount: 1,
    quantifiedCount: 1,
    traceCount: 0,
    unknownCount: 0,
    unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
    ...overrides,
  };
}
function entry(nutrients: readonly DiaryNutrient[] = [nutrient()]): DiaryEntry {
  const source = {
    code: "TEST",
    releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
    displayName: "Test source",
    licenseExpression: "CC0-1.0",
    attributionRequired: false,
    attributionText: "Test source",
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    revision: "1",
    entryKind: "food",
    foodVersionId: "202",
    recipeVersionId: null,
    portion: { kind: "grams", grams: "100" },
    food: { name: "Apples", brandName: null },
    recipe: null,
    source,
    foodProvenance: { kind: "public", source },
    mealSlot: "breakfast",
    resolvedGrams: "100",
    note: null,
    occurredAt: "2026-09-15T13:30:00.000Z",
    localDate: "2026-09-15",
    timeZone: "America/Chicago",
    localTime: "08:30:00",
    position: 0,
    nutrients,
  };
}
const day: DiaryDay = {
  id: null,
  localDate: "2026-09-15",
  timeZone: "America/Chicago",
  status: "open",
  revision: "8",
  orderDigest: "a".repeat(64),
  entries: [entry()],
  totals: [nutrient()],
  updatedAt: null,
};
function progressRow(overrides: Partial<GoalProgressRowView> = {}): GoalProgressRowView {
  return {
    nutrientId: "1",
    code: "energy",
    name: "Energy",
    unit: "kcal",
    knownAmount: "125.5",
    completeness: "complete",
    amountInterpretation: "exact",
    minimum: null,
    target: { amount: "2000", lowerBoundPercent: "6.275", percentIsExact: true },
    maximum: null,
    ...overrides,
  };
}
function progress(overrides: Partial<GoalProgressView> = {}): GoalProgressView {
  return {
    localDate: day.localDate,
    timeZone: day.timeZone,
    diaryRevision: day.revision,
    goal: {
      id: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      revision: "1",
    },
    energy: progressRow(),
    nutrients: [],
    notice: "General wellness estimate; not medical advice.",
    ...overrides,
  };
}
interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function nodes(value: unknown = hooks.tree()): Element[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item ?? null));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Element;
  return [node, ...nodes(node.props.children ?? null)];
}
function text(value: unknown = hooks.tree()): string {
  if (Array.isArray(value)) return value.map((item) => text(item ?? null)).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" && "props" in value
    ? text((value as Element).props.children ?? null)
    : "";
}
function button(label: string): Element {
  const result = nodes().find((node) => node.type === "button" && text(node) === label);
  if (!result) throw new Error(`Missing button ${label}: ${text()}`);
  return result;
}
function invoke(node: Element) {
  (node.props.onClick as () => void)();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
});

describe("Calm overview consumed target retries", () => {
  for (const stage of ["progress", "session"] as const) {
    it.each(["success", "failure"] as const)(
      `keeps a consumed ${stage} retry inert while pending and after %s`,
      async (outcome) => {
        const pending = deferred<Response>();
        let phase: "initial" | "pending" | "ready" = "initial";
        const fetcher = vi.fn(async (url: string, _init: RequestInit) => {
          if (url.startsWith("/api/goals/progress")) {
            if (phase === "pending") return pending.promise;
            return phase === "initial" && stage === "progress"
              ? new Response(null, { status: 503 })
              : Response.json({ data: progress() });
          }
          if (url === "/api/auth/me") {
            return phase === "initial" && stage === "session"
              ? new Response(null, { status: 503 })
              : Response.json(noteSession());
          }
          throw new Error(`Unexpected request ${url}`);
        });
        vi.stubGlobal("fetch", fetcher);
        const onUnauthorized = vi.fn();
        const onReloadDay = vi.fn();
        const props = {
          day,
          session,
          totalEntries: 1,
          completeDayLoaded: true,
          isCurrent: () => true,
          onUnauthorized,
          onReloadDay,
        };
        hooks.mount(() => CalmOverview(props));
        await hooks.settle();
        const retry = button("Retry targets");
        const before = fetcher.mock.calls.length;
        expect(before).toBe(stage === "progress" ? 1 : 2);
        expect(text()).toContain("126 kcal");
        phase = "pending";
        invoke(retry);
        invoke(retry);
        await hooks.settle();
        expect(fetcher).toHaveBeenCalledTimes(before + 1);
        const request = fetcher.mock.calls[before];
        expect(request).toEqual([
          `/api/goals/progress?date=${day.localDate}`,
          {
            cache: "no-store",
            headers: { accept: "application/json" },
            signal: expect.any(AbortSignal),
          },
        ]);
        const signal = request?.[1].signal;
        expect(signal).not.toBe(fetcher.mock.calls[0]?.[1].signal);
        expect(signal?.aborted).toBe(false);
        invoke(retry);
        await hooks.settle();
        expect(fetcher).toHaveBeenCalledTimes(before + 1);
        expect(signal?.aborted).toBe(false);
        pending.resolve(
          outcome === "success"
            ? Response.json({ data: progress() })
            : new Response(null, { status: 503 }),
        );
        await hooks.settle();
        const settled = text();
        const count = fetcher.mock.calls.length;
        expect(count).toBe(before + (outcome === "success" ? 2 : 1));
        expect(settled).toContain("126 kcal");
        expect(settled).toContain(outcome === "success" ? "View saved targets" : "Retry targets");
        invoke(retry);
        await hooks.settle();
        expect(fetcher).toHaveBeenCalledTimes(count);
        expect(text()).toBe(settled);
        if (outcome === "failure") {
          phase = "ready";
          invoke(button("Retry targets"));
          await hooks.settle();
          expect(fetcher.mock.calls.slice(count)).toEqual([
            [
              `/api/goals/progress?date=${day.localDate}`,
              { ...request?.[1], signal: expect.any(AbortSignal) },
            ],
            ["/api/auth/me", { ...request?.[1], signal: expect.any(AbortSignal) }],
          ]);
          expect(fetcher.mock.calls[count]?.[1].signal).not.toBe(signal);
          expect(fetcher.mock.calls[count]?.[1].signal).toBe(
            fetcher.mock.calls[count + 1]?.[1].signal,
          );
          expect(text()).toContain("View saved targets");
          expect(text()).not.toContain("Retry targets");
        }
        expect(fetcher.mock.calls.every(([, init]) => init.method === undefined)).toBe(true);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(onReloadDay).not.toHaveBeenCalled();
      },
    );
  }
});

it("ignores target retry when its view is no longer current", async () => {
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 503 }),
  );
  vi.stubGlobal("fetch", fetcher);
  let current = true;
  const onUnauthorized = vi.fn();
  const onReloadDay = vi.fn();
  const props = {
    day,
    session,
    totalEntries: 1,
    completeDayLoaded: true,
    isCurrent: () => current,
    onUnauthorized,
    onReloadDay,
  };
  hooks.mount(() => CalmOverview(props));
  await hooks.settle();
  const retry = button("Retry targets");
  const failed = text();
  current = false;
  invoke(retry);
  current = true;
  await hooks.settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(text()).toBe(failed);
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(onReloadDay).not.toHaveBeenCalled();
});
