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
  const found = elements().find(
    (node) =>
      node.type === "button" && (text(node) === label || node.props["aria-label"] === label),
  );
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function addForm(): ElementNode {
  const form = elements().find((node) => node.type === "form" && text(node).includes("Add entry"));
  if (!form) throw new Error("Missing Add form.");
  return form;
}
function created(amountMilliliters = 250) {
  return {
    ...original,
    id: "81570203-1cb5-4626-b142-a7a74046a5f3",
    revision: "1",
    amountMilliliters,
    occurredAt: "2026-11-01T15:15:00.000Z",
    localTime: "10:15:00",
    timeZone: "America/New_York",
  };
}
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    const back = elements().find((node) => text(node) === "Return to diary");
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

describe("actual web hydration Add amount presets", () => {
  it.each([250, 500])(
    "chooses %s mL locally and explicitly creates only that reviewed amount",
    async (amountMilliliters) => {
      const writes: Array<{ url: string; init: RequestInit }> = [];
      let reads = 0;
      const saved = created(amountMilliliters);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes.push({ url, init });
            return Response.json(receipt(saved));
          }
          reads += 1;
          return day(writes.length ? [original, saved] : [original]);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await change("Local time", "10:15");
      await change("Milliliters", "375");
      const oldAmount = field("Milliliters");
      const oldTime = field("Local time");
      const oldSubmit = addForm();
      const preset = button(`${amountMilliliters} mL`);
      expect(preset.props.type).toBe("button");
      expect(preset.props["aria-pressed"]).toBe(false);
      invoke(preset, "onClick");
      invoke(oldAmount, "onChange", { target: { value: "1999" } });
      invoke(oldTime, "onChange", { target: { value: "09:00" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(field("Milliliters").props.value).toBe(String(amountMilliliters));
      expect(field("Local time").props.value).toBe("10:15");
      expect(field("Local date").props.value).toBe(original.localDate);
      expect(button(`${amountMilliliters} mL`).props["aria-pressed"]).toBe(true);
      expect(text()).toContain(`${amountMilliliters} mL selected. Review the amount and time`);
      expect(text(elements().find((node) => node.props.id === "hydration-total-heading"))).toBe(
        "375 mL",
      );
      expect(writes).toHaveLength(0);
      expect(reads).toBe(1);
      const unchanged = button(`${amountMilliliters} mL`);
      invoke(unchanged, "onClick");
      invoke(unchanged, "onClick");
      await submit("Add entry");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toBe("/api/hydration/entries?profileTimeZonePrecondition=v1");
      expect(writes[0]?.init.body).toBe(
        JSON.stringify({ amountMilliliters, occurredAt: saved.occurredAt }),
      );
      const headers = new Headers(writes[0]?.init.headers);
      expect(headers.get("x-expected-owner-user-id")).toBe(owner);
      expect(headers.get("x-expected-profile-time-zone")).toBe("America/New_York");
      expect(headers.get("if-match")).toBeNull();
      expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
      expect(field("Milliliters").props.value).toBe("");
      expect(button(`${amountMilliliters} mL`).props["aria-pressed"]).toBe(false);
      expect(text(elements().find((node) => node.props.id === "hydration-total-heading"))).toBe(
        `${375 + amountMilliliters} mL`,
      );
      expect(original.amountMilliliters).toBe(375);
      expect(reads).toBe(2);
    },
  );

  it("keeps Add usable after same-value and duplicate choices, and accepts a manual custom amount", async () => {
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(created(375)));
        }
        return day(writes.length ? [created(375)] : []);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "10:15");
    await change("Milliliters", "250");
    const unchanged = button("250 mL");
    invoke(unchanged, "onClick");
    invoke(unchanged, "onClick");
    await hooks.settle();
    await click("500 mL");
    const twice = button("250 mL");
    invoke(twice, "onClick");
    invoke(twice, "onClick");
    await hooks.settle();
    const sameAgain = button("250 mL");
    invoke(sameAgain, "onClick");
    invoke(sameAgain, "onClick");
    await hooks.settle();
    expect(button("Add entry").props.disabled).toBe(false);
    await change("Milliliters", "375");
    expect(button("250 mL").props["aria-pressed"]).toBe(false);
    expect(button("500 mL").props["aria-pressed"]).toBe(false);
    expect(text()).not.toContain("mL selected.");
    expect(text()).toContain("Whole milliliters, 1 to 20,000 per entry.");
    expect(writes).toHaveLength(0);
    await submit("Add entry");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.body)).amountMilliliters).toBe(375);
  });

  it("preserves an active correction draft while presetting only Add", async () => {
    const fetcher = vi.fn(async (url: string) => (url === "/api/auth/me" ? session() : day()));
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await click("Edit entry");
    await change("Milliliters at 01:30", "625");
    await change("Correct date or time", true);
    await change("Corrected local time", "11:12");
    await click("500 mL");
    expect(field("Milliliters").props.value).toBe("500");
    expect(field("Milliliters at 01:30").props.value).toBe("625");
    expect(field("Correct date or time").props.checked).toBe(true);
    expect(field("Corrected local time").props.value).toBe("11:12");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves the untouched default instant in the second fall-back fold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    const writes: RequestInit[] = [];
    const saved = {
      ...created(500),
      occurredAt: "2026-11-01T07:30:45.123Z",
      localTime: "01:30:45.123",
      timeZone: "America/Chicago",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(saved));
        }
        return day(writes.length ? [saved] : [], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    expect(field("Local time").props.value).toBe("01:30");
    await click("250 mL");
    await click("500 mL");
    await click("500 mL");
    await submit("Add entry");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.body))).toEqual({
      amountMilliliters: 500,
      occurredAt: saved.occurredAt,
    });
    expect(new Headers(writes[0]?.headers).get("x-expected-profile-time-zone")).toBe(
      "America/Chicago",
    );
    expect(text()).toContain("500 milliliters added and the exact total refreshed.");
  });

  it("freezes an in-flight and ambiguous Add operation, then retries identical bytes and key", async () => {
    const response = deferred<Response>();
    const writes: Array<{ url: string; init: RequestInit }> = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push({ url, init });
          if (writes.length === 1) return response.promise;
          return Response.json(receipt(created(), true));
        }
        reads += 1;
        return day(writes.length === 2 ? [created()] : []);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "10:15");
    await click("250 mL");
    const oldPreset = button("500 mL"),
      oldAmount = field("Milliliters"),
      oldTime = field("Local time"),
      oldDate = field("Local date"),
      oldSubmit = addForm();
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    invoke(oldPreset, "onClick");
    invoke(oldAmount, "onChange", { target: { value: "333" } });
    invoke(oldTime, "onChange", { target: { value: "08:00" } });
    invoke(oldDate, "onChange", { target: { value: "2026-11-02" } });
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    for (const label of ["250 mL", "500 mL", "Adding…"])
      expect(button(label).props.disabled).toBe(true);
    expect(field("Milliliters").props.value).toBe("250");
    expect(field("Local time").props.value).toBe("10:15");
    expect(field("Local date").props.value).toBe(original.localDate);
    response.resolve(Response.json({ error: "Confirmation was lost." }, { status: 503 }));
    await hooks.settle();
    const blockedPreset = button("500 mL");
    expect(blockedPreset.props.disabled).toBe(true);
    invoke(blockedPreset, "onClick");
    invoke(field("Milliliters"), "onChange", { target: { value: "500" } });
    await hooks.settle();
    expect(field("Milliliters").props.value).toBe("250");
    expect(writes).toHaveLength(1);
    expect(reads).toBe(1);
    const retry = button("Retry saved change");
    invoke(retry, "onClick");
    invoke(retry, "onClick");
    await hooks.settle();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.url).toBe(writes[0]?.url);
    expect(writes[1]?.init.body).toBe(writes[0]?.init.body);
    expect(writes[1]?.init.headers).toEqual(writes[0]?.init.headers);
    expect(reads).toBe(2);
    expect(field("Milliliters").props.value).toBe("");
    expect(button("500 mL").props.disabled).toBe(false);
  });

  it("clears an accepted amount before its delayed read and recovers with only a read", async () => {
    const refreshed = deferred<Response>();
    const writes: RequestInit[] = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(created(500)));
        }
        reads += 1;
        if (reads === 2) return refreshed.promise;
        return day(reads > 2 ? [created(500)] : []);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "10:15");
    await click("500 mL");
    const oldPreset = button("250 mL");
    await submit("Add entry");
    expect(field("Milliliters").props.value).toBe("");
    expect(button("250 mL").props.disabled).toBe(true);
    invoke(oldPreset, "onClick");
    refreshed.resolve(Response.json({ error: "Read unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(text()).toContain("The entry change was accepted");
    expect(text()).not.toContain("Retry saved change");
    expect(field("Milliliters").props.value).toBe("");
    expect(button("500 mL").props.disabled).toBe(true);
    await click("Retry day view");
    expect(writes).toHaveLength(1);
    expect(reads).toBe(3);
    expect(button("500 mL").props.disabled).toBe(false);
    await click("250 mL");
    expect(field("Milliliters").props.value).toBe("250");
  });

  it.each([409, 412])(
    "disables presets during %s reconciliation and fences prior profile controls",
    async (status) => {
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes += 1;
            return Response.json({ error: "Profile changed." }, { status });
          }
          return writes ? day([], original.localDate, "UTC") : day();
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await change("Local time", "10:15");
      await click("250 mL");
      const oldPreset = button("500 mL"),
        oldTime = field("Local time"),
        oldSubmit = addForm();
      await submit("Add entry");
      expect(button("500 mL").props.disabled).toBe(true);
      invoke(button("500 mL"), "onClick");
      expect(field("Milliliters").props.value).toBe("250");
      await click("Reload and review entries");
      const refreshedTime = field("Local time").props.value;
      invoke(oldPreset, "onClick");
      invoke(oldTime, "onChange", { target: { value: "09:00" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(field("Milliliters").props.value).toBe("250");
      expect(field("Local time").props.value).toBe(refreshedTime);
      expect(writes).toBe(1);
      await click("500 mL");
      expect(field("Milliliters").props.value).toBe("500");
    },
  );

  it("clears Add on a day change and rejects prior date and route callbacks before effects", async () => {
    let initialDate = original.localDate;
    const nextDay = deferred<Response>();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/api/auth/me") return session();
        if (url.endsWith("2026-11-02")) return nextDay.promise;
        return day([], url.endsWith("2026-11-03") ? "2026-11-03" : original.localDate);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    await click("250 mL");
    const oldPreset = button("500 mL"),
      oldAmount = field("Milliliters"),
      oldTime = field("Local time"),
      oldDate = field("Local date"),
      oldSubmit = addForm();
    invoke(button("Next day"), "onClick");
    invoke(oldPreset, "onClick");
    invoke(oldAmount, "onChange", { target: { value: "1999" } });
    invoke(oldTime, "onChange", { target: { value: "09:00" } });
    invoke(oldDate, "onChange", { target: { value: "2026-11-05" } });
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(field("Milliliters").props.value).toBe("");
    expect(field("Local date").props.value).toBe("2026-11-02");
    expect(button("500 mL").props.disabled).toBe(true);
    nextDay.resolve(day([], "2026-11-02"));
    await hooks.settle();
    await click("500 mL");
    const previousPreset = button("250 mL"),
      previousSubmit = addForm(),
      previousDate = field("Local date");
    const count = calls.length;
    initialDate = "2026-11-03";
    hooks.renderWithoutEffects();
    invoke(previousPreset, "onClick");
    invoke(previousSubmit, "onSubmit", { preventDefault() {} });
    invoke(previousDate, "onChange", { target: { value: original.localDate } });
    expect(calls).toHaveLength(count);
    hooks.render();
    await hooks.settle();
    expect(field("Local date").props.value).toBe("2026-11-03");
    expect(field("Milliliters").props.value).toBe("");
    expect(calls.some((url) => url.includes("profileTimeZonePrecondition"))).toBe(false);
  });

  it.each(["unmount", "effect replay", "private closure"] as const)(
    "rejects retained Add controls after %s",
    async (transition) => {
      let closePrivate = false;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return new Response(null, { status: 204 });
        if (closePrivate) return new Response(null, { status: 401 });
        return day();
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await click("250 mL");
      const oldPreset = button("500 mL"),
        oldAmount = field("Milliliters"),
        oldTime = field("Local time"),
        oldSubmit = addForm();
      if (transition === "unmount") hooks.unmount();
      else if (transition === "effect replay") {
        hooks.replayEffects();
        await hooks.settle();
      } else {
        closePrivate = true;
        await click("Next day");
        expect(router.replace).toHaveBeenCalledWith("/login");
      }
      const requests = fetcher.mock.calls.length;
      invoke(oldPreset, "onClick");
      invoke(oldAmount, "onChange", { target: { value: "1999" } });
      invoke(oldTime, "onChange", { target: { value: "09:00" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(fetcher).toHaveBeenCalledTimes(requests);
      expect(hooks.afterClose()).toBe(0);
      if (transition !== "unmount") expect(field("Milliliters").props.value).toBe("");
      if (transition === "private closure") {
        hooks.replayEffects();
        await hooks.settle();
        expect(fetcher).toHaveBeenCalledTimes(requests);
      }
    },
  );

  it.each([200, 401])(
    "ignores a delayed old Add %s across an external route and replacement owner",
    async (status) => {
      let initialDate = original.localDate,
        activeOwner = owner;
      const oldReceipt = deferred<Response>(),
        newReceipt = deferred<Response>();
      const writes: RequestInit[] = [];
      let reads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session(activeOwner);
          if (init?.method === "POST") {
            writes.push(init);
            return writes.length === 1 ? oldReceipt.promise : newReceipt.promise;
          }
          reads += 1;
          return day([], initialDate);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate }));
      await hooks.settle();
      await change("Local time", "10:15");
      await click("250 mL");
      await submit("Add entry");
      activeOwner = anotherOwner;
      initialDate = "2026-11-02";
      hooks.renderWithoutEffects();
      oldReceipt.resolve(
        status === 401 ? new Response(null, { status }) : Response.json(receipt(created())),
      );
      // Drain the stale receipt without running queued replacement effects.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(router.replace).not.toHaveBeenCalled();
      expect(reads).toBe(1);
      hooks.render();
      await hooks.settle();
      await click("500 mL");
      await change("Local time", "10:15");
      await submit("Add entry");
      expect(writes).toHaveLength(2);
      expect(new Headers(writes[1]?.headers).get("x-expected-owner-user-id")).toBe(anotherOwner);
      expect(button("250 mL").props.disabled).toBe(true);
      expect(field("Milliliters").props.value).toBe("500");
      expect(text()).toContain("other@example.test");
      newReceipt.resolve(
        Response.json({ error: "Keep the operation for retry." }, { status: 503 }),
      );
      await hooks.settle();
      expect(text()).toContain("Retry saved change");
      expect(field("Milliliters").props.value).toBe("500");
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("keeps a replacement owner's Add busy when the old accepted receipt finally arrives", async () => {
    let initialDate = original.localDate,
      activeOwner = owner;
    const oldReceipt = deferred<Response>(),
      newReceipt = deferred<Response>();
    const writes: RequestInit[] = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(activeOwner);
        if (init?.method === "POST") {
          writes.push(init);
          return writes.length === 1 ? oldReceipt.promise : newReceipt.promise;
        }
        reads += 1;
        return day([], initialDate);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    await change("Local time", "10:15");
    await click("250 mL");
    await submit("Add entry");
    activeOwner = anotherOwner;
    initialDate = "2026-11-02";
    hooks.render();
    await hooks.settle();
    await click("500 mL");
    await change("Local time", "10:15");
    await submit("Add entry");
    expect(writes).toHaveLength(2);
    const readsBefore = reads;
    oldReceipt.resolve(Response.json(receipt(created())));
    await hooks.settle();
    expect(reads).toBe(readsBefore);
    expect(field("Milliliters").props.value).toBe("500");
    expect(button("250 mL").props.disabled).toBe(true);
    expect(button("Sign out").props.disabled).toBe(true);
    expect(text()).toContain("Saving the hydration entry…");
    expect(text()).toContain("other@example.test");
    expect(router.replace).not.toHaveBeenCalled();
    newReceipt.resolve(Response.json({ error: "Keep this pending operation." }, { status: 503 }));
    await hooks.settle();
    expect(button("Retry saved change").props.disabled).toBe(false);
    expect(field("Milliliters").props.value).toBe("500");
  });

  it("treats an explicit unchanged visible time as an edit after selecting a preset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    const writes: RequestInit[] = [];
    const saved = {
      ...created(),
      occurredAt: "2026-11-01T06:30:00.000Z",
      localTime: "01:30:00",
      timeZone: "America/Chicago",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(saved));
        }
        return day(writes.length ? [saved] : [], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await click("250 mL");
    const oldPreset = button("500 mL");
    invoke(field("Local time"), "onChange", { target: { value: "01:30" } });
    invoke(oldPreset, "onClick");
    await hooks.settle();
    expect(field("Milliliters").props.value).toBe("250");
    await submit("Add entry");
    expect(writes).toHaveLength(0);
    expect(text()).toContain("Choose the earlier or later occurrence");
    await click("Add hydration Earlier occurrence · UTC−05:00");
    await submit("Add entry");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.body))).toEqual({
      amountMilliliters: 250,
      occurredAt: saved.occurredAt,
    });
    expect(text()).toContain("250 milliliters added and the exact total refreshed.");
  });

  it.each(["session", "day"] as const)(
    "keeps Sign out usable during a deferred %s read and ignores its late receipt",
    async (pendingRead) => {
      const delayed = deferred<Response>();
      let logoutCalls = 0,
        dayCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/auth/logout") {
            logoutCalls += 1;
            return new Response(null, { status: 204 });
          }
          if (url === "/api/auth/me")
            return pendingRead === "session" ? delayed.promise : session();
          dayCalls += 1;
          return dayCalls === 1 ? day() : delayed.promise;
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      if (pendingRead === "day") await click("Next day");
      expect(button("Sign out").props.disabled).toBe(false);
      const retainedLogout = button("Sign out");
      await click("Sign out");
      expect(logoutCalls).toBe(1);
      expect(router.replace).toHaveBeenCalledTimes(1);
      delayed.resolve(pendingRead === "session" ? session(anotherOwner) : day([], "2026-11-02"));
      await hooks.settle();
      invoke(retainedLogout, "onClick");
      await hooks.settle();
      expect(logoutCalls).toBe(1);
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(text()).not.toContain("owner@example.test");
      expect(text()).not.toContain("other@example.test");
      expect(button("250 mL").props.disabled).toBe(true);
      expect(dayCalls).toBe(pendingRead === "session" ? 0 : 2);
    },
  );
});

describe("session bootstrap recovery", () => {
  it.each(
    (["503", "network", "malformed"] as const).flatMap((failure) =>
      (["explicit", "absent", "invalid"] as const).map((dateMode) => ({ failure, dateMode })),
    ),
  )(
    "recovers $failure session failure with $dateMode date and exactly one owned day read",
    async ({ failure, dateMode }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-02T04:59:58.000Z"));
      let authReads = 0;
      const dayReads: Array<{ url: string; owner: string | null }> = [];
      const writes: RequestInit[] = [];
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) {
          writes.push(init);
          throw new Error("Session retry must not write.");
        }
        if (url === "/api/auth/me") {
          authReads += 1;
          if (authReads === 1) {
            if (failure === "network") throw new TypeError("Session connection unavailable.");
            return failure === "503"
              ? Response.json({ error: "Session unavailable." }, { status: 503 })
              : Response.json({ data: { user: {} } });
          }
          return session();
        }
        const requested = new URL(url, "https://app.example.test").searchParams.get("date") ?? "";
        dayReads.push({ url, owner: new Headers(init?.headers).get("x-expected-owner-user-id") });
        return day([], requested);
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() =>
        HydrationClient({
          ...(dateMode === "absent"
            ? {}
            : { initialDate: dateMode === "invalid" ? "2026-02-30" : "2026-11-01" }),
        }),
      );
      await hooks.settle();
      expect(authReads).toBe(1);
      expect(dayReads).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(text()).not.toContain("Retry day view");
      expect(button("Retry session").props.disabled).not.toBe(true);
      vi.setSystemTime(new Date("2026-11-02T05:00:01.000Z"));
      await click("Retry session");
      const expectedDate = dateMode === "explicit" ? "2026-11-01" : "2026-11-02";
      expect(authReads).toBe(2);
      expect(dayReads).toEqual([{ url: `/api/hydration?date=${expectedDate}`, owner }]);
      expect(field("Local date").props.value).toBe(expectedDate);
      expect(writes).toHaveLength(0);
      expect(text()).not.toContain("Retry session");
    },
  );
});

describe("session recovery request ownership", () => {
  it("rejects duplicate and retained retries while allowing a fresh retry after another failure", async () => {
    const pending = deferred<Response>();
    let authReads = 0;
    const days: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        authReads += 1;
        if (authReads === 1) return Response.json({}, { status: 503 });
        if (authReads === 2) return pending.promise;
        return session();
      }
      days.push(url);
      const requested = "2026-11-01";
      return day([], requested);
    });
    vi.stubGlobal("fetch", fetch);
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    const retry = button("Retry session");
    invoke(retry, "onClick");
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(2);
    expect(days).toHaveLength(0);
    pending.resolve(Response.json({ error: "Still unavailable." }, { status: 503 }));
    await hooks.settle();
    const failed = text();
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(2);
    expect(text()).toBe(failed);
    await click("Retry session");
    expect(authReads).toBe(3);
    expect(days).toEqual(["/api/hydration?date=2026-11-01"]);
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(3);
    expect(days).toHaveLength(1);
  });

  it("keeps an ordinary day failure on its read-only retry without verifying the session again", async () => {
    let authReads = 0,
      dayReads = 0,
      writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) writes += 1;
        if (url === "/api/auth/me") {
          authReads += 1;
          return session();
        }
        dayReads += 1;
        if (dayReads === 1) return Response.json({ error: "Day unavailable." }, { status: 503 });
        const requested = "2026-11-01";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    expect(text()).not.toContain("Retry session");
    await click("Retry day view");
    expect({ authReads, dayReads, writes }).toEqual({ authReads: 1, dayReads: 2, writes: 0 });
    expect(text()).not.toContain("Day unavailable.");
  });

  it("closes on a current retry401 before parsing and never reopens through retained retry or effect replay", async () => {
    const unauthorized = Response.json({}, { status: 401 });
    const readBody = vi.spyOn(unauthorized, "json");
    let authReads = 0,
      dayReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          return authReads === 1 ? Response.json({}, { status: 503 }) : unauthorized;
        }
        dayReads += 1;
        const requested = "2026-11-01";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(readBody).not.toHaveBeenCalled();
    invoke(retry, "onClick");
    hooks.replayEffects();
    await hooks.settle();
    expect({ authReads, dayReads }).toEqual({ authReads: 2, dayReads: 0 });
    hooks.unmount();
    invoke(retry, "onClick");
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(authReads).toBe(2);
  });

  it("rejects the old retry before route effects and recovers a failed replacement route", async () => {
    let initialDate = "2026-11-01";
    let authReads = 0;
    const days: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          return authReads <= 2 ? Response.json({}, { status: 503 }) : session();
        }
        days.push(url);
        const requested = new URL(url, "https://app.example.test").searchParams.get("date") ?? "";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    const retry = button("Retry session");
    initialDate = "2026-11-02";
    hooks.renderWithoutEffects();
    invoke(retry, "onClick");
    expect(authReads).toBe(1);
    hooks.render();
    await hooks.settle();
    expect(authReads).toBe(2);
    expect(text()).not.toContain("Retry day view");
    await click("Retry session");
    expect(authReads).toBe(3);
    expect(days).toEqual(["/api/hydration?date=2026-11-02"]);
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(3);
  });

  it.each([
    ["response", "route", "success"],
    ["response", "route", "503"],
    ["response", "route", "401"],
    ["response", "unmount", "network"],
    ["JSON", "route", "success"],
    ["JSON", "unmount", "success"],
  ] as const)("ignores delayed retry %s after %s with %s", async (stage, transition, outcome) => {
    const delayed = deferred<void>();
    let initialDate = "2026-11-01";
    let authReads = 0;
    const days: string[] = [];
    const delayedBody = vi.fn(async () => {
      await delayed.promise;
      return await session().json();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          if (authReads === 1) return Response.json({}, { status: 503 });
          if (authReads === 2) {
            if (stage === "JSON") {
              const response = Response.json({});
              response.json = delayedBody;
              return response;
            }
            await delayed.promise;
            if (outcome === "network") throw new TypeError("Old connection failed.");
            return outcome === "success"
              ? session()
              : Response.json({}, { status: Number(outcome) });
          }
          return session();
        }
        days.push(url);
        const requested = new URL(url, "https://app.example.test").searchParams.get("date") ?? "";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    if (stage === "JSON") expect(delayedBody).toHaveBeenCalledTimes(1);
    if (transition === "route") {
      initialDate = "2026-11-02";
      hooks.renderWithoutEffects();
    } else hooks.unmount();
    const before = text();
    delayed.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    invoke(retry, "onClick");
    if (transition === "route") hooks.renderWithoutEffects();
    expect(text()).toBe(before);
    expect(authReads).toBe(2);
    expect(days).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    expect(hooks.afterClose()).toBe(0);
    if (transition === "route") {
      hooks.render();
      await hooks.settle();
      expect(authReads).toBe(3);
      expect(days).toEqual(["/api/hydration?date=2026-11-02"]);
    }
  });

  it("replays bootstrap setup during a pending retry and ignores the cancelled retry401", async () => {
    const cancelled = deferred<Response>();
    let authReads = 0;
    const days: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          if (authReads === 1) return Response.json({}, { status: 503 });
          if (authReads === 2) return cancelled.promise;
          return session();
        }
        days.push(url);
        const requested = "2026-11-01";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: "2026-11-01" }));
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    hooks.replayEffects();
    await hooks.settle();
    expect(authReads).toBe(3);
    expect(days).toEqual(["/api/hydration?date=2026-11-01"]);
    cancelled.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(3);
    expect(days).toHaveLength(1);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("overlapping session recovery", () => {
  it("does not let an old request finally clear the newer pending retry", async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    let initialDate = "2026-11-01";
    let authReads = 0;
    const days: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          if (authReads === 2) return old.promise;
          if (authReads === 4) return current.promise;
          return Response.json({}, { status: 503 });
        }
        days.push(url);
        const requested = "2026-11-02";
        return day([], requested);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate }));
    await hooks.settle();
    await click("Retry session");
    initialDate = "2026-11-02";
    hooks.render();
    await hooks.settle();
    expect(authReads).toBe(3);
    const retry = button("Retry session");
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(4);
    old.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(4);
    expect(days).toHaveLength(0);
    current.resolve(session());
    await hooks.settle();
    expect(days).toEqual(["/api/hydration?date=2026-11-02"]);
    expect(text()).not.toContain("Retry session");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("Hydration recovered session preserves existing work boundaries", () => {
  it.each(["same owner", "replacement owner"] as const)(
    "keeps the external-route draft reset when retry verifies %s",
    async (ownerMode) => {
      let initialDate = original.localDate;
      let activeOwner = owner;
      let authReads = 0;
      const writes: RequestInit[] = [];
      const dayOwners: string[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          return authReads === 2 ? Response.json({}, { status: 503 }) : session(activeOwner);
        }
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({}, { status: 503 });
        }
        dayOwners.push(new Headers(init?.headers).get("x-expected-owner-user-id") ?? "");
        const date = new URL(url, "https://app.example.test").searchParams.get("date") ?? "";
        return day([], date);
      });
      vi.stubGlobal("fetch", fetch);
      hooks.mount(() => HydrationClient({ initialDate }));
      await hooks.settle();
      await change("Local time", "10:15");
      await click("500 mL");
      const oldAmount = field("Milliliters");
      const oldSubmit = addForm();
      await submit("Add entry");
      const oldWriteRetry = button("Retry saved change");
      expect(writes).toHaveLength(1);
      initialDate = "2026-11-02";
      hooks.render();
      await hooks.settle();
      expect(field("Milliliters").props.value).toBe("");
      expect(text()).not.toContain("Retry saved change");
      if (ownerMode === "replacement owner") activeOwner = anotherOwner;
      await click("Retry session");
      expect(field("Milliliters").props.value).toBe("");
      expect(field("Local date").props.value).toBe("2026-11-02");
      expect(dayOwners).toEqual([owner, activeOwner]);
      const calls = fetch.mock.calls.length;
      invoke(oldAmount, "onChange", { target: { value: "1999" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      invoke(oldWriteRetry, "onClick");
      await hooks.settle();
      expect(fetch.mock.calls).toHaveLength(calls);
      expect(writes).toHaveLength(1);
      expect(field("Milliliters").props.value).toBe("");
      expect(text()).not.toContain("Retry saved change");
      expect(router.replace).not.toHaveBeenCalledWith("/login");
    },
  );

  it("keeps a retained session retry inert through pending write, exact write replay and accepted-read repair", async () => {
    const pending = deferred<Response>();
    let authReads = 0,
      dayReads = 0;
    let accepted = false,
      failRead = true;
    const writes: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") {
          authReads += 1;
          return authReads === 1 ? Response.json({}, { status: 503 }) : session();
        }
        if (init?.method === "POST") {
          writes.push({
            url,
            body: String(init.body),
            headers: Object.fromEntries(new Headers(init.headers)),
          });
          if (writes.length === 1) return pending.promise;
          accepted = true;
          return Response.json(receipt(created(500), true));
        }
        dayReads += 1;
        return accepted && failRead
          ? Response.json({}, { status: 503 })
          : day(accepted ? [created(500)] : []);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    await change("Local time", "10:15");
    await click("500 mL");
    await submit("Add entry");
    invoke(retry, "onClick");
    await hooks.settle();
    expect({ authReads, dayReads }).toEqual({ authReads: 2, dayReads: 1 });
    expect(writes).toHaveLength(1);
    expect(field("Milliliters").props.value).toBe("500");
    pending.resolve(Response.json({ error: "Response lost." }, { status: 503 }));
    await hooks.settle();
    invoke(retry, "onClick");
    await hooks.settle();
    expect(text()).not.toContain("Retry session");
    expect(writes).toHaveLength(1);
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(text()).toContain("The entry change was accepted");
    expect(field("Milliliters").props.value).toBe("");
    expect(text()).not.toContain("Retry saved change");
    const readsBefore = dayReads;
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(2);
    expect(dayReads).toBe(readsBefore);
    expect(writes).toHaveLength(2);
    failRead = false;
    await click("Retry day view");
    expect(authReads).toBe(2);
    expect(dayReads).toBe(readsBefore + 1);
    expect(writes).toHaveLength(2);
    expect(button("500 mL").props.disabled).toBe(false);
  });

  it.each(["success", "503", "401"] as const)(
    "keeps Sign out usable during session retry and ignores its late %s",
    async (outcome) => {
      const pending = deferred<Response>();
      let authReads = 0,
        logoutCalls = 0,
        dayReads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/auth/logout") {
            logoutCalls += 1;
            return new Response(null, { status: 204 });
          }
          if (url === "/api/auth/me") {
            authReads += 1;
            return authReads === 1 ? Response.json({}, { status: 503 }) : pending.promise;
          }
          dayReads += 1;
          return day();
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      const retry = button("Retry session");
      await click("Retry session");
      expect(button("Sign out").props.disabled).toBe(false);
      await click("Sign out");
      const closed = text();
      pending.resolve(
        outcome === "success"
          ? session(anotherOwner)
          : Response.json({}, { status: Number(outcome) }),
      );
      await hooks.settle();
      invoke(retry, "onClick");
      hooks.replayEffects();
      await hooks.settle();
      expect({ authReads, logoutCalls, dayReads }).toEqual({
        authReads: 2,
        logoutCalls: 1,
        dayReads: 0,
      });
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(text()).toBe(closed);
      expect(text()).not.toContain("other@example.test");
    },
  );

  it("allows fresh session recovery after unconfirmed logout invalidates a pending auth retry", async () => {
    const pending = deferred<Response>();
    let authReads = 0,
      logoutCalls = 0,
      dayReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/logout") {
          logoutCalls += 1;
          return Response.json({}, { status: 503 });
        }
        if (url === "/api/auth/me") {
          authReads += 1;
          if (authReads === 1) return Response.json({}, { status: 503 });
          if (authReads === 2) return pending.promise;
          return session();
        }
        dayReads += 1;
        return day();
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    const retry = button("Retry session");
    await click("Retry session");
    await click("Sign out");
    expect(text()).toContain("Sign out could not be confirmed");
    invoke(retry, "onClick");
    await hooks.settle();
    expect(authReads).toBe(2);
    await click("Retry session");
    expect({ authReads, logoutCalls, dayReads }).toEqual({
      authReads: 3,
      logoutCalls: 1,
      dayReads: 1,
    });
    pending.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(text()).toContain("owner@example.test");
    expect(text()).not.toContain("Retry session");
  });
});

function hydrationAddOccurrence(side: "Earlier" | "Later", offset: string) {
  return `Add hydration ${side} occurrence · ${offset}`;
}

describe("actual Hydration Add repeated-minute selection", () => {
  it.each([
    ["America/Chicago", "2026-11-01", "01:30", "Earlier", "UTC−05:00", "2026-11-01T06:30:00.000Z"],
    ["America/Chicago", "2026-11-01", "01:30", "Later", "UTC−06:00", "2026-11-01T07:30:00.000Z"],
    [
      "Australia/Lord_Howe",
      "2026-04-05",
      "01:45",
      "Earlier",
      "UTC+11:00",
      "2026-04-04T14:45:00.000Z",
    ],
    [
      "Australia/Lord_Howe",
      "2026-04-05",
      "01:45",
      "Later",
      "UTC+10:30",
      "2026-04-04T15:15:00.000Z",
    ],
  ] as const)(
    "submits the %s %s %s %s occurrence",
    async (zone, date, time, side, offset, instant) => {
      const writes: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session(owner, zone);
          if (init?.method === "POST") {
            writes.push(init);
            return Response.json({ error: "Keep exact retry." }, { status: 503 });
          }
          return day([], date, zone);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: date }));
      await hooks.settle();
      await change("Local time", time);
      await click("250 mL");
      await submit("Add entry");
      expect(writes).toHaveLength(0);
      expect(text()).toContain("Choose the earlier or later occurrence");
      await click(hydrationAddOccurrence(side, offset));
      expect(button(hydrationAddOccurrence(side, offset)).props["aria-pressed"]).toBe(true);
      expect(text()).toContain("minute precision");
      await click("500 mL");
      expect(button(hydrationAddOccurrence(side, offset)).props["aria-pressed"]).toBe(true);
      await submit("Add entry");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.body))).toEqual({
        amountMilliliters: 500,
        occurredAt: instant,
      });
      expect(new Headers(writes[0]?.headers).get("x-expected-profile-time-zone")).toBe(zone);
    },
  );

  it.each([
    ["Earlier", "UTC−05:00", "2026-11-01T06:30:00.000Z"],
    ["Later", "UTC−06:00", "2026-11-01T07:30:00.000Z"],
  ] as const)(
    "lets explicit %s selection supersede the precise captured default",
    async (side, offset, instant) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
      const writes: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session(owner, "America/Chicago");
          if (init?.method === "POST") {
            writes.push(init);
            return Response.json({}, { status: 503 });
          }
          return day([], original.localDate, "America/Chicago");
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await click("250 mL");
      await click(hydrationAddOccurrence(side, offset));
      await submit("Add entry");
      expect(JSON.parse(String(writes[0]?.body))).toEqual({
        amountMilliliters: 250,
        occurredAt: instant,
      });
    },
  );

  it.each([
    ["2026-03-08", "02:30", "does not exist"],
    ["2026-11-01", "25:00", "valid hydration date"],
  ])("rejects %s %s without writing or offering occurrence buttons", async (date, time, error) => {
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({}, { status: 503 });
        }
        return day([], date, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: date }));
    await hooks.settle();
    await change("Local time", time);
    await click("250 mL");
    await submit("Add entry");
    expect(writes).toHaveLength(0);
    expect(text()).toContain(error);
    expect(
      elements().some((node) => String(node.props["aria-label"]).startsWith("Add hydration ")),
    ).toBe(false);
  });

  it("invalidates retained occurrence and Add callbacks synchronously on time and selection changes", async () => {
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({}, { status: 503 });
        }
        return day([], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "01:30");
    await click("250 mL");
    const oldEarlier = button(hydrationAddOccurrence("Earlier", "UTC−05:00"));
    const oldForm = addForm();
    invoke(button(hydrationAddOccurrence("Later", "UTC−06:00")), "onClick");
    invoke(oldEarlier, "onClick");
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(0);
    expect(button(hydrationAddOccurrence("Later", "UTC−06:00")).props["aria-pressed"]).toBe(true);
    const selected = button(hydrationAddOccurrence("Later", "UTC−06:00"));
    const selectedForm = addForm();
    invoke(field("Local time"), "onChange", { target: { value: "01:31" } });
    invoke(selected, "onClick");
    invoke(selectedForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(0);
    expect(button(hydrationAddOccurrence("Later", "UTC−06:00")).props["aria-pressed"]).toBe(false);
    await submit("Add entry");
    expect(writes).toHaveLength(0);
    expect(text()).toContain("Choose the earlier or later occurrence");
  });

  it.each(["date", "route", "effect replay", "logout", "owner drift", "unmount"] as const)(
    "retires occurrence choices and callbacks after %s",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
      let initialDate = original.localDate;
      let drift = false;
      const writes: RequestInit[] = [];
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({}, { status: 503 });
        }
        if (drift) return Response.json({ code: "HYDRATION_OWNER_CHANGED" }, { status: 409 });
        const requested = new URL(url, "https://app.example.test").searchParams.get("date") ?? "";
        return day([], requested, "America/Chicago");
      });
      vi.stubGlobal("fetch", fetcher);
      hooks.mount(() => HydrationClient({ initialDate }));
      await hooks.settle();
      await change("Local time", "01:30");
      await click("250 mL");
      await click(hydrationAddOccurrence("Later", "UTC−06:00"));
      const oldChoice = button(hydrationAddOccurrence("Earlier", "UTC−05:00"));
      const oldForm = addForm();
      if (transition === "date" || transition === "owner drift") {
        drift = transition === "owner drift";
        invoke(field("Local date"), "onChange", { target: { value: "2026-11-02" } });
      } else if (transition === "route") {
        initialDate = "2026-11-02";
        hooks.renderWithoutEffects();
      } else if (transition === "effect replay") hooks.replayEffects();
      else if (transition === "logout") await click("Sign out");
      else hooks.unmount();
      invoke(oldChoice, "onClick");
      invoke(oldForm, "onSubmit", { preventDefault() {} });
      if (transition === "route") hooks.render();
      await hooks.settle();
      expect(writes).toHaveLength(0);
      expect(hooks.afterClose()).toBe(0);
      if (transition === "logout" || transition === "owner drift") {
        expect(router.replace).toHaveBeenCalledWith("/login");
      } else if (transition !== "unmount") {
        if (transition === "date") await change("Local date", original.localDate);
        if (transition === "route") {
          initialDate = original.localDate;
          hooks.render();
          await hooks.settle();
        }
        await change("Local time", "01:30");
        await click("250 mL");
        invoke(oldChoice, "onClick");
        await hooks.settle();
        expect(button(hydrationAddOccurrence("Earlier", "UTC−05:00")).props["aria-pressed"]).toBe(
          false,
        );
        expect(button(hydrationAddOccurrence("Later", "UTC−06:00")).props["aria-pressed"]).toBe(
          false,
        );
        await submit("Add entry");
        expect(writes).toHaveLength(0);
      }
    },
  );

  it("retires a selected occurrence when a rejected write reloads a new profile zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
    let zone = "America/Chicago";
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, zone);
        if (init?.method === "POST") {
          writes.push(init);
          if (writes.length === 1) {
            zone = "America/New_York";
            return Response.json({ code: "HYDRATION_TIME_ZONE_CHANGED" }, { status: 409 });
          }
          return Response.json({}, { status: 503 });
        }
        return day([], original.localDate, zone);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "01:30");
    await click("250 mL");
    await click(hydrationAddOccurrence("Later", "UTC−06:00"));
    const oldChoice = button(hydrationAddOccurrence("Earlier", "UTC−05:00"));
    await submit("Add entry");
    await click("Reload and review entries");
    await change("Local time", "01:30");
    invoke(oldChoice, "onClick");
    await hooks.settle();
    expect(button(hydrationAddOccurrence("Earlier", "UTC−04:00")).props["aria-pressed"]).toBe(
      false,
    );
    expect(button(hydrationAddOccurrence("Later", "UTC−05:00")).props["aria-pressed"]).toBe(false);
    await submit("Add entry");
    expect(writes).toHaveLength(1);
    await click(hydrationAddOccurrence("Later", "UTC−05:00"));
    await submit("Add entry");
    expect(JSON.parse(String(writes[1]?.body)).occurredAt).toBe("2026-11-01T06:30:00.000Z");
    expect(new Headers(writes[1]?.headers).get("x-expected-profile-time-zone")).toBe(zone);
  });

  it("keeps selected occurrence bytes and key through in-flight and uncertain retries", async () => {
    const response = deferred<Response>();
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "POST") {
          writes.push(init);
          return writes.length === 1 ? response.promise : Response.json({}, { status: 503 });
        }
        return day([], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "01:30");
    await click("250 mL");
    await click(hydrationAddOccurrence("Later", "UTC−06:00"));
    const oldChoice = button(hydrationAddOccurrence("Earlier", "UTC−05:00"));
    const oldForm = addForm();
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    invoke(oldChoice, "onClick");
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(button(hydrationAddOccurrence("Earlier", "UTC−05:00")).props.disabled).toBe(true);
    response.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    invoke(oldChoice, "onClick");
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    expect(JSON.parse(String(writes[1]?.body))).toEqual({
      amountMilliliters: 250,
      occurredAt: "2026-11-01T07:30:00.000Z",
    });
  });
});

describe("Hydration unrelated Add correction preservation", () => {
  async function openCorrection() {
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await click("Edit entry");
    await change("Milliliters at 01:30", "625");
    await change("Correct date or time", true);
    await change("Corrected local time", "11:12");
    await change("Local time", "10:15");
    await click("500 mL");
  }

  function expectCorrection() {
    expect(field("Milliliters at 01:30").props.value).toBe("625");
    expect(field("Correct date or time").props.checked).toBe(true);
    expect(field("Corrected local date").props.value).toBe(original.localDate);
    expect(field("Corrected local time").props.value).toBe("11:12");
    expect(button("Save correction").props.disabled).toBe(false);
  }

  it("retains the exact correction after a separate Add and submits that correction once", async () => {
    const writes: Array<{ url: string; init: RequestInit }> = [];
    let reads = 0;
    const corrected = {
      ...original,
      amountMilliliters: 625,
      revision: "3",
      occurredAt: "2026-11-01T16:12:00.000Z",
      localTime: "11:12:00",
      timeZone: "America/New_York",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST" || init?.method === "PATCH") {
          writes.push({ url, init });
          return Response.json(receipt(init.method === "POST" ? created(500) : corrected));
        }
        reads += 1;
        return day(reads === 1 ? [original] : [reads === 2 ? original : corrected, created(500)]);
      }),
    );
    await openCorrection();
    await submit("Add entry");
    expect(writes).toHaveLength(1);
    expectCorrection();
    expect(field("Milliliters").props.value).toBe("");
    await submit("Save correction");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(writes[1]?.init.body))).toEqual({
      amountMilliliters: 625,
      occurredAt: corrected.occurredAt,
    });
    expect(new Headers(writes[1]?.init.headers).get("if-match")).toBe('"2"');
    expect(text()).not.toContain("Save correction");
  });

  it("preserves the correction through accepted Add read failure and read-only retry", async () => {
    let reads = 0;
    const writes: RequestInit[] = [];
    const refreshed = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(created(500)));
        }
        reads += 1;
        if (reads === 2) return refreshed.promise;
        return day(reads === 1 ? [original] : [original, created(500)]);
      }),
    );
    await openCorrection();
    await submit("Add entry");
    expect(field("Milliliters").props.value).toBe("");
    refreshed.resolve(Response.json({ error: "Read unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(text()).toContain("Retry day view");
    expect(text()).not.toContain("Retry saved change");
    await click("Retry day view");
    expectCorrection();
    expect(writes).toHaveLength(1);
    expect(reads).toBe(3);
  });

  it("keeps the pending Add bytes and identity while retaining an unrelated correction", async () => {
    const writes: Array<{ url: string; init: RequestInit }> = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push({ url, init });
          return writes.length === 1
            ? Response.json({ error: "Uncertain." }, { status: 503 })
            : Response.json(receipt(created(500), true));
        }
        reads += 1;
        return day(reads === 1 ? [original] : [original, created(500)]);
      }),
    );
    await openCorrection();
    await submit("Add entry");
    await click("Retry saved change");
    expectCorrection();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.url).toBe(writes[0]?.url);
    expect(writes[1]?.init.body).toBe(writes[0]?.init.body);
    expect(writes[1]?.init.headers).toEqual(writes[0]?.init.headers);
    expect(reads).toBe(2);
  });

  it("compares parsed source values independently of JSON property order", async () => {
    let reads = 0;
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as typeof original;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return Response.json(receipt(created(500)));
        return day(++reads === 1 ? [original] : [created(500), reordered]);
      }),
    );
    await openCorrection();
    await submit("Add entry");
    expectCorrection();
  });

  it.each([
    ["missing", null],
    ["revision", { ...original, revision: "3" }],
    ["amount with unchanged revision", { ...original, amountMilliliters: 376 }],
    ["precise instant", { ...original, occurredAt: "2026-11-01T07:30:45.251Z" }],
    ["local time", { ...original, localTime: "01:30:45.251" }],
    ["entry time zone", { ...original, timeZone: "America/New_York" }],
    ["creation timestamp", { ...original, createdAt: "2026-11-01T07:30:46.001Z" }],
  ] as const)(
    "invalidates a %s source after the unrelated Add refresh",
    async (_label, refreshedEntry) => {
      let reads = 0;
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes += 1;
            return Response.json(receipt(created(500)));
          }
          return day(
            ++reads === 1
              ? [original]
              : [...(refreshedEntry ? [refreshedEntry] : []), created(500)],
          );
        }),
      );
      await openCorrection();
      const oldForm = elements().find(
        (node) => node.type === "form" && text(node).includes("Save correction"),
      )!;
      await submit("Add entry");
      expect(text()).not.toContain("Save correction");
      invoke(oldForm, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(writes).toBe(1);
    },
  );

  it("invalidates the correction when the refreshed profile day changes time zone", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return Response.json(receipt(created(500)));
        return ++reads === 1
          ? day()
          : day([original, created(500)], original.localDate, "America/Chicago");
      }),
    );
    await openCorrection();
    await submit("Add entry");
    expect(text()).not.toContain("Save correction");
  });

  it.each([401, 409])(
    "closes the preserved draft for a current private read rejection %s",
    async (status) => {
      let reads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") return Response.json(receipt(created(500)));
          if (++reads === 1) return day();
          return Response.json(
            { code: "HYDRATION_OWNER_CHANGED", error: "Private view retired." },
            { status },
          );
        }),
      );
      await openCorrection();
      await submit("Add entry");
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(text()).not.toContain("Save correction");
      expect(text()).not.toContain("Signed in as");
    },
  );

  it("does not restore a preserved draft from a read body after unmount", async () => {
    let reads = 0;
    const body = deferred<unknown>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") return Response.json(receipt(created(500)));
        if (++reads === 1) return day();
        return { ok: true, status: 200, json: () => body.promise } as Response;
      }),
    );
    await openCorrection();
    await submit("Add entry");
    hooks.unmount();
    body.resolve(await day([original, created(500)]).json());
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
  });

  it.each(["missing", "changed"])(
    "invalidates a %s source on accepted-read retry",
    async (kind) => {
      let reads = 0;
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST") {
            writes += 1;
            return Response.json(receipt(created(500)));
          }
          if (++reads === 1) return day();
          if (reads === 2) return Response.json({ error: "Read unavailable." }, { status: 503 });
          return day(
            kind === "missing"
              ? [created(500)]
              : [{ ...original, amountMilliliters: 376 }, created(500)],
          );
        }),
      );
      await openCorrection();
      await submit("Add entry");
      await click("Retry day view");
      expect(text()).not.toContain("Save correction");
      expect(writes).toBe(1);
    },
  );

  it.each([409, 412])(
    "retains existing known-rejection invalidation for Add %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "POST")
            return Response.json({ error: "Review the current profile." }, { status });
          return day();
        }),
      );
      await openCorrection();
      await submit("Add entry");
      await click("Reload and review entries");
      expect(text()).not.toContain("Save correction");
    },
  );

  it("retires a preserved correction on a user-selected date change", async () => {
    let added = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          added = true;
          return Response.json(receipt(created(500)));
        }
        const selected = new URL(url, "http://localhost").searchParams.get("date")!;
        return day(
          selected === original.localDate ? (added ? [original, created(500)] : [original]) : [],
          selected,
        );
      }),
    );
    await openCorrection();
    await submit("Add entry");
    expectCorrection();
    await click("Next day");
    expect(text()).not.toContain("Save correction");
    await click("Previous day");
    expect(text()).not.toContain("Save correction");
  });

  it.each([owner, anotherOwner])(
    "does not restore the original correction through a new route session %s",
    async (nextOwner) => {
      let route = original.localDate;
      let authReads = 0;
      let reads = 0;
      const heldBody = deferred<unknown>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session(++authReads === 1 ? owner : nextOwner);
          if (init?.method === "POST") return Response.json(receipt(created(500)));
          if (++reads === 2)
            return { ok: true, status: 200, json: () => heldBody.promise } as Response;
          const selected = new URL(url, "http://localhost").searchParams.get("date")!;
          return day(selected === original.localDate ? [original] : [], selected);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: route }));
      await hooks.settle();
      await click("Edit entry");
      await change("Milliliters at 01:30", "625");
      await change("Local time", "10:15");
      await click("500 mL");
      await submit("Add entry");
      route = "2026-11-02";
      hooks.render();
      await hooks.settle();
      heldBody.resolve(await day([original, created(500)]).json());
      await hooks.settle();
      expect(field("Local date").props.value).toBe(route);
      expect(text()).not.toContain("Save amount");
      expect(text()).not.toContain("625");
      expect(field("Milliliters").props.value).toBe("");
    },
  );
});

describe("Hydration editor replacement protection", () => {
  const second = created(500);
  function editButton(id: string): ElementNode {
    const row = elements().find(
      (node) => node.type === "li" && (node as ElementNode & { key?: string }).key === id,
    );
    const found = elements(row ?? null).find(
      (node) => node.type === "button" && text(node) === "Edit entry",
    );
    if (!found) throw new Error(`Missing Edit entry for ${id}`);
    return found;
  }
  function correctionFields() {
    const form = elements().find(
      (node) => node.type === "form" && node.props.className === "hydrationEditor",
    );
    return elements(form ?? null)
      .filter((node) => node.type === "input")
      .map((node) => ({ value: node.props.value, checked: node.props.checked }));
  }
  async function ready() {
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : day([original, second]),
    );
    vi.stubGlobal("fetch", fetcher);
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    return fetcher;
  }
  async function rawCorrection() {
    invoke(editButton(original.id), "onClick");
    await hooks.settle();
    await change("Milliliters at 01:30", "003x");
    await change("Correct date or time", true);
    await change("Corrected local date", "");
    await change("Corrected local time", "");
  }

  it("keeps the ordinary other-row Edit action from replacing a complete raw correction", async () => {
    const fetcher = await ready();
    await rawCorrection();
    const before = correctionFields();
    const other = editButton(second.id);
    // Follow the ordinary enabled-button action on the original production code.
    if (!other.props.disabled) invoke(other, "onClick");
    await hooks.settle();
    expect(correctionFields()).toEqual(before);
    expect(other.props.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps current-render Edit callbacks inert even when invoked directly", async () => {
    const fetcher = await ready();
    await rawCorrection();
    const before = correctionFields();
    invoke(editButton(second.id), "onClick");
    await hooks.settle();
    expect(correctionFields()).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("admits only the first queued editor before another render", async () => {
    const fetcher = await ready();
    const first = editButton(original.id);
    const other = editButton(second.id);
    invoke(first, "onClick");
    invoke(other, "onClick");
    await hooks.settle();
    expect(field("Milliliters at 01:30").props.value).toBe("375");
    await change("Milliliters at 01:30", "625");
    invoke(first, "onClick");
    await hooks.settle();
    expect(field("Milliliters at 01:30").props.value).toBe("625");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves a selected occurrence and exact pending correction retry through held Edit callbacks", async () => {
    const writes: RequestInit[] = [];
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "PATCH") {
          writes.push(init);
          return writes.length === 1
            ? response.promise
            : Response.json({ error: "Still unavailable." }, { status: 503 });
        }
        return day([original, second], original.localDate, "America/Chicago");
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    invoke(editButton(original.id), "onClick");
    await hooks.settle();
    await change("Milliliters at 01:30", "625");
    await change("Correct date or time", true);
    await change("Corrected local time", "01:31");
    const later = field("Later occurrence · UTC−06:00");
    invoke(later, "onChange");
    await hooks.settle();
    const before = correctionFields();
    const heldOther = editButton(second.id);
    invoke(heldOther, "onClick");
    await hooks.settle();
    expect(correctionFields()).toEqual(before);
    await submit("Save correction");
    expect(writes).toHaveLength(1);
    invoke(heldOther, "onClick");
    await hooks.settle();
    expect(correctionFields()).toEqual(before);
    response.resolve(Response.json({ error: "Unavailable." }, { status: 503 }));
    await hooks.settle();
    invoke(heldOther, "onClick");
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    expect(new Headers(writes[0]?.headers).get("if-match")).toBe('"2"');
    expect(JSON.parse(String(writes[0]?.body))).toEqual({
      amountMilliliters: 625,
      occurredAt: "2026-11-01T07:31:00.000Z",
    });
  });

  it.each(["Cancel", "Save"])(
    "restores ordinary other-row editing after %s and keeps the independent Add draft",
    async (action) => {
      let saved = original;
      const writes: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "PATCH") {
            writes.push(init);
            saved = { ...original, amountMilliliters: 625, revision: "3" };
            return Response.json(receipt(saved));
          }
          return day([saved, second]);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
      await hooks.settle();
      await change("Milliliters", "012x");
      invoke(editButton(original.id), "onClick");
      await hooks.settle();
      await change("Milliliters at 01:30", "625");
      if (action === "Cancel") await click("Cancel");
      else await submit("Save amount");
      expect(writes).toHaveLength(action === "Save" ? 1 : 0);
      expect(editButton(second.id).props.disabled).toBe(false);
      invoke(editButton(second.id), "onClick");
      await hooks.settle();
      expect(field("Milliliters at 10:15").props.value).toBe("500");
      expect(field("Milliliters").props.value).toBe("012x");
    },
  );

  it("does not admit a held editor while an independent Add is pending or awaiting exact retry", async () => {
    const response = deferred<Response>();
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "POST") {
          writes.push(init);
          return writes.length === 1
            ? response.promise
            : Response.json({ error: "Unavailable." }, { status: 503 });
        }
        return day([original, second]);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    await change("Local time", "10:15");
    await click("250 mL");
    const held = editButton(original.id);
    await submit("Add entry");
    invoke(held, "onClick");
    await hooks.settle();
    expect(correctionFields()).toEqual([]);
    response.resolve(Response.json({ error: "Unavailable." }, { status: 503 }));
    await hooks.settle();
    invoke(held, "onClick");
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
  });

  it.each(["route", "owner", "unmount"])(
    "rejects an old Edit callback at the %s boundary",
    async (boundary) => {
      let route = original.localDate;
      let nextOwner = owner;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "/api/auth/me") return session(nextOwner);
          const selected = new URL(url, "http://localhost").searchParams.get("date") ?? route;
          return day(selected === original.localDate ? [original, second] : [], selected);
        }),
      );
      hooks.mount(() => HydrationClient({ initialDate: route }));
      await hooks.settle();
      const held = editButton(original.id);
      if (boundary === "unmount") hooks.unmount();
      else {
        route = "2026-11-02";
        if (boundary === "owner") nextOwner = anotherOwner;
        hooks.renderWithoutEffects();
      }
      invoke(held, "onClick");
      if (boundary === "unmount") expect(hooks.afterClose()).toBe(0);
      else {
        hooks.renderWithoutEffects();
        expect(correctionFields()).toEqual([]);
        hooks.render();
        await hooks.settle();
        invoke(held, "onClick");
        await hooks.settle();
        expect(correctionFields()).toEqual([]);
        expect(text()).toContain(
          boundary === "owner" ? "other@example.test" : "owner@example.test",
        );
      }
    },
  );
});

describe("Hydration unrelated Delete correction preservation", () => {
  const other = created(500);
  const deletion = (replayed = false) =>
    Response.json({
      data: {
        replayed,
        entry: null,
        affectedDays: [{ localDate: original.localDate, revision: "5" }],
      },
    });
  function rowAction(id: string, label: string): ElementNode {
    const row = elements().find(
      (node) => node.type === "li" && (node as ElementNode & { key?: string }).key === id,
    );
    const result = elements(row ?? null).find(
      (node) => node.type === "button" && text(node) === label,
    );
    if (!result) throw new Error(`Missing ${label} for ${id}`);
    return result;
  }
  function draftFields() {
    const form = elements().find(
      (node) => node.type === "form" && node.props.className === "hydrationEditor",
    );
    return elements(form ?? null)
      .filter((node) => node.type === "input")
      .map((node) => ({ value: node.props.value, checked: node.props.checked }));
  }
  async function openDraft(occurrence = false) {
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    invoke(rowAction(original.id, "Edit entry"), "onClick");
    await hooks.settle();
    await change("Milliliters at 01:30", occurrence ? "625" : "003x");
    await change("Correct date or time", true);
    await change("Corrected local time", occurrence ? "01:31" : "");
    if (occurrence) {
      invoke(field("Later occurrence · UTC−06:00"), "onChange");
      await hooks.settle();
    } else await change("Corrected local date", "");
  }
  async function removeOther() {
    const control = rowAction(other.id, "Delete");
    expect(control.props.disabled).toBe(false);
    invoke(control, "onClick");
    await hooks.settle();
  }

  it.each([false, true])(
    "preserves the ordinary raw correction after accepted other-row Delete (occurrence %s)",
    async (occurrence) => {
      const writes: Array<{ url: string; init: RequestInit }> = [];
      let entries = [original, other];
      const confirm = vi.fn(() => true);
      vi.stubGlobal("window", { confirm });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session(owner, "America/Chicago");
          if (init?.method === "DELETE") {
            writes.push({ url, init });
            entries = [original];
            return deletion();
          }
          return day(entries, original.localDate, "America/Chicago");
        }),
      );
      await openDraft(occurrence);
      const before = draftFields();
      expect(before.length).toBeGreaterThan(0);
      await removeOther();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toBe(`/api/hydration/entries/${other.id}`);
      expect(writes[0]?.init.body).toBeUndefined();
      expect(new Headers(writes[0]?.init.headers).get("if-match")).toBe('"1"');
      expect(text()).toContain("Hydration entry deleted and the exact total refreshed.");
      expect(draftFields()).toEqual(before);
    },
  );

  it("restores the exact draft after accepted Delete read failure using a read-only retry", async () => {
    let reads = 0;
    let deletes = 0;
    const held = deferred<Response>();
    vi.stubGlobal("window", { confirm: () => true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "DELETE") {
          deletes += 1;
          return deletion();
        }
        if (++reads === 2) return held.promise;
        return day(reads === 1 ? [original, other] : [original]);
      }),
    );
    await openDraft();
    const before = draftFields();
    await removeOther();
    held.resolve(Response.json({ error: "Read unavailable." }, { status: 503 }));
    await hooks.settle();
    expect(text()).toContain("Retry day view");
    expect(text()).not.toContain("Retry saved change");
    await click("Retry day view");
    expect(deletes).toBe(1);
    expect(reads).toBe(3);
    expect(draftFields()).toEqual(before);
  });

  it("replays the exact pending Delete and preserves a later-occurrence correction for Save", async () => {
    const writes: Array<{ url: string; init: RequestInit }> = [];
    let entries = [original, other];
    vi.stubGlobal("window", { confirm: () => true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session(owner, "America/Chicago");
        if (init?.method === "DELETE" || init?.method === "PATCH") {
          writes.push({ url, init });
          if (writes.length === 1)
            return Response.json({ error: "Unknown outcome." }, { status: 503 });
          if (init.method === "DELETE") {
            entries = [original];
            return deletion(true);
          }
          const corrected = {
            ...original,
            amountMilliliters: 625,
            revision: "3",
            occurredAt: "2026-11-01T07:31:00.000Z",
            localTime: "01:31:00",
          };
          entries = [corrected];
          return Response.json(receipt(corrected));
        }
        return day(entries, original.localDate, "America/Chicago");
      }),
    );
    await openDraft(true);
    const before = draftFields();
    await removeOther();
    await click("Retry saved change");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.url).toBe(writes[0]?.url);
    expect(writes[1]?.init.body).toBe(writes[0]?.init.body);
    expect(writes[1]?.init.headers).toEqual(writes[0]?.init.headers);
    expect(draftFields()).toEqual(before);
    await submit("Save correction");
    expect(writes).toHaveLength(3);
    expect(writes[2]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(writes[2]?.init.body))).toEqual({
      amountMilliliters: 625,
      occurredAt: "2026-11-01T07:31:00.000Z",
    });
    expect(draftFields()).toEqual([]);
  });

  it.each(["missing", "changed-source", "changed-zone"])(
    "retires the correction after other-row Delete when readback is %s",
    async (kind) => {
      let deleted = false;
      let writes = 0;
      vi.stubGlobal("window", { confirm: () => true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/auth/me") return session();
          if (init?.method === "DELETE") {
            writes += 1;
            deleted = true;
            return deletion();
          }
          if (!deleted) return day([original, other]);
          return day(
            kind === "missing"
              ? []
              : [
                  {
                    ...original,
                    ...(kind === "changed-source" ? { createdAt: "2026-11-01T07:30:46.001Z" } : {}),
                  },
                ],
            original.localDate,
            kind === "changed-zone" ? "America/Chicago" : "America/New_York",
          );
        }),
      );
      await openDraft();
      await removeOther();
      expect(writes).toBe(1);
      expect(draftFields()).toEqual([]);
      expect(text()).not.toContain("Save correction");
    },
  );

  it("keeps the existing same-entry Delete retirement and no-editor Delete behavior", async () => {
    const held = deferred<Response>();
    let reads = 0;
    let writes = 0;
    vi.stubGlobal("window", { confirm: () => true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "DELETE") {
          writes += 1;
          return deletion();
        }
        if (++reads === 2) return held.promise;
        return day(reads === 1 ? [original, other] : []);
      }),
    );
    hooks.mount(() => HydrationClient({ initialDate: original.localDate }));
    await hooks.settle();
    const ownDelete = rowAction(original.id, "Delete");
    invoke(rowAction(original.id, "Edit entry"), "onClick");
    await hooks.settle();
    await change("Milliliters at 01:30", "003x");
    invoke(ownDelete, "onClick");
    await hooks.settle();
    held.resolve(day([other]));
    await hooks.settle();
    expect(draftFields()).toEqual([]);
    expect(writes).toBe(1);
    await removeOther();
    expect(writes).toBe(2);
    expect(text()).toContain("No hydration entries for this local day.");
  });

  it("keeps the draft and makes no request when the ordinary Delete confirmation is cancelled", async () => {
    vi.stubGlobal("window", { confirm: () => false });
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/auth/me" ? session() : day([original, other]),
    );
    vi.stubGlobal("fetch", fetcher);
    await openDraft();
    const before = draftFields();
    await removeOther();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(draftFields()).toEqual(before);
  });

  it("retains known-rejected Delete invalidation rather than preserving a stale correction", async () => {
    let writes = 0;
    vi.stubGlobal("window", { confirm: () => true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return session();
        if (init?.method === "DELETE") {
          writes += 1;
          return Response.json({ error: "Changed entry." }, { status: 412 });
        }
        return day([original, other]);
      }),
    );
    await openDraft();
    await removeOther();
    await click("Reload and review entries");
    expect(writes).toBe(1);
    expect(draftFields()).toEqual([]);
  });
});
