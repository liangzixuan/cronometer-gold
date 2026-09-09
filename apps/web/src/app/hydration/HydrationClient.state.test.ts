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

import { HydrationClient } from "./HydrationClient";

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
function field(label: string): ElementNode {
  const found = elements().find((node) => node.type === "label" && text(node).trim() === label);
  const input =
    found &&
    (found.props.htmlFor
      ? elements().find((node) => node.type === "input" && node.props.id === found.props.htmlFor)
      : elements(found.props.children ?? null).find((node) => node.type === "input"));
  if (!input) throw new Error(`Missing input: ${label}`);
  return input;
}
function invoke(node: ElementNode, action: string, ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node, "onClick");
  await hooks.settle();
}
async function change(label: string, value: string | boolean) {
  const input = field(label);
  invoke(input, "onChange", {
    target: typeof value === "boolean" ? { checked: value } : { value },
  });
  await hooks.settle();
}
async function submit(label: string) {
  const form = elements().find((node) => node.type === "form" && text(node).includes(label));
  if (!form) throw new Error(`Missing form: ${label}`);
  invoke(form, "onSubmit", { preventDefault() {} });
  await hooks.settle();
}

const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const anotherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
const original = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  amountMilliliters: 375,
  occurredAt: "2026-11-01T07:30:45.250Z",
  localDate: "2026-11-01",
  localTime: "01:30:45.250",
  timeZone: "America/Chicago",
  createdAt: "2026-11-01T07:30:46.000Z",
};
function session(id = owner, timeZone = "America/New_York") {
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
        revision: "1",
      },
    },
  });
}
function day(entries = [original], localDate = "2026-11-01", timeZone = "America/New_York") {
  return Response.json({
    data: {
      localDate,
      timeZone,
      revision: "4",
      entries,
      totalMilliliters: entries.reduce((sum, entry) => sum + entry.amountMilliliters, 0),
      updatedAt: "2026-11-02T14:10:01.000Z",
    },
  });
}
function receipt(entry = { ...original, amountMilliliters: 500, revision: "3" }, replayed = false) {
  return {
    data: {
      replayed,
      entry,
      affectedDays: [...new Set([original.localDate, entry.localDate])].map((localDate) => ({
        localDate,
        revision: "5",
      })),
    },
  };
}
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("actual web hydration component state transitions", () => {
  it("submits only the amount for an original fractional later-fold entry in a historical zone", async () => {
    let saved = original;
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "PATCH") {
          writes.push(init);
          saved = { ...original, amountMilliliters: 500, revision: "3" };
          return Response.json(receipt(saved));
        }
        return day([saved]);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    await click("Edit entry");
    expect(field("Correct date or time").props.checked).toBe(false);
    await change("Milliliters at 01:30", "500");
    await submit("Save amount");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe('{"amountMilliliters":500}');
    expect(new Headers(writes[0]?.headers).has("x-expected-profile-time-zone")).toBe(false);
    expect(text()).toContain("Hydration amount updated and the exact total refreshed.");
    expect(text()).toContain("500 mL");
    expect(text()).not.toContain("Retry saved change");
  });

  it("retries a lost response with exact bytes/key and retries only the read after accepted cross-day correction", async () => {
    const writes: Array<{ url: string; init: RequestInit }> = [];
    const reads: string[] = [];
    let failRefresh = true;
    const moved = {
      ...original,
      revision: "3",
      occurredAt: "2026-11-02T14:10:00.000Z",
      localDate: "2026-11-02",
      localTime: "09:10:00.000",
      timeZone: "America/New_York",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "PATCH") {
          writes.push({ url, init });
          if (writes.length === 1) throw new TypeError("Response was lost.");
          return Response.json(receipt(moved, true));
        }
        reads.push(url);
        if (writes.length > 0 && failRefresh) throw new TypeError("Read temporarily unavailable.");
        return day(writes.length ? [] : [original]);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    await click("Edit entry");
    await change("Correct date or time", true);
    expect(field("Corrected local time").props.value).toBe("02:30");
    await change("Corrected local date", "2026-11-02");
    await change("Corrected local time", "09:10");
    await submit("Save correction");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain("?profileTimeZonePrecondition=v1");
    expect(text()).toContain("Retry saved change");
    expect(text()).not.toContain("Retry day view");
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.init.body).toBe(writes[0]?.init.body);
    expect(writes[1]?.init.headers).toEqual(writes[0]?.init.headers);
    expect(text()).toContain("The entry change was accepted and moved to 2026-11-02");
    expect(text()).not.toContain("Retry saved change");
    expect(field("Local date").props.value).toBe("2026-11-01");
    failRefresh = false;
    await click("Retry day view");
    expect(writes).toHaveLength(2);
    expect(reads.every((url) => url.endsWith("date=2026-11-01"))).toBe(true);
    expect(text()).toContain("Hydration entry moved to 2026-11-02");
    expect(text()).toContain("0 mL");
    expect(button("View destination day 2026-11-02")).toBeDefined();
    const back = elements().find((node) => text(node) === "Return to Today overview");
    expect(back?.props.href).toBe("/dashboard?date=2026-11-01");
  });

  it.each([412, 409])(
    "reconciles a no-write %s before an explicitly reconfirmed correction",
    async (status) => {
      const writes: RequestInit[] = [];
      const refreshed = { ...original, revision: "4" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "PATCH") {
            writes.push(init);
            if (writes.length === 1)
              return Response.json(
                {
                  error: "Current evidence changed.",
                  code: status === 409 ? "HYDRATION_TIME_ZONE_CHANGED" : "PRECONDITION_FAILED",
                },
                { status },
              );
            return Response.json(
              receipt({
                ...refreshed,
                revision: "5",
                occurredAt: "2026-11-01T10:00:00.000Z",
                localTime: "10:00:00.000",
                timeZone: "UTC",
              }),
            );
          }
          return writes.length ? day([refreshed], original.localDate, "UTC") : day();
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await click("Edit entry");
      await change("Correct date or time", true);
      await submit("Save correction");
      expect(text()).toContain("Reload and review entries");
      expect(text()).not.toContain("Retry saved change");
      expect(writes).toHaveLength(1);
      await click("Reload and review entries");
      expect(writes).toHaveLength(1);
      await click("Edit entry");
      await change("Correct date or time", true);
      await change("Corrected local time", "10:00");
      await submit("Save correction");
      expect(writes).toHaveLength(2);
      const before = new Headers(writes[0]?.headers);
      const after = new Headers(writes[1]?.headers);
      expect(after.get("idempotency-key")).not.toBe(before.get("idempotency-key"));
      expect(after.get("if-match")).toBe('"4"');
      expect(after.get("x-expected-profile-time-zone")).toBe("UTC");
      expect(text()).toContain("Hydration time corrected and the exact total refreshed.");
    },
  );

  it("requires a fold radio choice, clears it after minute changes, and blocks a spring gap", async () => {
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "PATCH") writes.push(init);
        return day([original], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await click("Edit entry");
    await change("Correct date or time", true);
    let radios = elements().filter((node) => node.type === "input" && node.props.type === "radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((node) => node.props.checked === false)).toBe(true);
    expect(text()).toContain("Earlier occurrence · UTC−05:00");
    expect(text()).toContain("Later occurrence · UTC−06:00");
    await submit("Save correction");
    expect(writes).toHaveLength(0);
    invoke(radios[1] as ElementNode, "onChange");
    await hooks.settle();
    await change("Corrected local time", "01:31");
    radios = elements().filter((node) => node.type === "input" && node.props.type === "radio");
    expect(radios.every((node) => node.props.checked === false)).toBe(true);
    await change("Corrected local date", "2026-03-08");
    await change("Corrected local time", "02:30");
    await submit("Save correction");
    expect(writes).toHaveLength(0);
    expect(text()).toContain("does not exist");
  });

  it("ignores a prior account's deferred mutation body after a new session/date generation", async () => {
    let initialDate = original.localDate;
    let activeOwner = owner;
    let finishReceipt: ((value: unknown) => void) | undefined;
    const delayed = new Promise<unknown>((resolve) => {
      finishReceipt = resolve;
    });
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(activeOwner);
        if (init?.method === "PATCH") {
          const response = Response.json({});
          response.json = () => delayed;
          return response;
        }
        reads.push(url);
        return activeOwner === owner ? day() : day([], "2026-11-02");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    await click("Edit entry");
    await change("Milliliters at 01:30", "500");
    await submit("Save amount");
    activeOwner = anotherOwner;
    initialDate = "2026-11-02";
    hooks.render();
    await hooks.settle();
    const readsBeforeLateBody = reads.length;
    finishReceipt?.(receipt());
    await hooks.settle();
    expect(reads).toHaveLength(readsBeforeLateBody);
    expect(text()).toContain("other@example.test");
    expect(text()).not.toContain("owner@example.test");
    expect(text()).not.toContain("Hydration amount updated");
    expect(text()).not.toContain("Retry saved change");
    expect(field("Local date").props.value).toBe("2026-11-02");
  });

  it("closes private UI on a mutation owner mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "PATCH")
          return Response.json({ code: "HYDRATION_OWNER_CHANGED" }, { status: 409 });
        return day();
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Milliliters", "1234");
    await click("Edit entry");
    await submit("Save amount");
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(text()).not.toContain("owner@example.test");
    expect(text()).not.toContain("375 mL");
    expect(field("Milliliters").props.value).toBe("");
    expect(text()).not.toContain("Retry saved change");
  });
  it("does not apply a late hydration read body after unmount", async () => {
    let finishBody: ((value: unknown) => void) | undefined;
    const delayed = new Promise<unknown>((resolve) => {
      finishBody = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") return session();
        const response = Response.json({});
        response.json = () => delayed;
        return response;
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    hooks.unmount();
    finishBody?.(await day().json());
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(router.replace).not.toHaveBeenCalled();
  });
  it.each([408, 429])(
    "retains a lost-write operation through transient %s before its accepted replay",
    async (status) => {
      const writes: Array<{ url: string; init: RequestInit }> = [];
      const saved = {
        ...original,
        revision: "3",
        occurredAt: "2026-11-01T14:10:00.000Z",
        localTime: "09:10:00.000",
        timeZone: "America/New_York",
      };
      let reads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "PATCH") {
            writes.push({ url, init });
            if (writes.length === 1) throw new TypeError("Accepted response was lost.");
            if (writes.length === 2)
              return Response.json({ error: "Try this operation again shortly." }, { status });
            return Response.json(receipt(saved, true));
          }
          reads += 1;
          return writes.length === 3 ? day([saved]) : day();
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await click("Edit entry");
      await change("Correct date or time", true);
      await change("Corrected local time", "09:10");
      await submit("Save correction");
      await click("Retry saved change");
      expect(writes).toHaveLength(2);
      expect(text()).toContain("Retry saved change");
      expect(text()).not.toContain("Reload and review entries");
      expect(reads).toBe(1);
      await click("Retry saved change");
      expect(writes).toHaveLength(3);
      for (const retry of writes.slice(1)) {
        expect(retry.url).toBe(writes[0]?.url);
        expect(retry.init.body).toBe(writes[0]?.init.body);
        expect(retry.init.headers).toEqual(writes[0]?.init.headers);
      }
      const headers = new Headers(writes[2]?.init.headers);
      expect(headers.get("if-match")).toBe('"2"');
      expect(headers.get("x-expected-profile-time-zone")).toBe("America/New_York");
      expect(reads).toBe(2);
      expect(text()).toContain("Hydration time corrected and the exact total refreshed.");
      expect(text()).not.toContain("Retry saved change");
    },
  );
});
