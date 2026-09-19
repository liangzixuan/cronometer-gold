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
    const attachRefs = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) attachRefs(child);
        return;
      }
      if (!value || typeof value !== "object" || !("props" in value)) return;
      const props = (value as { props: Record<string, unknown> }).props;
      const ref = props.ref as { current: unknown } | undefined;
      if (ref && !ref.current) ref.current = { focus: vi.fn() };
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

import { parseActivityDay } from "../../lib/activity";
import { localDateInTimeZone, localTimeInTimeZone } from "../../lib/diary";
import { ActivityClient } from "./ActivityClient";

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
      node.type === "button" && (node.props["aria-label"] === label || text(node) === label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function addForm(): ElementNode {
  const found = elements().find(
    (node) => node.type === "form" && node.props.className === "workspaceForm activityForm",
  );
  if (!found) throw new Error("Missing Add form");
  return found;
}
function field(label: string, scope: unknown = addForm()): ElementNode {
  const found = elements(scope).find(
    (node) => node.type === "label" && text(node).trim() === label,
  );
  const input =
    found &&
    (found.props.htmlFor
      ? elements().find((node) => node.props.id === found.props.htmlFor)
      : elements(found).find((node) => node.type === "input"));
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}
function invoke(node: ElementNode, action = "onClick", ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node);
  await hooks.settle();
}
async function change(label: string, value: string, scope?: unknown) {
  invoke(field(label, scope), "onChange", { target: { value } });
  await hooks.settle();
}
async function submit() {
  invoke(addForm(), "onSubmit", { preventDefault() {} });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const anotherOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
const original = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  name: "Café walk",
  durationMinutes: 35,
  selfReportedEnergyKilocalories: "0.001" as string | null,
  occurredAt: "2026-08-15T13:05:01.000Z",
  localDate: "2026-08-15",
  localTime: "08:05:01",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:05:02.000Z",
};
function session(id = owner, timeZone = "America/Chicago") {
  return {
    data: {
      user: { id, email: "owner@example.test", emailVerified: true },
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
  };
}
function day(entries = [original], localDate = "2026-08-15", timeZone = "America/Chicago") {
  return {
    data: {
      localDate,
      timeZone,
      revision: "3",
      entries,
      totalDurationMinutes: entries.reduce((sum, row) => sum + row.durationMinutes, 0),
      updatedAt: "2026-08-15T13:05:02.000Z",
    },
  };
}
function receipt(body: Record<string, unknown>, replayed = false) {
  const occurredAt = String(body.occurredAt);
  const added = {
    ...original,
    ...body,
    id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
    revision: "1",
    occurredAt,
    localDate: localDateInTimeZone(new Date(occurredAt), "America/Chicago"),
    localTime: `${localTimeInTimeZone(new Date(occurredAt), "America/Chicago")}:${new Date(
      occurredAt,
    )
      .toISOString()
      .slice(17, 23)
      .replace(/\.000$/u, "")}`,
    createdAt: occurredAt,
  };
  return {
    data: { replayed, entry: added, affectedDays: [{ localDate: added.localDate, revision: "4" }] },
  };
}
function fetcher(fixture = day()) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/auth/me") return Response.json(session());
    const date =
      new URL(url, "https://app.example.test").searchParams.get("date") ?? fixture.data.localDate;
    return Response.json(date === fixture.data.localDate ? fixture : day([], date));
  });
}
let routeDate = "2026-08-15";
async function mount(fetch = fetcher()) {
  vi.stubGlobal("fetch", fetch);
  hooks.mount(() => ActivityClient({ initialDate: routeDate }));
  await hooks.settle();
  return fetch;
}
beforeEach(() => {
  routeDate = "2026-08-15";
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("activity detail reuse", () => {
  it.each([null, "0.001", "248.5"])(
    "copies exact saved fields with %s energy, keeps Add time, and requires a fresh create",
    async (energy) => {
      const source = { ...original, selfReportedEnergyKilocalories: energy };
      const fixture = day([source]);
      const before = JSON.stringify(fixture);
      const base = fetcher(fixture);
      const writes: RequestInit[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(JSON.parse(String(init.body))));
        }
        return base(url, init);
      });
      await mount(fetch);
      await change("Local time", "10:15");
      const reads = fetch.mock.calls.length;
      const oldName = field("Activity name");
      const oldSubmit = addForm();
      await click("Reuse details from Café walk");
      expect(field("Activity name").props.value).toBe("Café walk");
      expect(field("Duration (minutes)").props.value).toBe("35");
      expect(field("Self-reported calories (optional)").props.value).toBe(energy ?? "");
      expect(field("Local time").props.value).toBe("10:15");
      expect(
        (field("Activity name").props.ref as { current: { focus: ReturnType<typeof vi.fn> } })
          .current.focus,
      ).toHaveBeenCalledTimes(1);
      expect(text()).toContain("choose Add entry to save a new activity");
      expect(text()).toContain("35 min");
      expect(fetch).toHaveBeenCalledTimes(reads);
      invoke(oldName, "onChange", { target: { value: "Stale edit" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      await hooks.settle();
      expect(field("Activity name").props.value).toBe("Café walk");
      expect(writes).toHaveLength(0);
      await submit();
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.body))).toEqual({
        name: "Café walk",
        durationMinutes: 35,
        selfReportedEnergyKilocalories: energy,
        occurredAt: "2026-08-15T15:15:00.000Z",
      });
      expect(new Headers(writes[0]?.headers).get("if-match")).toBeNull();
      expect(new Headers(writes[0]?.headers).get("x-expected-owner-user-id")).toBe(owner);
      expect(new Headers(writes[0]?.headers).get("x-expected-profile-time-zone")).toBe(
        "America/Chicago",
      );
      expect(field("Activity name").props.value).toBe("");
      expect(JSON.stringify(fixture)).toBe(before);
    },
  );

  it("protects raw dirty fields with a keep/replace choice and preserves time", async () => {
    const fetch = await mount();
    await change("Activity name", "  custom unsaved name  ");
    await change("Duration (minutes)", "050");
    await change("Self-reported calories (optional)", "  ");
    await change("Local time", "11:11");
    const reads = fetch.mock.calls.length;
    await click("Reuse details from Café walk");
    expect(field("Activity name").props.value).toBe("  custom unsaved name  ");
    await click("Keep editing");
    expect(field("Duration (minutes)").props.value).toBe("050");
    expect(field("Self-reported calories (optional)").props.value).toBe("  ");
    await click("Reuse details from Café walk");
    await click("Replace draft with saved details");
    expect(field("Activity name").props.value).toBe("Café walk");
    expect(field("Duration (minutes)").props.value).toBe("35");
    expect(field("Self-reported calories (optional)").props.value).toBe("0.001");
    expect(field("Local time").props.value).toBe("11:11");
    expect(fetch).toHaveBeenCalledTimes(reads);
  });

  it("leaves zero energy invalid for both saved input and Add", async () => {
    expect(() =>
      parseActivityDay(day([{ ...original, selfReportedEnergyKilocalories: "0" }])),
    ).toThrow();
    const fetch = await mount();
    await click("Reuse details from Café walk");
    await change("Self-reported calories (optional)", "0");
    const calls = fetch.mock.calls.length;
    await submit();
    expect(text()).toContain("Enter up to 20,000 calories");
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});

describe("activity reuse intent and time", () => {
  it("retains the untouched second-fold instant when copying historical details", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    routeDate = "2026-11-01";
    const source = {
      ...original,
      localDate: routeDate,
      localTime: "01:05:01",
      occurredAt: "2026-11-01T06:05:01.000Z",
      createdAt: "2026-11-01T06:05:02.000Z",
    };
    const base = fetcher(day([source], routeDate));
    const writes: RequestInit[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return Response.json(receipt(JSON.parse(String(init.body))));
      }
      return base(url, init);
    });
    await mount(fetch);
    expect(field("Local time").props.value).toBe("01:30");
    await click("Reuse details from Café walk");
    await submit();
    expect(JSON.parse(String(writes[0]?.body)).occurredAt).toBe("2026-11-01T07:30:45.123Z");
    expect(field("Activity name").props.value).toBe("");
  });

  it("uses a fresh key for explicit same-body reuse but keeps unchanged retries and date-away/back identity", async () => {
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return Response.json({ error: "Lost response." }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Local time", "10:15");
    await click("Reuse details from Café walk");
    await submit();
    await click("Retry day view");
    await submit();
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[1]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    await click("Retry day view");
    await click("Next day");
    expect(field("Activity name").props.value).toBe("Café walk");
    await click("Previous day");
    await submit();
    expect(writes[2]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[2]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    await click("Retry day view");
    await click("Reuse details from Café walk");
    await click("Keep editing");
    await submit();
    expect(new Headers(writes[3]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    await click("Retry day view");
    await click("Reuse details from Café walk");
    const oldSubmit = addForm();
    await click("Replace draft with saved details");
    invoke(oldSubmit, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(4);
    await submit();
    expect(writes[4]?.body).toBe(writes[0]?.body);
    expect(new Headers(writes[4]?.headers).get("idempotency-key")).not.toBe(
      new Headers(writes[0]?.headers).get("idempotency-key"),
    );
    await click("Retry day view");
    await submit();
    expect(writes[5]?.body).toBe(writes[4]?.body);
    expect(new Headers(writes[5]?.headers).get("idempotency-key")).toBe(
      new Headers(writes[4]?.headers).get("idempotency-key"),
    );
  });

  it.each(["read-failure", "changed-zone"] as const)(
    "clears only accepted details after its own %s refresh and never resubmits on read retry",
    async (outcome) => {
      const base = fetcher();
      let saved = false;
      let failRead = true;
      const writes: RequestInit[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          saved = true;
          writes.push(init);
          return Response.json(receipt(JSON.parse(String(init.body))));
        }
        if (saved && url.startsWith("/api/activities?")) {
          if (outcome === "read-failure" && failRead)
            return Response.json({ error: "Read unavailable." }, { status: 503 });
          return Response.json(
            outcome === "changed-zone" ? day([], "2026-08-15", "America/New_York") : day(),
          );
        }
        return base(url, init);
      });
      await mount(fetch);
      await change("Local time", "10:15");
      await click("Reuse details from Café walk");
      await submit();
      expect(writes).toHaveLength(1);
      expect(field("Activity name").props.value).toBe("");
      expect(field("Duration (minutes)").props.value).toBe("");
      expect(field("Self-reported calories (optional)").props.value).toBe("");
      if (outcome === "read-failure") {
        expect(text()).toContain("do not submit the change again");
        expect(button("Add entry").props.disabled).toBe(true);
        failRead = false;
        await click("Retry day view");
        expect(writes).toHaveLength(1);
      } else {
        expect(field("Local time").props.value).toBe(
          localTimeInTimeZone(new Date(), "America/New_York").slice(0, 5),
        );
        expect(text()).toContain("America/New_York");
      }
    },
  );
});

describe("activity reuse confirmation fencing", () => {
  it.each([
    "Activity name",
    "Duration (minutes)",
    "Self-reported calories (optional)",
    "Local time",
  ])("invalidates exact dirty choices on a further %s edit", async (label) => {
    const fetch = await mount();
    await change("Activity name", "  original draft  ");
    await click("Reuse details from Café walk");
    const keep = button("Keep editing");
    const replace = button("Replace draft with saved details");
    expect(
      (keep.props.ref as { current: { focus: ReturnType<typeof vi.fn> } }).current.focus,
    ).toHaveBeenCalledTimes(1);
    const next = label === "Local time" ? "12:12" : "  changed  ";
    await change(label, next);
    const calls = fetch.mock.calls.length;
    invoke(keep);
    invoke(replace);
    await hooks.settle();
    expect(field(label).props.value).toBe(next);
    expect(text()).not.toContain("Your Add draft contains details.");
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("does not let old keep/replace controls dismiss or accept a newer exact choice", async () => {
    const fetch = await mount();
    await change("Activity name", "Draft");
    await click("Reuse details from Café walk");
    const oldKeep = button("Keep editing");
    const oldReplace = button("Replace draft with saved details");
    await click("Keep editing");
    await click("Reuse details from Café walk");
    const calls = fetch.mock.calls.length;
    invoke(oldKeep);
    invoke(oldReplace);
    await hooks.settle();
    expect(text()).toContain("Your Add draft contains details.");
    expect(field("Activity name").props.value).toBe("Draft");
    expect(fetch).toHaveBeenCalledTimes(calls);
    await click("Replace draft with saved details");
    expect(field("Activity name").props.value).toBe("Café walk");
  });

  it("keeps row editing intact and prevents a same-paint reuse or stale Add field from replacing work", async () => {
    await mount();
    await change("Activity name", "Add draft");
    const reuse = button("Reuse details from Café walk");
    invoke(button("Edit activity"));
    invoke(reuse);
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("Add draft");
    const editor = elements().find(
      (node) => node.type === "form" && node.props.className === "activityEditor",
    );
    expect(editor).toBeDefined();
    await change("Duration (minutes)", "45", editor);
    expect(
      field(
        "Duration (minutes)",
        elements().find((node) => node.props.className === "activityEditor"),
      ).props.value,
    ).toBe("45");
    expect(text()).not.toContain("Your Add draft contains details.");
    await click("Cancel");
    expect(field("Activity name").props.value).toBe("Add draft");
  });
});

describe("activity reuse private and mutation boundaries", () => {
  it("blocks double submission and same-paint reuse, field and date controls while a write starts", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return pending.promise;
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Local time", "10:15");
    await click("Reuse details from Café walk");
    const form = addForm();
    const reuse = button("Reuse details from Café walk");
    const input = field("Activity name");
    const next = button("Next day");
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(form, "onSubmit", { preventDefault() {} });
    invoke(reuse);
    invoke(input, "onChange", { target: { value: "Stale work" } });
    invoke(next);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(button("Reuse details from Café walk").props.disabled).toBe(true);
    expect(field("Activity name").props.value).toBe("Café walk");
    expect(text()).toContain("2026-08-15");
    pending.resolve(Response.json({ error: "Lost response." }, { status: 503 }));
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("Café walk");
    expect(text()).not.toContain("Your Add draft contains details.");
  });

  it.each(["date", "external-route", "owner-route", "logout", "unmount", "effect-replay"] as const)(
    "invalidates pending reuse and retained fields after %s",
    async (transition) => {
      let ownerChanged = false;
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        if (url === "/api/auth/me" && ownerChanged) return Response.json(session(anotherOwner));
        return base(url, init);
      });
      await mount(fetch);
      await change("Activity name", "  retained draft  ");
      await click("Reuse details from Café walk");
      const keep = button("Keep editing");
      const replace = button("Replace draft with saved details");
      const oldField = field("Activity name");
      const oldSubmit = addForm();
      const oldPreset = button("15 min");
      if (transition === "date") await click("Next day");
      else if (transition === "external-route" || transition === "owner-route") {
        ownerChanged = transition === "owner-route";
        routeDate = "2026-08-16";
        hooks.renderWithoutEffects();
        expect(button("Replace draft with saved details").props.disabled).toBe(true);
        invoke(button("Replace draft with saved details"));
      } else if (transition === "logout") await click("Sign out");
      else if (transition === "unmount") hooks.unmount();
      else {
        hooks.replayEffects();
        await hooks.settle();
      }
      const requests = fetch.mock.calls.length;
      const before = text();
      invoke(keep);
      invoke(replace);
      invoke(oldField, "onChange", { target: { value: "Stale owner data" } });
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      invoke(oldPreset);
      if (transition !== "external-route" && transition !== "owner-route") await hooks.settle();
      expect(text()).toBe(before);
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(hooks.afterClose()).toBe(0);
      if (transition === "external-route" || transition === "owner-route") {
        hooks.render();
        await hooks.settle();
        expect(field("Activity name").props.value).toBe(
          transition === "owner-route" ? "" : "  retained draft  ",
        );
        expect(text()).not.toContain("Your Add draft contains details.");
      }
      if (transition === "date" || transition === "effect-replay")
        expect(field("Activity name").props.value).toBe("  retained draft  ");
      if (transition === "logout") expect(field("Activity name").props.value).toBe("");
    },
  );

  it.each(["accepted", "expired"] as const)(
    "ignores an old %s write receipt across an external route before effects",
    async (outcome) => {
      const pending = deferred<Response>();
      const base = fetcher();
      let sentBody: Record<string, unknown> = {};
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sentBody = JSON.parse(String(init.body));
          return pending.promise;
        }
        return base(url, init);
      });
      await mount(fetch);
      await change("Local time", "10:15");
      await click("Reuse details from Café walk");
      invoke(addForm(), "onSubmit", { preventDefault() {} });
      await hooks.settle();
      routeDate = "2026-08-16";
      hooks.renderWithoutEffects();
      const requests = fetch.mock.calls.length;
      pending.resolve(
        outcome === "accepted"
          ? Response.json(receipt(sentBody))
          : Response.json({}, { status: 401 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
      hooks.render();
      await hooks.settle();
      expect(field("Activity name").props.value).toBe("Café walk");
      expect(field("Activity name").props.disabled).toBe(false);
    },
  );

  it("does not let an older accepted receipt clear a newer reused draft or release its pending Add", async () => {
    const oldReceipt = deferred<Response>();
    const newReceipt = deferred<Response>();
    const newSource = {
      ...original,
      id: "5bcfa2bf-4950-43f7-9f24-b983ac803012",
      name: "New day walk",
      localDate: "2026-08-16",
      occurredAt: "2026-08-16T13:05:01.000Z",
      createdAt: "2026-08-16T13:05:02.000Z",
    };
    const base = fetcher();
    const writes: RequestInit[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return writes.length === 1 ? oldReceipt.promise : newReceipt.promise;
      }
      if (url.startsWith("/api/activities?") && url.includes("2026-08-16"))
        return Response.json(day([newSource], "2026-08-16"));
      return base(url, init);
    });
    await mount(fetch);
    await change("Local time", "10:15");
    await click("Reuse details from Café walk");
    invoke(addForm(), "onSubmit", { preventDefault() {} });
    await hooks.settle();
    routeDate = "2026-08-16";
    hooks.render();
    await hooks.settle();
    await click("Reuse details from New day walk");
    await click("Replace draft with saved details");
    invoke(addForm(), "onSubmit", { preventDefault() {} });
    await hooks.settle();
    const requests = fetch.mock.calls.length;
    oldReceipt.resolve(Response.json(receipt(JSON.parse(String(writes[0]?.body)))));
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("New day walk");
    expect(button("Adding…").props.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(requests);
    newReceipt.resolve(Response.json({ error: "Lost response." }, { status: 503 }));
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("New day walk");
    expect(text()).toContain("Retry to safely reuse the same operation.");
  });

  it("ignores a pending write receipt after unmount without private state updates", async () => {
    const pending = deferred<Response>();
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? pending.promise : base(url, init),
    );
    await mount(fetch);
    await click("Reuse details from Café walk");
    invoke(addForm(), "onSubmit", { preventDefault() {} });
    await hooks.settle();
    hooks.unmount();
    const calls = fetch.mock.calls.length;
    pending.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    expect(hooks.afterClose()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });

  it.each(["ACTIVITY_OWNER_CHANGED", "expired"])(
    "closes and clears reused private fields on %s",
    async (failure) => {
      const base = fetcher();
      const fetch = vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ code: failure }, { status: failure === "expired" ? 401 : 409 })
          : base(url, init),
      );
      await mount(fetch);
      await click("Reuse details from Café walk");
      const oldSubmit = addForm();
      const reuse = button("Reuse details from Café walk");
      await submit();
      const calls = fetch.mock.calls.length;
      invoke(oldSubmit, "onSubmit", { preventDefault() {} });
      invoke(reuse);
      await hooks.settle();
      expect(field("Activity name").props.value).toBe("");
      expect(text()).not.toContain("35 min");
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(fetch).toHaveBeenCalledTimes(calls);
    },
  );
});

describe("activity reuse pending read ownership", () => {
  it.each(["data", "expired"] as const)(
    "ignores an old %s day response after the external route renders",
    async (outcome) => {
      const pending = deferred<Response>();
      const base = fetcher();
      const fetch = vi.fn((url: string, init?: RequestInit) =>
        url.startsWith("/api/activities?") && url.includes("2026-08-15")
          ? pending.promise
          : base(url, init),
      );
      await mount(fetch);
      routeDate = "2026-08-16";
      hooks.renderWithoutEffects();
      const calls = fetch.mock.calls.length;
      pending.resolve(
        outcome === "data" ? Response.json(day()) : Response.json({}, { status: 401 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(router.replace).not.toHaveBeenCalledWith("/login");
      hooks.render();
      await hooks.settle();
      expect(text()).not.toContain("Café walk");
      expect(text()).toContain("2026-08-16");
    },
  );

  it("keeps draft ownership across overlapping route verifications and clears details for the replacement owner", async () => {
    const intermediateAuth = deferred<Response>();
    let authReads = 0;
    const base = fetcher();
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/auth/me") {
        authReads += 1;
        if (authReads === 2) return intermediateAuth.promise;
        return Promise.resolve(Response.json(session(authReads >= 3 ? anotherOwner : owner)));
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Activity name", "Private first-owner draft");
    routeDate = "2026-08-16";
    hooks.render();
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("");
    routeDate = "2026-08-17";
    hooks.render();
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("");
    const calls = fetch.mock.calls.length;
    intermediateAuth.resolve(Response.json(session()));
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("");
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(
      fetch.mock.calls
        .filter(([url]) => url.startsWith("/api/activities?"))
        .map(([, init]) => new Headers(init?.headers).get("x-expected-owner-user-id")),
    ).toEqual([owner, anotherOwner]);
  });
});

describe("Activity Add duration presets", () => {
  it.each([
    [15, null],
    [30, "0.001"],
    [60, "248.5"],
  ] as const)(
    "replaces duration with %i minutes, preserves %s calories and only creates after Add",
    async (minutes, energy) => {
      const fixture = day();
      const originalBytes = JSON.stringify(fixture);
      const base = fetcher(fixture);
      const writes: RequestInit[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(JSON.parse(String(init.body))));
        }
        return base(url, init);
      });
      await mount(fetch);
      await change("Activity name", "Evening walk");
      await change("Duration (minutes)", "42");
      await change("Self-reported calories (optional)", energy ?? "");
      await change("Local time", "10:15");
      const requests = fetch.mock.calls.length;
      await click(`${minutes} min`);
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(field("Duration (minutes)").props.value).toBe(String(minutes));
      expect(field("Activity name").props.value).toBe("Evening walk");
      expect(field("Self-reported calories (optional)").props.value).toBe(energy ?? "");
      expect(field("Local time").props.value).toBe("10:15");
      expect(text()).toContain(`${minutes} minutes selected.`);
      expect(text()).toContain("35 min");
      for (const value of [15, 30, 60]) {
        expect(button(`${value} min`).props.type).toBe("button");
        expect(button(`${value} min`).props["aria-pressed"]).toBe(value === minutes);
        expect(button(`${value} min`).props["aria-describedby"]).toBe(
          "activity-duration-preset-help",
        );
      }
      await submit();
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.body))).toEqual({
        name: "Evening walk",
        durationMinutes: minutes,
        selfReportedEnergyKilocalories: energy,
        occurredAt: "2026-08-15T15:15:00.000Z",
      });
      expect(JSON.stringify(fixture)).toBe(originalBytes);
    },
  );

  it("allows a custom whole-minute duration after presets with no shortcut selected", async () => {
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return Response.json(receipt(JSON.parse(String(init.body))));
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Activity name", "Custom walk");
    await click("15 min");
    await click("60 min");
    await change("Duration (minutes)", "47");
    for (const minutes of [15, 30, 60])
      expect(button(`${minutes} min`).props["aria-pressed"]).toBe(false);
    expect(text()).not.toContain("minutes selected.");
    await submit();
    expect(JSON.parse(String(writes[0]?.body)).durationMinutes).toBe(47);
  });

  it("keeps same-current preset and duration field callbacks usable immediately before Add", async () => {
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return Response.json(receipt(JSON.parse(String(init.body))));
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Activity name", "Walk");
    await click("30 min");
    const form = addForm();
    invoke(button("30 min"));
    invoke(button("30 min"));
    invoke(field("Duration (minutes)"), "onChange", { target: { value: "30" } });
    invoke(form, "onSubmit", { preventDefault() {} });
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.body)).durationMinutes).toBe(30);
  });

  it("fences pre-preset Add, field, date and preset callbacks before paint", async () => {
    const fetch = await mount();
    await change("Activity name", "Current name");
    await change("Local time", "10:15");
    const oldForm = addForm();
    const oldFields = elements(addForm()).filter(
      (node) => typeof node.props.onChange === "function",
    );
    const oldPreset = button("60 min");
    const oldDate = button("Next day");
    const requests = fetch.mock.calls.length;
    invoke(button("15 min"));
    for (const input of oldFields) invoke(input, "onChange", { target: { value: "stale" } });
    invoke(oldForm, "onSubmit", { preventDefault() {} });
    invoke(oldPreset);
    invoke(oldDate);
    await hooks.settle();
    expect(field("Duration (minutes)").props.value).toBe("15");
    expect(field("Activity name").props.value).toBe("Current name");
    expect(field("Local time").props.value).toBe("10:15");
    expect(text()).toContain("2026-08-15");
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("preserves a reuse choice on same-current preset and invalidates it on a changed duration", async () => {
    const fetch = await mount();
    await change("Activity name", "Keep raw draft");
    await click("15 min");
    await click("Reuse details from Café walk");
    const keep = button("Keep editing");
    const replace = button("Replace draft with saved details");
    const requests = fetch.mock.calls.length;
    await click("15 min");
    expect(button("Keep editing")).toBe(keep);
    expect(text()).toContain("Your Add draft contains details.");
    await click("30 min");
    expect(text()).not.toContain("Your Add draft contains details.");
    invoke(keep);
    invoke(replace);
    await hooks.settle();
    expect(field("Activity name").props.value).toBe("Keep raw draft");
    expect(field("Duration (minutes)").props.value).toBe("30");
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it.each([false, true])(
    "preserves default fold unless the same local minute is explicitly edited: %s",
    async (editTime) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
      routeDate = "2026-11-01";
      const base = fetcher(day([], routeDate));
      const writes: RequestInit[] = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json(receipt(JSON.parse(String(init.body))));
        }
        return base(url, init);
      });
      await mount(fetch);
      expect(field("Local time").props.value).toBe("01:30");
      await change("Activity name", "Fold walk");
      await click("15 min");
      await click("60 min");
      if (editTime) {
        await change("Local time", "01:30");
        await submit();
        expect(writes).toHaveLength(0);
        await click("Add activity Earlier occurrence · UTC−05:00");
      }
      await submit();
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.body)).occurredAt).toBe(
        editTime ? "2026-11-01T06:30:00.000Z" : "2026-11-01T07:30:45.123Z",
      );
    },
  );

  it("preserves independent row Edit values and keeps preset controls confined to Add", async () => {
    const fetch = await mount();
    await change("Activity name", "Add draft");
    await change("Self-reported calories (optional)", "0.001");
    await click("Edit activity");
    const editor = () =>
      elements().find((node) => node.type === "form" && node.props.className === "activityEditor");
    await change("Duration (minutes)", "49", editor());
    const before = elements(editor())
      .filter((node) => node.type === "input")
      .map((node) => node.props.value);
    const requests = fetch.mock.calls.length;
    await click("30 min");
    expect(
      elements(editor())
        .filter((node) => node.type === "input")
        .map((node) => node.props.value),
    ).toEqual(before);
    expect(field("Duration (minutes)").props.value).toBe("30");
    expect(field("Activity name").props.value).toBe("Add draft");
    expect(field("Self-reported calories (optional)").props.value).toBe("0.001");
    expect(
      elements(editor()).some(
        (node) => node.props["aria-describedby"] === "activity-duration-preset-help",
      ),
    ).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("preserves existing body A-to-B-to-A retry identity and unchanged preset replay", async () => {
    const writes: RequestInit[] = [];
    const base = fetcher();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return Response.json({ error: "Lost response" }, { status: 503 });
      }
      return base(url, init);
    });
    await mount(fetch);
    await change("Activity name", "Retry walk");
    await change("Local time", "10:15");
    await click("30 min");
    await submit();
    for (const duration of ["30 min", "60 min", "30 min"]) {
      expect(button(duration).props.disabled).toBe(true);
      await click("Retry day view");
      const reads = fetch.mock.calls.length;
      await click(duration);
      expect(fetch).toHaveBeenCalledTimes(reads);
      await submit();
    }
    expect(writes).toHaveLength(4);
    const keys = writes.map((write) => new Headers(write.headers).get("idempotency-key"));
    expect(writes[1]?.body).toBe(writes[0]?.body);
    expect(writes[3]?.body).toBe(writes[0]?.body);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[3]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("blocks presets synchronously during a write and keeps accepted-read recovery intact", async () => {
    const base = fetcher();
    const pending = deferred<Response>();
    let failRead = false;
    const writes: RequestInit[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(init);
        return pending.promise;
      }
      if (url.startsWith("/api/activities?") && failRead)
        return Response.json({ error: "Read unavailable" }, { status: 503 });
      return base(url, init);
    });
    await mount(fetch);
    await change("Activity name", "Saved walk");
    await click("15 min");
    const oldPreset = button("60 min");
    invoke(addForm(), "onSubmit", { preventDefault() {} });
    invoke(oldPreset);
    await hooks.settle();
    expect(writes).toHaveLength(1);
    expect(field("Duration (minutes)").props.value).toBe("15");
    for (const duration of [15, 30, 60])
      expect(button(`${duration} min`).props.disabled).toBe(true);
    failRead = true;
    pending.resolve(Response.json(receipt(JSON.parse(String(writes[0]?.body)))));
    await hooks.settle();
    expect(field("Duration (minutes)").props.value).toBe("");
    expect(button("15 min").props.disabled).toBe(true);
    invoke(oldPreset);
    await hooks.settle();
    expect(field("Duration (minutes)").props.value).toBe("");
    failRead = false;
    await click("Retry day view");
    expect(button("15 min").props.disabled).toBe(false);
    expect(writes).toHaveLength(1);
  });
});

const foldEntry = {
  ...original,
  occurredAt: "2026-11-01T06:30:45.123Z",
  localDate: "2026-11-01",
  localTime: "01:30:45.123",
  createdAt: "2026-11-01T06:30:46.000Z",
};
function editor() {
  const found = elements().find(
    (node) => node.type === "form" && node.props.className === "activityEditor",
  );
  if (!found) throw new Error("Missing activity editor");
  return found;
}
async function submitEdit() {
  invoke(editor(), "onSubmit", { preventDefault() {} });
  await hooks.settle();
}
function occurrenceFetcher(fixture = day([foldEntry], "2026-11-01")) {
  const writes: RequestInit[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      writes.push(init);
      return Response.json({ error: "Response uncertain" }, { status: 503 });
    }
    if (url === "/api/auth/me") return Response.json(session(owner, fixture.data.timeZone));
    const date = new URL(url, "https://app.example.test").searchParams.get("date");
    return Response.json(
      date === fixture.data.localDate ? fixture : day([], date ?? routeDate, fixture.data.timeZone),
    );
  });
  return { fetch, writes };
}
async function fillFoldAdd() {
  await change("Activity name", "Fold walk");
  await change("Duration (minutes)", "30");
  await change("Local time", "01:30");
}

describe("web activity explicit time choices", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T18:00:45.123Z"));
    routeDate = "2026-11-01";
  });
  it.each([
    ["Earlier", "UTC−05:00", "2026-11-01T06:30:00.000Z"],
    ["Later", "UTC−06:00", "2026-11-01T07:30:00.000Z"],
  ] as const)(
    "requires then submits the %s Add occurrence with the current profile guard",
    async (label, offset, instant) => {
      const { fetch, writes } = occurrenceFetcher();
      await mount(fetch);
      await fillFoldAdd();
      await submit();
      expect(writes).toHaveLength(0);
      expect(text()).toContain("Choose the earlier or later occurrence");
      expect(text()).toContain("seconds become zero");
      await click(`Add activity ${label} occurrence · ${offset}`);
      expect(button(`Add activity ${label} occurrence · ${offset}`).props["aria-pressed"]).toBe(
        true,
      );
      await submit();
      expect(writes).toHaveLength(1);
      expect(JSON.parse(String(writes[0]?.body)).occurredAt).toBe(instant);
      expect(writes[0]?.headers).toMatchObject({
        "x-expected-profile-time-zone": "America/Chicago",
        "x-expected-owner-user-id": owner,
      });
    },
  );

  it("offers non-hour offsets and rejects nonexistent minutes before any request", async () => {
    routeDate = "2026-04-05";
    const { fetch, writes } = occurrenceFetcher(day([], routeDate, "Australia/Lord_Howe"));
    await mount(fetch);
    await change("Activity name", "Island walk");
    await change("Duration (minutes)", "30");
    await change("Local time", "01:45");
    expect(button("Add activity Earlier occurrence · UTC+11:00").props["aria-pressed"]).toBe(false);
    await click("Add activity Later occurrence · UTC+10:30");
    await submit();
    expect(JSON.parse(String(writes[0]?.body)).occurredAt).toBe("2026-04-04T15:15:00.000Z");
    hooks.unmount();
    routeDate = "2026-03-08";
    const gap = occurrenceFetcher(day([], routeDate));
    await mount(gap.fetch);
    await change("Activity name", "Gap walk");
    await change("Duration (minutes)", "30");
    await change("Local time", "02:30");
    await submit();
    expect(gap.writes).toHaveLength(0);
    expect(text()).toContain("does not exist");
  });

  it("corrects to the later occurrence of the same minute with exact original revision", async () => {
    const { fetch, writes } = occurrenceFetcher();
    await mount(fetch);
    await click("Edit activity");
    await click("Edit activity Later occurrence · UTC−06:00");
    await submitEdit();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.body))).toEqual({ occurredAt: "2026-11-01T07:30:00.000Z" });
    expect(writes[0]?.headers).toMatchObject({
      "if-match": '"2"',
      "x-expected-profile-time-zone": "America/Chicago",
    });
  });

  it("preserves saved fractional precision and its original zone for metadata-only edits", async () => {
    const { fetch, writes } = occurrenceFetcher(day([foldEntry], routeDate, "America/New_York"));
    await mount(fetch);
    await click("Edit activity");
    await change("Duration (minutes)", "36", editor());
    await submitEdit();
    expect(JSON.parse(String(writes[0]?.body))).toEqual({ durationMinutes: 36 });
    expect(writes[0]?.headers).not.toHaveProperty("x-expected-profile-time-zone");
    expect(foldEntry.occurredAt).toBe("2026-11-01T06:30:45.123Z");
  });

  it("retains Add choice through reuse and ignores superseded choice callbacks before render", async () => {
    const { fetch, writes } = occurrenceFetcher();
    await mount(fetch);
    await change("Local time", "01:30");
    const earlier = button("Add activity Earlier occurrence · UTC−05:00");
    const later = button("Add activity Later occurrence · UTC−06:00");
    invoke(later);
    invoke(earlier);
    invoke(later);
    await hooks.settle();
    expect(button("Add activity Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(true);
    await click("Reuse details from Café walk");
    expect(button("Add activity Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(true);
    await submit();
    expect(JSON.parse(String(writes[0]?.body))).toMatchObject({
      name: "Café walk",
      occurredAt: "2026-11-01T07:30:00.000Z",
    });
  });

  it.each(["Add", "Edit"] as const)(
    "clears %s choices on coordinate edits and rejects stale callbacks after reverting",
    async (mode) => {
      const { fetch, writes } = occurrenceFetcher();
      await mount(fetch);
      if (mode === "Add") await fillFoldAdd();
      else await click("Edit activity");
      const scope = () => (mode === "Add" ? addForm() : editor());
      const label = `${mode} activity Later occurrence · UTC−06:00`;
      await click(label);
      const stale = button(label);
      await change("Local time", "01:45", scope());
      invoke(stale);
      await hooks.settle();
      expect(button(label).props["aria-pressed"]).toBe(false);
      await change("Local time", "01:30", scope());
      invoke(stale);
      await hooks.settle();
      expect(button(label).props["aria-pressed"]).toBe(false);
      if (mode === "Add") await submit();
      else await submitEdit();
      expect(writes).toHaveLength(0);
    },
  );

  it.each(["Add", "Edit"] as const)(
    "keeps the exact %s occurrence body and operation identity through an uncertain response and same-context reload",
    async (mode) => {
      const { fetch, writes } = occurrenceFetcher();
      await mount(fetch);
      if (mode === "Add") await fillFoldAdd();
      else await click("Edit activity");
      await click(`${mode} activity Later occurrence · UTC−06:00`);
      if (mode === "Add") await submit();
      else await submitEdit();
      expect(writes).toHaveLength(1);
      await click("Retry day view");
      expect(button(`${mode} activity Later occurrence · UTC−06:00`).props["aria-pressed"]).toBe(
        true,
      );
      if (mode === "Add") await submit();
      else await submitEdit();
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toBe(writes[0]?.body);
      expect(writes[1]?.headers).toEqual(writes[0]?.headers);
    },
  );

  it.each(["date", "route", "logout", "unmount", "effect-replay"] as const)(
    "fences a retained Add choice across %s",
    async (transition) => {
      const { fetch, writes } = occurrenceFetcher();
      await mount(fetch);
      await fillFoldAdd();
      const stale = button("Add activity Later occurrence · UTC−06:00");
      if (transition === "date") invoke(button("Next day"));
      if (transition === "route") {
        routeDate = "2026-11-02";
        hooks.renderWithoutEffects();
      }
      if (transition === "logout") {
        fetch.mockImplementationOnce(async () => new Response(null, { status: 204 }));
        invoke(button("Sign out"));
      }
      if (transition === "unmount") hooks.unmount();
      if (transition === "effect-replay") hooks.replayEffects();
      invoke(stale);
      await hooks.settle();
      expect(writes).toHaveLength(0);
      expect(hooks.afterClose()).toBe(0);
      expect(
        elements()
          .filter(
            (node) => node.props["aria-label"] === "Add activity Later occurrence · UTC−06:00",
          )
          .every((node) => node.props["aria-pressed"] !== true),
      ).toBe(true);
    },
  );

  it("retires selected occurrences on loaded-zone conflict refresh", async () => {
    const { fetch, writes } = occurrenceFetcher();
    const base = fetch.getMockImplementation();
    let changed = false;
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        writes.push(init);
        changed = true;
        return Response.json({ code: "ACTIVITY_TIME_ZONE_CHANGED" }, { status: 409 });
      }
      if (changed && url.startsWith("/api/activities?"))
        return Response.json(day([foldEntry], routeDate, "America/New_York"));
      if (!base) throw new Error("Missing fixture implementation");
      return base(url, init);
    });
    await mount(fetch);
    await fillFoldAdd();
    await click("Add activity Later occurrence · UTC−06:00");
    const old = button("Add activity Later occurrence · UTC−06:00");
    await submit();
    invoke(old);
    await hooks.settle();
    expect(text()).toContain("Your profile time zone changed");
    await change("Local time", "01:30");
    expect(button("Add activity Earlier occurrence · UTC−04:00").props["aria-pressed"]).toBe(false);
    expect(button("Add activity Later occurrence · UTC−05:00").props["aria-pressed"]).toBe(false);
    await submit();
    expect(writes).toHaveLength(1);
  });

  it("retires an edit choice after a date change or Cancel without allowing old callbacks to modify the reopened edit", async () => {
    const { fetch, writes } = occurrenceFetcher();
    await mount(fetch);
    await click("Edit activity");
    await click("Edit activity Later occurrence · UTC−06:00");
    const oldDateChoice = button("Edit activity Later occurrence · UTC−06:00");
    await change("Local date", "2026-11-02", editor());
    invoke(oldDateChoice);
    await hooks.settle();
    await change("Local date", "2026-11-01", editor());
    invoke(oldDateChoice);
    await hooks.settle();
    expect(button("Edit activity Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(false);
    const oldCancelChoice = button("Edit activity Later occurrence · UTC−06:00");
    invoke(button("Cancel"));
    invoke(oldCancelChoice);
    await hooks.settle();
    await click("Edit activity");
    invoke(oldCancelChoice);
    await hooks.settle();
    expect(button("Edit activity Later occurrence · UTC−06:00").props["aria-pressed"]).toBe(false);
    await submitEdit();
    expect(writes).toHaveLength(0);
    await click("Edit activity Later occurrence · UTC−06:00");
    await submitEdit();
    expect(JSON.parse(String(writes[0]?.body))).toEqual({ occurredAt: "2026-11-01T07:30:00.000Z" });
  });

  it("keeps controls live when the current occurrence is reselected", async () => {
    const { fetch, writes } = occurrenceFetcher();
    await mount(fetch);
    await fillFoldAdd();
    await click("Add activity Later occurrence · UTC−06:00");
    const current = button("Add activity Later occurrence · UTC−06:00");
    const earlier = button("Add activity Earlier occurrence · UTC−05:00");
    invoke(current);
    invoke(earlier);
    await hooks.settle();
    await submit();
    expect(JSON.parse(String(writes[0]?.body)).occurredAt).toBe("2026-11-01T06:30:00.000Z");
  });
});
