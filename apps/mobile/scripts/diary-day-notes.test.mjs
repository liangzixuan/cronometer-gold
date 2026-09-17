import * as React from "react";
import { AppState } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiaryDayNote } from "../src/diary/DiaryDayNote";
import { resetDiaryGroups } from "../src/diary/diary";

vi.mock("../src/auth/operation-id", () => ({ newOperationId: vi.fn(() => crypto.randomUUID()) }));

const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
}));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: {}, digestStringAsync: vi.fn() }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event, listener) => {
      hooks.appListeners.add(listener);
      return { remove: () => hooks.appListeners.delete(listener) };
    },
  },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: vi.fn() },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));

// Exercise the actual screen's synchronous hook lifecycle without native host views.
// This deliberately does not claim concurrent React or signed-device rendering evidence.
function screenHarness(props) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let dirty = true;
  let tree;
  let unmounted = false;
  let writesAfterUnmount = 0;
  let stateWrites = 0;
  const sameDependencies = (left, right) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const harness = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [
        slot.value,
        (update) => {
          stateWrites += 1;
          if (unmounted) writesAfterUnmount += 1;
          const next = typeof update === "function" ? update(slot.value) : update;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!sameDependencies(slots[index]?.dependencies, dependencies)) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!sameDependencies(slots[index]?.dependencies, dependencies)) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value;
    },
    updateProps(next) {
      props = { ...props, ...next };
      dirty = true;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (sameDependencies(previous?.dependencies, dependencies)) return;
      slots[index] = { dependencies, effect, cleanup: previous?.cleanup };
      effects.push(() => {
        previous?.cleanup?.();
        slots[index].cleanup = effect();
      });
    },
    async settle() {
      for (let turn = 0; turn < 60; turn += 1) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          effects = [];
          hooks.current = harness;
          tree = DiaryDayNote(props);
          for (const effect of effects) effect();
        }
        await Promise.resolve();
      }
      expect(dirty).toBe(false);
      return tree;
    },
    renderWithoutEffects() {
      dirty = false;
      cursor = 0;
      effects = [];
      hooks.current = harness;
      tree = DiaryDayNote(props);
      return tree;
    },
    flushEffects() {
      for (const effect of effects) effect();
      effects = [];
    },
    replayEffects() {
      for (const slot of slots) slot.cleanup?.();
      for (const slot of slots) if (slot.effect) slot.cleanup = slot.effect();
      dirty = true;
    },
    get stateWrites() {
      return stateWrites;
    },
    get writesAfterUnmount() {
      return writesAfterUnmount;
    },
    unmount() {
      unmounted = true;
      for (const slot of slots) slot.cleanup?.();
      hooks.current = null;
    },
  };
  return harness;
}

const OWNER = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const OTHER = "b8a7c76f-3c1d-445c-9160-152e57b29e42";
const DAY = "2026-09-15";
const NEXT = "2026-09-16";
const ZONE = "America/Chicago";
const noteId = "c8a7c76f-3c1d-445c-9160-152e57b29e40";
const instant = "2026-09-15T16:00:00.000Z";
function saved(note = "Saved note", revision = "1", localDate = DAY, ownerUserId = OWNER) {
  return {
    ownerUserId,
    localDate,
    id: noteId,
    revision,
    note,
    recordedTimeZone: ZONE,
    createdAt: instant,
    updatedAt: instant,
  };
}
function absent(localDate = DAY, ownerUserId = OWNER) {
  return {
    ownerUserId,
    localDate,
    id: null,
    revision: "0",
    note: null,
    recordedTimeZone: null,
    createdAt: null,
    updatedAt: null,
  };
}
function response(body, status = 200, etag) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(etag === undefined ? {} : { etag }) },
  });
}
function readResponse(note) {
  return response({ data: note }, 200, `"${note.revision}"`);
}
function mutation(init, overrides = {}) {
  const headers = new Headers(init.headers),
    revision = headers.get("if-match").slice(1, -1);
  const note = {
    ...saved(JSON.parse(init.body).note, String(BigInt(revision) + 1n)),
    recordedTimeZone: headers.get("x-expected-profile-time-zone"),
    ...overrides,
  };
  return {
    data: {
      replayed: false,
      note,
      receipt: {
        protocol: "diary-day-note-v1",
        operationId: headers.get("idempotency-key"),
        ownerUserId: OWNER,
        localDate: DAY,
        expectedRevision: revision,
        expectedProfileTimeZone: headers.get("x-expected-profile-time-zone"),
        resultRevision: note.revision,
      },
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return React.isValidElement(node) ? text(node.props.children) : "";
}
const required = (value) => {
  expect(value).toBeTruthy();
  return value;
};
const button = (tree, label) =>
  required(
    nodes(tree).find(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
    ),
  );
const input = (tree, day = DAY) =>
  required(
    nodes(tree).find((node) => node.props.accessibilityLabel === `Day note text for ${day}`),
  );
const profile = (zone) => ({
  displayName: "Synthetic note owner",
  birthDate: null,
  sexAtBirth: "not_specified",
  heightCm: null,
  baselineWeightKg: null,
  activityLevelCode: null,
  locale: "en-US",
  timeZone: zone,
  unitSystem: "metric",
  onboardingCompletedAt: null,
  revision: "4",
  diaryGroups: resetDiaryGroups(),
});
const mounted = [];
async function setup(initial = absent()) {
  const authority = { owner: OWNER, epoch: 1, date: DAY, closed: false };
  const store = new Map([
    [DAY, initial],
    [NEXT, absent(NEXT)],
  ]);
  const calls = [];
  const config = { put: null, get: null, zone: ZONE, profileOwner: OWNER };
  let h;
  const props = {
    apiBase: new URL("https://api.example.test"),
    accessToken: "synthetic-note-token",
    ownerUserId: OWNER,
    sessionEpoch: 1,
    localDate: DAY,
    profileTimeZone: ZONE,
    profileBusy: false,
    isSessionCurrent: (owner, epoch) =>
      !authority.closed && owner === authority.owner && epoch === authority.epoch,
    isDateCurrent: (date) => !authority.closed && authority.date === date,
    onReturn: vi.fn((date) => {
      authority.date = date;
      h.updateProps({ localDate: date });
    }),
    onProfileUpdated: vi.fn((value) => {
      h.updateProps({ profileTimeZone: value.timeZone });
    }),
    onUnauthorized: vi.fn(async () => {
      authority.closed = true;
      h.updateProps({});
    }),
  };
  const fetcher = vi.fn(async (url, init = {}) => {
    const record = { url: String(url), init };
    calls.push(record);
    if (new URL(url).pathname === "/v1/auth/me")
      return response({
        data: {
          user: { id: config.profileOwner, email: "note@example.test", emailVerified: true },
          profile: profile(config.zone),
        },
      });
    expect(new URL(url).pathname).toMatch(/^\/v1\/diary\/day-notes\/\d{4}-\d\d-\d\d$/);
    const day = new URL(url).pathname.split("/").at(-1);
    if (init.method === "PUT") {
      if (config.put) return config.put(record);
      const body = mutation(init, { localDate: day });
      body.data.receipt.localDate = day;
      store.set(day, body.data.note);
      return response(body, 200, `"${body.data.note.revision}"`);
    }
    if (config.get) return config.get(record);
    return readResponse(store.get(day) ?? absent(day, authority.owner));
  });
  vi.stubGlobal("fetch", fetcher);
  h = screenHarness(props);
  mounted.push(h);
  let tree = await h.settle();
  const ctx = {
    h,
    props,
    authority,
    store,
    calls,
    config,
    get tree() {
      return tree;
    },
    puts: () => calls.filter((call) => call.init.method === "PUT"),
    async settle() {
      tree = await h.settle();
      return tree;
    },
    async press(label) {
      button(tree, label).props.onPress();
      return ctx.settle();
    },
    async type(raw) {
      input(tree, authority.date).props.onChangeText(raw);
      return ctx.settle();
    },
    async change(next, effects = true) {
      if (next.localDate !== undefined) authority.date = next.localDate;
      if (next.ownerUserId !== undefined) authority.owner = next.ownerUserId;
      if (next.sessionEpoch !== undefined) authority.epoch = next.sessionEpoch;
      h.updateProps(next);
      if (effects) return ctx.settle();
      tree = h.renderWithoutEffects();
      return tree;
    },
    async app(state) {
      AppState.currentState = state;
      for (const listener of hooks.appListeners) listener(state);
      return ctx.settle();
    },
  };
  return ctx;
}
afterEach(() => {
  for (const h of mounted.splice(0)) h.unmount();
  hooks.appListeners.clear();
  AppState.currentState = "active";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native private day notes", () => {
  it.each(["\r\n", "\r", "\n", "\u2028", "\u2029"])(
    "previews only four explicit lines without changing separator %j",
    async (separator) => {
      const prefix = ["first", "", "🍎", "Cafe\u0301"].join(separator);
      const full = `${prefix}${separator}last`;
      const c = await setup(saved(full));
      expect(text(c.tree)).toContain(`${prefix}…`);
      expect(text(c.tree)).not.toContain(full);
      expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
      const before = c.calls.length;
      await c.press("Show full note");
      expect(text(c.tree)).toContain(full);
      expect(button(c.tree, "Show less").props.accessibilityState.expanded).toBe(true);
      await c.press("Show less");
      expect(text(c.tree)).toContain(`${prefix}…`);
      expect(c.calls).toHaveLength(before);
    },
  );
  it.each([
    ["🍎".repeat(240), "🍎".repeat(240), false],
    ["🍎".repeat(241), "🍎".repeat(240), true],
    [`${"a".repeat(239)}\r\nnext`, "a".repeat(239), true],
  ])(
    "bounds the raw prefix by Unicode scalars without splitting a CRLF %#",
    async (full, prefix, shortened) => {
      const c = await setup(saved(full));
      expect(text(c.tree)).toContain(shortened ? `${prefix}…` : full);
      expect(nodes(c.tree).some((node) => node.props.accessibilityLabel === "Show full note")).toBe(
        shortened,
      );
      expect(nodes(c.tree).every((node) => node.props.numberOfLines === undefined)).toBe(true);
      if (shortened) {
        await c.press("Show full note");
        expect(text(c.tree)).toContain(full);
      }
    },
  );
  it("leaves short, four-line, absent and cleared notes fully visible without a toggle", async () => {
    for (const note of [
      saved("a".repeat(239)),
      saved("one\r\ntwo\rthree\nfour"),
      absent(),
      saved(null),
    ]) {
      const c = await setup(note);
      expect(
        nodes(c.tree).some((node) =>
          ["Show full note", "Show less"].includes(node.props.accessibilityLabel),
        ),
      ).toBe(false);
      expect(text(c.tree)).toContain(
        note.note ??
          (note.revision === "0"
            ? "No note for this day yet."
            : "The note for this day was cleared."),
      );
      expect(c.puts()).toHaveLength(0);
    }
  });
  it("fences retained toggles and resets expansion on saved revision and date replacement", async () => {
    const full = "saved ".repeat(50);
    const c = await setup(saved(full));
    const oldExpand = button(c.tree, "Show full note").props.onPress;
    await c.press("Show full note");
    const oldCollapse = button(c.tree, "Show less").props.onPress;
    const writes = c.h.stateWrites;
    oldExpand();
    expect(c.h.stateWrites).toBe(writes);
    c.store.set(DAY, saved(`${full}new`, "2"));
    await c.press("Reload day note");
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    const replacedWrites = c.h.stateWrites;
    oldCollapse();
    oldExpand();
    expect(c.h.stateWrites).toBe(replacedWrites);
    await c.press("Show full note");
    const priorDay = button(c.tree, "Show less").props.onPress;
    c.store.set(NEXT, saved(full, "1", NEXT));
    await c.change({ localDate: NEXT }, false);
    const beforeEffects = c.h.stateWrites;
    priorDay();
    expect(c.h.stateWrites).toBe(beforeEffects);
    c.h.flushEffects();
    await c.settle();
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    await c.change({ localDate: DAY });
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    const returnedWrites = c.h.stateWrites;
    priorDay();
    expect(c.h.stateWrites).toBe(returnedWrites);
    expect(c.puts()).toHaveLength(0);
  });
  it("resets expansion across background and private session replacement before stale actions", async () => {
    const c = await setup(saved("private ".repeat(50)));
    await c.press("Show full note");
    const backgroundAction = button(c.tree, "Show less").props.onPress;
    await c.app("background");
    const hiddenWrites = c.h.stateWrites;
    backgroundAction();
    expect(c.h.stateWrites).toBe(hiddenWrites);
    await c.app("active");
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    const priorSession = button(c.tree, "Show full note").props.onPress;
    await c.change({ sessionEpoch: 2 }, false);
    const sessionWrites = c.h.stateWrites;
    priorSession();
    expect(c.h.stateWrites).toBe(sessionWrites);
    c.h.flushEffects();
    await c.settle();
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    await c.press("Show full note");
    const priorOwner = button(c.tree, "Show less").props.onPress;
    c.store.set(DAY, saved("other ".repeat(50), "1", DAY, OTHER));
    await c.change({ ownerUserId: OTHER, sessionEpoch: 3 }, false);
    const ownerWrites = c.h.stateWrites;
    priorOwner();
    expect(c.h.stateWrites).toBe(ownerWrites);
    c.h.flushEffects();
    await c.settle();
    expect(button(c.tree, "Show full note").props.accessibilityState.expanded).toBe(false);
    c.authority.closed = true;
    const currentExpand = button(c.tree, "Show full note").props.onPress;
    const closedWrites = c.h.stateWrites;
    currentExpand();
    expect(c.h.stateWrites).toBe(closedWrites);
    expect(c.h.renderWithoutEffects()).toBeNull();
  });
  it("preserves full editor text and an exact ambiguous retry through local toggles", async () => {
    const full = "🍎\r\n".repeat(70);
    const c = await setup(saved(full));
    await c.press("Edit day note");
    expect(input(c.tree).props.value).toBe(full);
    const raw = `  ${full}Cafe\u0301\r\n `;
    await c.type(raw);
    const save = button(c.tree, "Save note").props.onPress;
    const before = c.calls.length;
    await c.press("Show full note");
    await c.press("Show less");
    expect(input(c.tree).props.value).toBe(raw);
    expect(c.calls).toHaveLength(before);
    c.config.put = () => {
      throw new Error("ambiguous");
    };
    save();
    await c.settle();
    const first = c.puts()[0];
    expect(first.init.body).toBe(JSON.stringify({ note: raw }));
    await c.press("Show full note");
    await c.press("Show less");
    await c.press("Retry same note save");
    expect(c.puts()).toHaveLength(2);
    expect(c.puts()[1].url).toBe(first.url);
    expect(c.puts()[1].init.body).toBe(first.init.body);
    expect(c.puts()[1].init.headers).toEqual(first.init.headers);
    expect(input(c.tree).props.value).toBe(raw);
  });
  it("keeps conflict-review text complete while only the saved presentation is collapsed", async () => {
    const c = await setup(saved("original ".repeat(40)));
    await c.press("Edit day note");
    await c.type("retained draft");
    c.config.put = () => response({ code: "DAY_NOTE_REVISION_CONFLICT" }, 412);
    await c.press("Save note");
    const latest = "latest\r\n".repeat(50);
    c.store.set(DAY, saved(latest, "2"));
    await c.press("Reload current note");
    expect(text(c.tree)).toContain(latest);
    expect(input(c.tree).props.value).toBe("retained draft");
    const keep = button(c.tree, "Keep my draft").props.onPress;
    const before = c.calls.length;
    await c.press("Show full note");
    await c.press("Show less");
    expect(c.calls).toHaveLength(before);
    keep();
    await c.settle();
    expect(input(c.tree).props.value).toBe("retained draft");
    expect(button(c.tree, "Save note").props.disabled).toBe(false);
  });
  it("loads virgin absence independently and creates an exact raw note without food requests", async () => {
    const c = await setup();
    expect(text(c.tree)).toContain("No note for this day yet.");
    expect(new Headers(c.calls[0].init.headers).get("x-expected-owner-user-id")).toBe(OWNER);
    await c.press("Add day note");
    button(c.tree, "Save note").props.onPress();
    await c.settle();
    expect(c.puts()).toHaveLength(0);
    const raw = "  Cafe\u0301\r\n🍎\n ";
    await c.type(raw);
    await c.press("Save note");
    expect(c.puts()).toHaveLength(1);
    expect(c.puts()[0].init.body).toBe(JSON.stringify({ note: raw }));
    expect(new Headers(c.puts()[0].init.headers).get("if-match")).toBe('"0"');
    expect(text(c.tree)).toContain(raw);
    expect(nodes(c.tree).some((node) => node.type === "TextInput")).toBe(false);
    expect(c.calls).toHaveLength(3); // note GET, PUT, coherent current-note GET
  });
  it("keeps whitespace text, clear local/Cancel, and positive cleared identity distinct", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.press("Clear note field");
    expect(input(c.tree).props.value).toBe("");
    expect(c.puts()).toHaveLength(0);
    await c.press("Cancel note editing");
    expect(text(c.tree)).toContain("Saved note");
    await c.press("Edit day note");
    await c.press("Clear note field");
    await c.press("Save note");
    expect(c.puts()[0].init.body).toBe('{"note":null}');
    expect(text(c.tree)).toContain("was cleared");
    await c.press("Add day note");
    button(c.tree, "Save note").props.onPress();
    await c.settle();
    expect(c.puts()).toHaveLength(1);
    await c.type(" \r\n ");
    await c.press("Save note");
    expect(new Headers(c.puts()[1].init.headers).get("if-match")).toBe('"2"');
    expect(JSON.parse(c.puts()[1].init.body).note).toBe(" \r\n ");
  });
  it.each(["x".repeat(2001), "bad\0text", "bad\ud800text"])(
    "preserves invalid raw text and blocks Save %#",
    async (raw) => {
      const c = await setup();
      await c.press("Add day note");
      await c.type(raw);
      await c.press("Save note");
      expect(input(c.tree).props.value).toBe(raw);
      expect(c.puts()).toHaveLength(0);
      expect(text(c.tree)).toContain("2,000 characters");
    },
  );
  it("accepts 2000 Unicode scalars without truncating surrogate pairs", async () => {
    const c = await setup();
    await c.press("Add day note");
    const raw = "🍎".repeat(2000);
    await c.type(raw);
    await c.press("Save note");
    expect(JSON.parse(c.puts()[0].init.body).note).toBe(raw);
  });
  it("preserves one draft across date changes, fences old callbacks and returns without retargeting", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.type("raw draft");
    const oldInput = input(c.tree).props.onChangeText,
      oldSave = button(c.tree, "Save note").props.onPress;
    await c.change({ localDate: NEXT });
    expect(text(c.tree)).toContain(`belongs to ${DAY}`);
    expect(text(c.tree)).not.toContain("Add day note");
    oldInput("wrong");
    oldSave();
    await c.settle();
    expect(c.puts()).toHaveLength(0);
    await c.press(`Return to note for ${DAY}`);
    expect(input(c.tree).props.value).toBe("raw draft");
    oldSave();
    await c.settle();
    expect(c.puts()).toHaveLength(0);
    await c.press("Save note");
    expect(new URL(c.puts()[0].url).pathname).toBe(`/v1/diary/day-notes/${DAY}`);
  });
  it("restarts a pending read when same-date route readiness returns and preserves raw drafts", async () => {
    const c = await setup(saved());
    let dateReady = true;
    await c.change({
      isDateCurrent: (date) => dateReady && !c.authority.closed && c.authority.date === date,
    });
    const oldEdit = button(c.tree, "Edit day note").props.onPress;
    const pending = deferred();
    c.config.get = () => pending.promise;
    await c.press("Reload day note");
    expect(c.calls).toHaveLength(2);
    dateReady = false;
    await c.change({});
    expect(c.tree).toBeNull();
    pending.resolve(readResponse(saved("Obsolete pending note")));
    await c.settle();
    expect(c.calls).toHaveLength(2);
    c.config.get = null;
    c.store.set(DAY, saved("Current saved note", "2"));
    dateReady = true;
    await c.change({});
    expect(c.calls).toHaveLength(3);
    expect(text(c.tree)).toContain("Current saved note");
    expect(text(c.tree)).not.toContain("Obsolete pending note");
    expect(button(c.tree, "Reload day note").props.disabled).toBe(false);
    oldEdit();
    await c.settle();
    expect(nodes(c.tree).some((node) => node.type === "TextInput")).toBe(false);
    await c.press("Edit day note");
    await c.type("  retained raw\r\n");
    const save = button(c.tree, "Save note").props.onPress;
    dateReady = false;
    await c.change({});
    save();
    await c.settle();
    expect(c.puts()).toHaveLength(0);
    dateReady = true;
    await c.change({});
    expect(c.calls).toHaveLength(4);
    expect(input(c.tree).props.value).toBe("  retained raw\r\n");
    await c.change({});
    expect(c.calls).toHaveLength(4);
    await c.press("Cancel note editing");
    expect(text(c.tree)).toContain("Current saved note");
    expect(button(c.tree, "Edit day note").props.disabled).toBe(false);
    expect(c.puts()).toHaveLength(0);
  });
  it("rejects callbacks retained before a later raw edit, but matching field actions stay no-ops", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    const staleSave = button(c.tree, "Save note").props.onPress;
    await c.type("first");
    const staleClear = button(c.tree, "Clear note field").props.onPress;
    await c.type("second");
    staleSave();
    staleClear();
    await c.settle();
    expect(input(c.tree).props.value).toBe("second");
    expect(c.puts()).toHaveLength(0);
    const currentSave = button(c.tree, "Save note").props.onPress;
    const writes = c.h.stateWrites;
    input(c.tree).props.onChangeText("second");
    await c.settle();
    expect(c.h.stateWrites).toBe(writes);
    currentSave();
    await c.settle();
    expect(c.puts()).toHaveLength(1);
  });
  it("retries an ambiguous write with original date, raw bytes, revision, zone and key after navigation/profile refresh", async () => {
    const c = await setup(saved());
    c.config.put = () => response({}, 503);
    await c.press("Edit day note");
    await c.type("exact\r\nraw");
    await c.press("Save note");
    const first = c.puts()[0];
    const lockedInput = input(c.tree);
    expect(lockedInput.props.editable).toBe(false);
    lockedInput.props.onChangeText("replacement");
    await c.settle();
    await c.change({ localDate: NEXT, profileTimeZone: "UTC" });
    expect(text(c.tree)).toContain("unconfirmed save");
    expect(text(c.tree)).not.toContain("Discard note draft");
    await c.press(`Return to note for ${DAY}`);
    await c.press("Retry same note save");
    expect(c.puts()).toHaveLength(2);
    expect(c.puts()[1].url).toBe(first.url);
    expect(c.puts()[1].init.body).toBe(first.init.body);
    expect(c.puts()[1].init.headers).toEqual(first.init.headers);
  });
  it("retire-before-read reconciles historical replay without installing it over a newer head", async () => {
    const c = await setup(saved());
    let first;
    c.config.put = ({ init }) => {
      first ??= mutation(init);
      c.store.set(DAY, saved("Another client changed it", "5"));
      return response({ data: { ...first.data, replayed: true } }, 200, '"2"');
    };
    await c.press("Edit day note");
    await c.type("My accepted text");
    await c.press("Save note");
    expect(text(c.tree)).toContain("Another client changed it");
    expect(text(c.tree)).not.toContain("My accepted text");
    c.config.put = null;
    await c.press("Edit day note");
    await c.type("Deliberate next text");
    await c.press("Save note");
    expect(new Headers(c.puts()[1].init.headers).get("if-match")).toBe('"5"');
    expect(new Headers(c.puts()[1].init.headers).get("idempotency-key")).not.toBe(
      new Headers(c.puts()[0].init.headers).get("idempotency-key"),
    );
  });
  it("keeps acknowledged save resolved after failed head read and offers read-only recovery", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.type("accepted");
    c.config.get = () => response({}, 503);
    await c.press("Save note");
    expect(text(c.tree)).toContain("was accepted");
    expect(text(c.tree)).not.toContain("Retry same note save");
    expect(input(c.tree).props.editable).toBe(false);
    c.config.get = null;
    await c.press("Reload saved note");
    expect(c.puts()).toHaveLength(1);
    expect(text(c.tree)).toContain("accepted");
    expect(nodes(c.tree).some((node) => node.type === "TextInput")).toBe(false);
  });
  it.each([
    [412, "DAY_NOTE_REVISION_CONFLICT"],
    [409, "DAY_NOTE_TIME_ZONE_CHANGED"],
  ])("requires explicit conflict reload and draft rebase after %s", async (status, code) => {
    const c = await setup(saved());
    c.config.put = () => response({ code }, status);
    await c.press("Edit day note");
    await c.type("retained raw\r\n");
    await c.press("Save note");
    c.store.set(DAY, saved("Latest elsewhere", "3"));
    c.config.zone = "UTC";
    await c.press("Reload current note");
    expect(input(c.tree).props.value).toBe("retained raw\r\n");
    expect(text(c.tree)).toContain("Latest elsewhere");
    expect(c.puts()).toHaveLength(1);
    await c.press("Keep my draft");
    expect(c.puts()).toHaveLength(1);
    c.config.put = null;
    await c.press("Save note");
    expect(new Headers(c.puts()[1].init.headers).get("if-match")).toBe('"3"');
    expect(new Headers(c.puts()[1].init.headers).get("x-expected-profile-time-zone")).toBe("UTC");
    expect(JSON.parse(c.puts()[1].init.body).note).toBe("retained raw\r\n");
  });
  it("invalidates reviewed conflict choices after a newer read and fences an earlier view read", async () => {
    const c = await setup(saved());
    c.config.put = () => response({ code: "DAY_NOTE_REVISION_CONFLICT" }, 412);
    await c.press("Edit day note");
    await c.type("  retained raw\r\n");
    await c.press("Save note");
    const earlierView = deferred();
    c.config.get = () => earlierView.promise;
    await c.change({ accessToken: "refreshed-synthetic-note-token" });
    const earlierRequest = c.calls.at(-1);
    c.config.get = null;
    c.store.set(DAY, saved("Reviewed second note", "2"));
    await c.press("Reload current note");
    expect(earlierRequest.init.signal.aborted).toBe(true);
    earlierView.resolve(readResponse(saved("Obsolete first note", "1")));
    await c.settle();
    expect(text(c.tree)).toContain("Reviewed second note");
    expect(text(c.tree)).not.toContain("Obsolete first note");
    const oldKeep = button(c.tree, "Keep my draft").props.onPress;
    const oldUse = button(c.tree, "Use saved note").props.onPress;
    await c.change({ localDate: NEXT });
    c.store.set(DAY, saved("Newest third note", "3"));
    await c.change({ localDate: DAY });
    oldKeep();
    oldUse();
    await c.settle();
    expect(input(c.tree).props.value).toBe("  retained raw\r\n");
    expect(text(c.tree)).toContain("Newest third note");
    expect(text(c.tree)).not.toContain("Reviewed second note");
    expect(text(c.tree)).not.toContain("Keep my draft");
    expect(button(c.tree, "Reload current note").props.disabled).toBe(false);
    expect(c.puts()).toHaveLength(1);
    await c.press("Reload current note");
    await c.press("Keep my draft");
    c.config.put = null;
    await c.press("Save note");
    expect(c.puts()).toHaveLength(2);
    expect(new Headers(c.puts()[1].init.headers).get("if-match")).toBe('"3"');
    expect(JSON.parse(c.puts()[1].init.body).note).toBe("  retained raw\r\n");
  });
  it("uses saved text only after explicit conflict choice", async () => {
    const c = await setup(saved());
    c.config.put = () => response({ code: "DAY_NOTE_REVISION_CONFLICT" }, 412);
    await c.press("Edit day note");
    await c.type("discard me");
    await c.press("Save note");
    c.store.set(DAY, saved("Latest", "4"));
    await c.press("Reload current note");
    await c.press("Use saved note");
    expect(text(c.tree)).toContain("Latest");
    expect(text(c.tree)).not.toContain("discard me");
    expect(c.puts()).toHaveLength(1);
  });
  it.each(["malformed", "mismatched", "idempotency"])(
    "retains exact unresolved intent for %s results",
    async (kind) => {
      const c = await setup(saved());
      c.config.put = ({ init }) =>
        kind === "idempotency"
          ? response({ code: "DAY_NOTE_IDEMPOTENCY_CONFLICT" }, 409)
          : kind === "malformed"
            ? response({ data: {} }, 200, '"2"')
            : response(mutation(init, { note: "wrong" }), 200, '"2"');
      await c.press("Edit day note");
      await c.type("pending");
      await c.press("Save note");
      await c.press("Retry same note save");
      expect(c.puts()[1].init.body).toBe(c.puts()[0].init.body);
      expect(c.puts()[1].init.headers).toEqual(c.puts()[0].init.headers);
    },
  );
  it("blocks old owner callbacks before effects and late401 cannot close a newer session", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.type("private");
    const oldInput = input(c.tree).props.onChangeText,
      oldSave = button(c.tree, "Save note").props.onPress;
    const pending = deferred();
    c.config.put = () => pending.promise;
    await c.press("Save note");
    await c.change({ ownerUserId: OTHER, sessionEpoch: 2 }, false);
    expect(text(c.tree)).not.toContain("private");
    oldInput("leak");
    oldSave();
    pending.resolve(response({}, 401));
    await c.settle();
    expect(c.props.onUnauthorized).not.toHaveBeenCalled();
    expect(c.puts()).toHaveLength(1);
  });
  it("fences background callbacks, retains pending bytes on return, and makes current401 close private state", async () => {
    const c = await setup(saved());
    c.config.put = () => response({}, 503);
    await c.press("Edit day note");
    await c.type("pending");
    await c.press("Save note");
    const retry = button(c.tree, "Retry same note save").props.onPress;
    await c.app("background");
    expect(c.tree).toBeNull();
    retry();
    await c.settle();
    expect(c.puts()).toHaveLength(1);
    await c.app("active");
    retry();
    await c.settle();
    expect(c.puts()).toHaveLength(1);
    c.config.put = () => response({}, 401);
    await c.press("Retry same note save");
    expect(c.props.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(c.tree).toBeNull();
  });
  it("rejects old-day read completion and does not guess absence after an unavailable or malformed API", async () => {
    const c = await setup(saved());
    const old = deferred();
    c.config.get = ({ url }) =>
      url.endsWith(DAY)
        ? old.promise
        : response({ data: { ...absent(NEXT), unexpected: true } }, 200, '"0"');
    await c.press("Reload day note");
    await c.change({ localDate: NEXT });
    old.resolve(readResponse(saved("OLD PRIVATE")));
    await c.settle();
    expect(text(c.tree)).not.toContain("OLD PRIVATE");
    expect(text(c.tree)).not.toContain("Add day note");
    expect(text(c.tree)).toContain("unavailable");
  });
  it("keeps note authority separate from unrelated parent refresh and busy flags", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.type("draft");
    const before = c.calls.length;
    await c.change({});
    expect(c.calls).toHaveLength(before);
    expect(input(c.tree).props.value).toBe("draft");
    const save = button(c.tree, "Save note").props.onPress;
    await c.change({ profileBusy: true });
    save();
    await c.settle();
    expect(c.puts()).toHaveLength(0);
    await c.change({ profileBusy: false });
    await c.press("Save note");
    expect(c.puts()).toHaveLength(1);
  });
  it("clears note memory synchronously when the parent closes its private session", async () => {
    const c = await setup(saved());
    await c.press("Edit day note");
    await c.type("private abandoned text");
    const oldSave = button(c.tree, "Save note").props.onPress;
    c.authority.closed = true;
    c.h.updateProps({});
    expect(c.h.renderWithoutEffects()).toBeNull();
    oldSave();
    expect(c.puts()).toHaveLength(0);
    c.authority.closed = false;
    await c.change({});
    expect(text(c.tree)).not.toContain("private abandoned text");
    expect(nodes(c.tree).some((node) => node.type === "TextInput")).toBe(false);
  });
  it("allows Return during an in-flight save and reconciles its original day while another day stays current", async () => {
    const c = await setup(saved());
    const pending = deferred();
    c.config.put = () => pending.promise;
    await c.press("Edit day note");
    await c.type("original day save");
    await c.press("Save note");
    await c.change({ localDate: NEXT });
    await c.press(`Return to note for ${DAY}`);
    expect(c.authority.date).toBe(DAY);
    await c.change({ localDate: NEXT });
    const accepted = mutation(c.puts()[0].init);
    c.store.set(DAY, accepted.data.note);
    pending.resolve(response(accepted, 200, '"2"'));
    await c.settle();
    expect(text(c.tree)).toContain("No note for this day yet.");
    expect(text(c.tree)).not.toContain("original day save");
    expect(button(c.tree, "Add day note").props.disabled).toBe(false);
    expect(c.puts()).toHaveLength(1);
  });
  it("unmount closes authority and effect replay can reopen a clean note reader", async () => {
    const c = await setup(saved());
    c.h.replayEffects();
    await c.settle();
    expect(text(c.tree)).toContain("Saved note");
    await c.press("Edit day note");
    await c.type("pending");
    const pending = deferred();
    c.config.put = () => pending.promise;
    await c.press("Save note");
    const init = c.puts()[0].init;
    c.h.unmount();
    pending.resolve(response(mutation(init), 200, '"2"'));
    await Promise.resolve();
    await Promise.resolve();
    expect(c.h.writesAfterUnmount).toBe(0);
  });
});
