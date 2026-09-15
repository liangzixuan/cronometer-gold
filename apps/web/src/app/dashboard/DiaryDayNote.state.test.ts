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
  let commit: (() => void) | null = null;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((item, index) => Object.is(item, b[index]));
  const render = (runEffects = true) => {
    cursor = 0;
    dirty = false;
    tree = component();
    commit?.();
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
      commit = null;
      render();
    },
    replaceVerifiedSessionBeforeEffects(next: unknown) {
      const slot = slots.find(
        (candidate) =>
          candidate.value &&
          typeof candidate.value === "object" &&
          "user" in candidate.value &&
          "profile" in candidate.value,
      );
      if (!slot) throw new Error("No verified session state to replace.");
      slot.value = next;
      render(false);
    },
    observeCommit(callback: () => void) {
      commit = callback;
      commit();
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

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));

import type { DayNoteOperation } from "../../lib/day-notes";
import {
  mutationFixture,
  noteDate,
  noteFixture,
  noteOwner,
  noteResponse,
  noteSession,
  otherNoteOwner,
} from "../../lib/day-notes.test-fixtures";
import { parseSession } from "../../lib/diary";
import { DiaryDayNote, type DiaryDayNoteProps } from "./DiaryDayNote";

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
function field(): Element {
  const result = nodes().find((node) => node.type === "textarea");
  if (!result) throw new Error("Missing note textarea");
  return result;
}
function invoke(node: Element, action = "onClick", ...args: unknown[]) {
  return (node.props[action] as (...args: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  invoke(button(label));
  await hooks.settle();
}
async function change(value: string) {
  invoke(field(), "onChange", { currentTarget: { value } });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
let props: DiaryDayNoteProps;
let privateOpen = true;
let viewCurrent = true;
const expired = vi.fn();
const returned = vi.fn();
const lifecycle = {
  visibility: "visible",
  document: new Map<string, () => void>(),
  window: new Map<string, () => void>(),
};
type RequestCall = { readonly url: string; readonly init: RequestInit };
let calls: RequestCall[];
let head = noteFixture();
let put: (call: RequestCall) => Promise<Response>;
let read: (call: RequestCall) => Promise<Response>;
function operationFrom(call: RequestCall): DayNoteOperation {
  const headers = new Headers(call.init.headers);
  const revision = (headers.get("if-match") ?? "").slice(1, -1);
  return {
    url: call.url,
    serializedBody: String(call.init.body),
    headers: Object.fromEntries(headers),
    identity: {
      operationId: headers.get("idempotency-key") ?? "",
      ownerUserId: headers.get("x-expected-owner-user-id") ?? "",
      localDate: call.url.split("/").at(-1) ?? "",
      expectedRevision: revision,
      expectedProfileTimeZone: headers.get("x-expected-profile-time-zone") ?? "",
      note: JSON.parse(String(call.init.body)).note,
      noteId: revision === "0" ? null : head.id,
    },
  };
}
const puts = () => calls.filter((call) => call.init.method === "PUT");
async function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, init };
      calls.push(call);
      if (init.method === "PUT") return put(call);
      return read(call);
    }),
  );
  hooks.mount(() => DiaryDayNote(props));
  await hooks.settle();
}
async function navigate(date: string, effects = true) {
  props = { ...props, localDate: date };
  hooks.render(effects);
  if (effects) await hooks.settle();
}
function observeCommittedNoteFocus() {
  const attempts: boolean[] = [];
  let focused = false;
  const input = {
    disabled: true,
    focus() {
      attempts.push(this.disabled);
      // Browsers ignore focus on a disabled textarea.
      if (!this.disabled) focused = true;
    },
  };
  hooks.observeCommit(() => {
    const node = nodes().find((item) => item.type === "textarea");
    if (!node) return;
    input.disabled = Boolean(node.props.disabled);
    (node.props.ref as { current: unknown }).current = input;
  });
  return { input, attempts, focused: () => focused };
}
async function prepareReviewedFocusConflict() {
  head = noteFixture("initial saved", "4");
  put = async () => Response.json({ code: "DAY_NOTE_REVISION_CONFLICT" }, { status: 412 });
  await mount();
  await change(" exact raw\r\n ");
  await click("Save note");
  head = noteFixture("reviewed saved", "5");
  await click("Review current note");
  return observeCommittedNoteFocus();
}
beforeEach(() => {
  calls = [];
  head = noteFixture();
  privateOpen = true;
  viewCurrent = true;
  expired.mockReset();
  returned.mockReset();
  props = {
    session: parseSession(noteSession()),
    localDate: noteDate,
    privateGeneration: 0,
    isPrivateCurrent: () => privateOpen,
    isViewCurrent: () => viewCurrent,
    onUnauthorized: expired,
    onReturn: returned,
  };
  lifecycle.visibility = "visible";
  lifecycle.document.clear();
  lifecycle.window.clear();
  vi.stubGlobal("document", {
    get visibilityState() {
      return lifecycle.visibility;
    },
    addEventListener: (name: string, fn: () => void) => lifecycle.document.set(name, fn),
    removeEventListener: (name: string) => lifecycle.document.delete(name),
  });
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: () => void) => lifecycle.window.set(name, fn),
    removeEventListener: (name: string) => lifecycle.window.delete(name),
  });
  read = async (call) =>
    call.url === "/api/diary/day-notes/profile"
      ? Response.json(noteSession())
      : noteResponse(
          call.url.endsWith(head.localDate)
            ? head
            : noteFixture(null, "0", call.url.split("/").at(-1), props.session.user.id),
        );
  put = async (call) => {
    const result = mutationFixture(operationFrom(call));
    head = result.data.note;
    return Response.json(result, { headers: { etag: `"${head.revision}"` } });
  };
});
afterEach(() => {
  hooks.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("actual web day-note state transitions", () => {
  it("loads a virgin empty day independently and makes unchanged Save/Clear/Cancel true no-ops", async () => {
    await mount();
    expect(text()).toContain("No day note saved yet.");
    expect(field().props.value).toBe("");
    expect(field().props.disabled).toBe(false);
    const before = calls.length;
    invoke(button("Save note"));
    invoke(button("Clear and save note"));
    invoke(button("Cancel note draft"));
    expect(calls.length).toBe(before);
    expect(puts()).toHaveLength(0);
    expect(calls.map((call) => call.url)).toEqual([`/api/diary/day-notes/${noteDate}`]);
  });
  it("preserves exact whitespace/Unicode through explicit Save then positive-revision Clear, without diary requests", async () => {
    await mount();
    const raw = "  e\u0301\r\n\t😀  ";
    await change(raw);
    expect(field().props.value).toBe(raw);
    await click("Save note");
    expect(head.note).toBe(raw);
    expect(head.revision).toBe("1");
    expect(puts()[0]?.init.body).toBe(JSON.stringify({ note: raw }));
    await click("Clear and save note");
    expect(head.note).toBeNull();
    expect(head.revision).toBe("2");
    expect(puts()[1]?.init.body).toBe('{"note":null}');
    expect(text()).toContain("Current saved state checked");
    expect(calls.every((call) => call.url.startsWith("/api/diary/day-notes/"))).toBe(true);
  });
  it.each(["x".repeat(2001), "😀".repeat(2001), "nul\u0000", "\ud800"])(
    "preserves invalid raw draft but prevents any write",
    async (raw) => {
      await mount();
      await change(raw);
      const before = calls.length;
      expect(field().props.value).toBe(raw);
      expect(button("Save note").props.disabled).toBe(true);
      invoke(button("Save note"));
      expect(calls.length).toBe(before);
      expect(text()).toContain("Use up to 2,000 characters");
      await click("Cancel note draft");
      expect(field().props.value).toBe("");
    },
  );
  it("accepts two thousand astral scalars without using an HTML UTF16 maxLength", async () => {
    await mount();
    await change("😀".repeat(2000));
    expect(field().props.maxLength).toBeUndefined();
    expect(button("Save note").props.disabled).toBe(false);
    await click("Save note");
    expect(head.note).toBe("😀".repeat(2000));
  });
  it.each(["503", "malformed", "mismatch", "transport", "idempotency-conflict"])(
    "preserves exact unresolved request across minute/date/profile changes after %s",
    async (failure) => {
      let attempts = 0;
      put = async (call) => {
        const op = operationFrom(call);
        const result = mutationFixture(op, attempts > 0);
        if (attempts++ === 0) {
          if (failure === "transport") throw new Error("offline");
          if (failure === "503") return Response.json({}, { status: 503 });
          if (failure === "idempotency-conflict")
            return Response.json({ code: "DAY_NOTE_IDEMPOTENCY_CONFLICT" }, { status: 409 });
          if (failure === "malformed") return new Response("broken", { status: 200 });
          result.data.receipt.operationId = "00000000-0000-4000-8000-000000000099";
          return Response.json(result, { headers: { etag: '"1"' } });
        }
        head = result.data.note;
        return Response.json(result, { headers: { etag: '"1"' } });
      };
      await mount();
      await change(" raw\r\n retry ");
      await click("Save note");
      const oldRetry = button("Retry note save");
      expect(field().props.disabled).toBe(true);
      expect(button("Cancel note draft").props.disabled).toBe(true);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-16T00:01:00Z"));
      props = { ...props, session: parseSession(noteSession(noteOwner, "America/New_York")) };
      await navigate("2026-09-16");
      invoke(oldRetry);
      expect(puts()).toHaveLength(1);
      expect(field().props.value).toBe(" raw\r\n retry ");
      await click("Retry note save");
      expect(puts()).toHaveLength(2);
      expect(puts()[1]).toEqual(puts()[0]);
      expect(expired).not.toHaveBeenCalled();
    },
  );
  it("fences two Save and Retry callbacks before paint to one in-flight request", async () => {
    const first = deferred<Response>();
    put = async () => first.promise;
    await mount();
    await change("draft");
    const save = button("Save note"),
      edit = field();
    invoke(save);
    invoke(save);
    invoke(edit, "onChange", { currentTarget: { value: "replace" } });
    expect(puts()).toHaveLength(1);
    await hooks.settle();
    expect(field().props.value).toBe("draft");
    first.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
    const retry = button("Retry note save");
    const next = deferred<Response>();
    put = async () => next.promise;
    invoke(retry);
    invoke(retry);
    expect(puts()).toHaveLength(2);
    next.resolve(Response.json({}, { status: 503 }));
    await hooks.settle();
  });
  it("retires accepted intent before read failure and retries only the note read", async () => {
    await mount();
    await change("saved");
    read = async () => Response.json({}, { status: 503 });
    await click("Save note");
    expect(puts()).toHaveLength(1);
    expect(text()).toContain("was acknowledged");
    expect(text()).not.toContain("Retry note save");
    read = async () => noteResponse(head);
    await click("Reload saved note");
    expect(puts()).toHaveLength(1);
    expect(field().props.value).toBe("saved");
  });
  it("reconciles a historical replay to a newer current head, never installing the old result", async () => {
    head = noteFixture("old", "4");
    put = async (call) => {
      const historical = mutationFixture(operationFrom(call), true);
      head = noteFixture("newer saved elsewhere", "9");
      return Response.json(historical, { headers: { etag: '"5"' } });
    };
    await mount();
    await change("my old request");
    await click("Save note");
    expect(field().props.value).toBe("newer saved elsewhere");
    expect(text()).toContain("revision 9");
  });
  it.each([
    [412, "DAY_NOTE_REVISION_CONFLICT"],
    [409, "DAY_NOTE_TIME_ZONE_CHANGED"],
  ] as const)("requires explicit fresh review and rebase after %s %s", async (status, failure) => {
    head = noteFixture("old", "4");
    const normal = put;
    put = async () => Response.json({ code: failure }, { status });
    await mount();
    await change(" exact mine\r\n ");
    await click("Save note");
    expect(puts()).toHaveLength(1);
    expect(field().props.value).toBe(" exact mine\r\n ");
    expect(button("Save note").props.disabled).toBe(true);
    head = noteFixture("edited elsewhere", "8");
    read = async (call) =>
      call.url === "/api/diary/day-notes/profile"
        ? Response.json(noteSession(noteOwner, "America/New_York"))
        : noteResponse(head);
    await click("Review current note");
    expect(text()).toContain("edited elsewhere");
    await click("Keep my draft");
    expect(puts()).toHaveLength(1);
    expect(field().props.value).toBe(" exact mine\r\n ");
    put = normal;
    await click("Save note");
    const first = new Headers(puts()[0]?.init.headers),
      second = new Headers(puts()[1]?.init.headers);
    expect(second.get("if-match")).toBe('"8"');
    expect(second.get("x-expected-profile-time-zone")).toBe("America/New_York");
    expect(second.get("idempotency-key")).not.toBe(first.get("idempotency-key"));
  });
  it("invalidates a reviewed revision when navigation loads a newer saved note", async () => {
    head = noteFixture("initial", "4");
    put = async () => Response.json({ code: "DAY_NOTE_REVISION_CONFLICT" }, { status: 412 });
    await mount();
    await change("raw draft");
    await click("Save note");
    head = noteFixture("first review", "5");
    await click("Review current note");
    const oldKeep = button("Keep my draft");
    await navigate("2026-09-16");
    head = noteFixture("newer known head", "6");
    await navigate(noteDate);
    expect(nodes().some((node) => node.type === "button" && text(node) === "Keep my draft")).toBe(
      false,
    );
    invoke(oldKeep);
    expect(field().props.value).toBe("raw draft");
    expect(button("Save note").props.disabled).toBe(true);
    expect(puts()).toHaveLength(1);
    await click("Review current note");
    expect(text()).toContain("newer known head");
    await click("Keep my draft");
    expect(text()).toContain("next Save note replaces the saved text");
    expect(puts()).toHaveLength(1);
    await click("Save note");
    expect(new Headers(puts()[1]?.init.headers).get("if-match")).toBe('"6"');
  });
  it.each(["Keep my draft", "Use saved note"])(
    "%s focuses the textarea only after the enabling DOM commit",
    async (choice) => {
      const focus = await prepareReviewedFocusConflict();
      expect(focus.input.disabled).toBe(true);
      invoke(button(choice));
      expect(focus.focused()).toBe(false);
      expect(focus.input.disabled).toBe(true);
      await hooks.settle();
      expect(focus.input.disabled).toBe(false);
      expect(focus.focused()).toBe(true);
      expect(focus.attempts).toEqual([false]);
      expect(field().props.value).toBe(
        choice === "Keep my draft" ? " exact raw\r\n " : "reviewed saved",
      );
      expect(puts()).toHaveLength(1);
      hooks.render();
      await hooks.settle();
      expect(focus.attempts).toEqual([false]);
    },
  );
  it.each(["date", "private", "newer draft", "background"])(
    "discards queued recovery focus after %s supersedes the accepted state",
    async (boundary) => {
      const focus = await prepareReviewedFocusConflict();
      invoke(button("Keep my draft"));
      // Commit the enabled field, but defer the harness effect queue until the boundary.
      hooks.renderWithoutEffects();
      if (boundary === "date") await navigate("2026-09-16", false);
      else if (boundary === "private") {
        privateOpen = false;
        hooks.renderWithoutEffects();
      } else if (boundary === "newer draft") {
        invoke(field(), "onChange", { currentTarget: { value: "newer raw" } });
        hooks.renderWithoutEffects();
      } else {
        lifecycle.visibility = "hidden";
        lifecycle.document.get("visibilitychange")?.();
        hooks.renderWithoutEffects();
      }
      hooks.render();
      await hooks.settle();
      expect(focus.focused()).toBe(false);
      expect(focus.attempts).toEqual([]);
      if (boundary === "date") await navigate(noteDate);
      else if (boundary === "private") privateOpen = true;
      else if (boundary === "background") {
        lifecycle.visibility = "visible";
        lifecycle.document.get("visibilitychange")?.();
      }
      hooks.render();
      await hooks.settle();
      expect(focus.attempts).toEqual([]);
      expect(puts()).toHaveLength(1);
    },
  );
  it("uses a reviewed saved note only through explicit local draft discard", async () => {
    head = noteFixture("initial", "4");
    put = async () => Response.json({ code: "DAY_NOTE_REVISION_CONFLICT" }, { status: 412 });
    await mount();
    await change("raw draft");
    await click("Save note");
    head = noteFixture("current saved text", "5");
    await click("Review current note");
    await click("Use saved note");
    expect(field().props.value).toBe("current saved text");
    expect(button("Save note").props.disabled).toBe(true);
    expect(puts()).toHaveLength(1);
  });
  it("keeps one raw draft bound to its original date and returns without retargeting", async () => {
    await mount();
    await change("first date raw");
    await navigate("2026-09-16");
    expect(field().props.value).toBe("first date raw");
    expect(field().props.disabled).toBe(true);
    await click("Return to note date");
    expect(returned).toHaveBeenCalledWith(noteDate);
    await navigate(noteDate);
    expect(field().props.disabled).toBe(false);
    expect(field().props.value).toBe("first date raw");
    await click("Cancel note draft");
    expect(puts()).toHaveLength(0);
    expect(field().props.value).toBe("");
  });
  it("reloads when a delayed route becomes current and restores returned or cancelled drafts", async () => {
    head = noteFixture("saved original", "4");
    const raw = " exact draft\r\nwith spaces  ";
    const otherDate = "2026-09-16";
    const dateReads = (date: string) =>
      calls.filter((call) => call.url.endsWith(date) && call.init.method !== "PUT");
    await mount();
    await change(raw);
    const oldSave = button("Save note"),
      oldCancel = button("Cancel note draft"),
      oldField = field();

    // The parent updates its selected date before router search params catch up.
    viewCurrent = false;
    await navigate(otherDate);
    expect(field().props.disabled).toBe(true);
    expect(field().props.value).toBe(raw);
    viewCurrent = true;
    hooks.render();
    await hooks.settle();
    expect(text()).toContain(`Saved note for ${otherDate}: No current note.`);
    expect(dateReads(otherDate)).toHaveLength(1);
    hooks.render();
    await hooks.settle();
    expect(dateReads(otherDate)).toHaveLength(1);

    await click("Return to note date");
    expect(returned).toHaveBeenCalledWith(noteDate);
    viewCurrent = false;
    await navigate(noteDate);
    expect(field().props.disabled).toBe(true);
    viewCurrent = true;
    hooks.render();
    await hooks.settle();
    expect(field().props.disabled).toBe(false);
    expect(field().props.value).toBe(raw);
    expect(dateReads(noteDate)).toHaveLength(2);
    invoke(oldSave);
    invoke(oldCancel);
    invoke(oldField, "onChange", { currentTarget: { value: "stale replacement" } });
    await hooks.settle();
    expect(field().props.value).toBe(raw);
    expect(puts()).toHaveLength(0);

    viewCurrent = false;
    await navigate(otherDate);
    viewCurrent = true;
    hooks.render();
    await hooks.settle();
    expect(field().props.disabled).toBe(true);
    await click("Cancel note draft");
    expect(field().props.disabled).toBe(false);
    expect(field().props.value).toBe("");
    expect(text()).toContain("Note draft cancelled.");
    expect(dateReads(otherDate)).toHaveLength(2);
    expect(puts()).toHaveLength(0);
    await change("new date draft");
    expect(field().props.value).toBe("new date draft");
  });
  it("rejects raw ABA callbacks and old controls immediately on navigation before effects", async () => {
    await mount();
    await change("A");
    const save = button("Save note"),
      oldField = field();
    await change("B");
    await change("A");
    const before = calls.length;
    invoke(save);
    invoke(oldField, "onChange", { currentTarget: { value: "stale" } });
    expect(calls.length).toBe(before);
    const currentSave = button("Save note");
    await navigate("2026-09-16", false);
    invoke(currentSave);
    expect(calls.length).toBe(before);
    expect(field().props.value).toBe("A");
  });
  it.each(["read", "write"])(
    "ignores a previous owner %s401 before replacement effects",
    async (kind) => {
      const pending = deferred<Response>();
      if (kind === "read") read = async () => pending.promise;
      else put = async () => pending.promise;
      await mount();
      if (kind === "write") {
        await change("private old raw");
        invoke(button("Save note"));
      }
      props = {
        ...props,
        session: parseSession(noteSession(otherNoteOwner)),
        privateGeneration: 1,
      };
      hooks.renderWithoutEffects();
      pending.resolve(Response.json({}, { status: 401 }));
      await hooks.settle();
      expect(expired).not.toHaveBeenCalled();
      expect(text()).not.toContain("private old raw");
    },
  );
  it.each(["read", "write"])("closes private UI for a current owned %s401", async (kind) => {
    if (kind === "read") read = async () => Response.json({}, { status: 401 });
    else put = async () => Response.json({}, { status: 401 });
    await mount();
    if (kind === "write") {
      await change("draft");
      await click("Save note");
    }
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it("fences private closure and unmount before callbacks or pending result writes", async () => {
    const pending = deferred<Response>();
    put = async () => pending.promise;
    await mount();
    await change("raw");
    const save = button("Save note");
    privateOpen = false;
    invoke(save);
    expect(puts()).toHaveLength(0);
    privateOpen = true;
    invoke(save);
    expect(puts()).toHaveLength(1);
    hooks.unmount();
    pending.resolve(Response.json({}, { status: 401 }));
    await hooks.settle();
    invoke(save);
    expect(puts()).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
    expect(hooks.afterClose()).toBe(0);
  });
  it("preserves draft on background/return but fences callbacks retained across that transition", async () => {
    await mount();
    await change("raw");
    const oldSave = button("Save note");
    lifecycle.visibility = "hidden";
    lifecycle.document.get("visibilitychange")?.();
    invoke(oldSave);
    expect(puts()).toHaveLength(0);
    lifecycle.visibility = "visible";
    lifecycle.document.get("visibilitychange")?.();
    await hooks.settle();
    invoke(oldSave);
    expect(puts()).toHaveLength(0);
    expect(field().props.value).toBe("raw");
    await click("Save note");
    expect(puts()).toHaveLength(1);
  });
  it.each([404, 503])(
    "shows unavailable instead of virgin absence for old/unavailable API %s",
    async (status) => {
      read = async () => Response.json({}, { status });
      await mount();
      expect(field().props.disabled).toBe(true);
      expect(text()).toContain("could not be loaded");
      expect(text()).not.toContain("No day note saved yet");
      read = async () => noteResponse(noteFixture());
      await click("Retry note load");
      expect(field().props.disabled).toBe(false);
    },
  );
});
