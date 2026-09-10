import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import * as React from "react";
import { AccessibilityInfo, Alert, AppState } from "react-native";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityScreen } from "../src/activity/ActivityScreen";
import { localDateInTimeZone } from "../src/diary/diary";

const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set(), operation: 0 }));
vi.mock("react", async (original) => ({
  ...(await original()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
}));
vi.mock("../src/auth/operation-id", () => ({
  newOperationId: () => `00000000-0000-4000-8000-${String(++hooks.operation).padStart(12, "0")}`,
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event, listener) => {
      hooks.appListeners.add(listener);
      return { remove: () => hooks.appListeners.delete(listener) };
    },
  },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Alert: { alert: vi.fn() },
  ActivityIndicator: "ActivityIndicator",
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
          tree = ActivityScreen(props);
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
      tree = ActivityScreen(props);
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

const selectedDate = "2026-11-01";
const zone = "America/Chicago";
const source = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  name: "Morning walk 🥾",
  durationMinutes: 45,
  selfReportedEnergyKilocalories: "0.001",
  occurredAt: "2026-11-01T12:45:00.000Z",
  localDate: selectedDate,
  localTime: "06:45:00",
  timeZone: zone,
  createdAt: "2026-11-01T12:45:01.000Z",
};
const second = {
  ...source,
  id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
  name: "Stretch",
  durationMinutes: 17,
  selfReportedEnergyKilocalories: null,
  occurredAt: "2026-11-01T13:45:00.000Z",
  localTime: "07:45:00",
};
function dayBody(date, rows = [source, second]) {
  const entries = rows.map((row) => ({
    ...row,
    localDate: date,
    occurredAt: date + row.occurredAt.slice(10),
  }));
  return {
    data: {
      localDate: date,
      timeZone: zone,
      revision: "3",
      entries,
      totalDurationMinutes: entries.reduce((sum, entry) => sum + entry.durationMinutes, 0),
      updatedAt: "2026-11-01T13:45:01.000Z",
    },
  };
}
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
function receipt(request) {
  const body = JSON.parse(request.body);
  const instant = new Date(body.occurredAt);
  const localDate = localDateInTimeZone(instant, zone);
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const milliseconds = instant.getUTCMilliseconds();
  const localTime = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
  return response({
    data: {
      replayed: false,
      entry: {
        ...source,
        ...body,
        id: "5bcfa2bf-4950-43f7-9f24-b983ac803012",
        revision: "1",
        localDate,
        localTime,
      },
      affectedDays: [{ localDate, revision: "4" }],
    },
  });
}
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function rawText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawText).join(" ");
  return value && typeof value === "object" ? rawText(value.props?.children) : "";
}
const text = (value) => rawText(value).replace(/\s+/gu, " ").trim();
function nodes(value, match) {
  if (Array.isArray(value)) return value.flatMap((child) => nodes(child, match));
  if (!value || typeof value !== "object") return [];
  return [...(match(value) ? [value] : []), ...nodes(value.props?.children, match)];
}
function button(tree, label, index = 0) {
  const found = nodes(
    tree,
    (node) =>
      node.type === "Pressable" &&
      (node.props.accessibilityLabel === label || text(node) === label),
  );
  expect(found.length, label).toBeGreaterThan(index);
  return found[index];
}
function input(tree, label) {
  const found = nodes(
    tree,
    (node) => node.type === "TextInput" && node.props.accessibilityLabel === label,
  );
  expect(found, label).toHaveLength(1);
  return found[0];
}
const names = {
  name: "Activity name",
  duration: "Activity duration in whole minutes",
  energy: "Optional self-reported activity calories",
  time: "Activity local start time",
  date: "Activity date YYYY-MM-DD",
};
const allHarnesses = [];
function setup(responder = () => undefined, rows = [source, second]) {
  const requests = [];
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-token",
    expectedOwnerUserId: "4afda2f8-e150-40ed-88f1-a327cd5e2430",
    profileTimeZone: zone,
    requestedDate: selectedDate,
    onUnauthorized: vi.fn(async () => {}),
  };
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      const request = {
        url: new URL(url),
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      };
      requests.push(request);
      return (
        (await responder(request)) ??
        (request.method === "POST"
          ? receipt(request)
          : response(dayBody(request.url.searchParams.get("date"), rows)))
      );
    }),
  );
  const harness = screenHarness(props);
  allHarnesses.push(harness);
  return {
    harness,
    props,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
  };
}
async function fill(harness, fields) {
  let tree = await harness.settle();
  for (const [field, value] of Object.entries(fields)) {
    input(tree, names[field]).props.onChangeText(value);
    tree = await harness.settle();
  }
  return tree;
}
async function press(harness, label, index = 0) {
  button(await harness.settle(), label, index).props.onPress();
  return harness.settle();
}
function appState(next) {
  AppState.currentState = next;
  for (const listener of hooks.appListeners) listener(next);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
});
afterEach(() => {
  for (const harness of allHarnesses.splice(0)) harness.unmount();
  hooks.appListeners.clear();
  AppState.currentState = "active";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native activity reuse", () => {
  for (const energy of [null, "0.001"]) {
    it(`reuses exact parsed details with ${energy} energy, retaining the untouched folded instant until explicit Add`, async () => {
      const { harness, requests, writes } = setup(
        () => undefined,
        [{ ...source, selfReportedEnergyKilocalories: energy }, second],
      );
      let tree = await harness.settle();
      const before = requests.length;
      const prior = JSON.stringify(source);
      const oldAdd = button(tree, "Add activity").props.onPress;
      const oldField = input(tree, names.name).props.onChangeText;
      const use = button(tree, `Use details from ${source.name}`).props.onPress;
      use();
      use();
      oldAdd();
      oldField("old field");
      tree = await harness.settle();
      expect(input(tree, names.name).props.value).toBe(source.name);
      expect(input(tree, names.duration).props.value).toBe("45");
      expect(input(tree, names.energy).props.value).toBe(energy ?? "");
      expect(input(tree, names.time).props.value).toBe("01:30");
      expect(requests).toHaveLength(before);
      expect(text(tree)).toContain("62 min");
      expect(text(tree)).toContain("Review the selected day");
      expect(JSON.stringify(source)).toBe(prior);
      const submit = button(tree, "Add activity").props.onPress;
      submit();
      submit();
      tree = await harness.settle();
      expect(writes()).toHaveLength(1);
      const write = writes()[0];
      expect(JSON.parse(write.body)).toEqual({
        name: source.name,
        durationMinutes: 45,
        selfReportedEnergyKilocalories: energy,
        occurredAt: "2026-11-01T07:30:45.123Z",
      });
      expect(write.url.pathname).toBe("/v1/activities/entries");
      expect(write.headers["if-match"]).toBeUndefined();
      expect(write.headers["x-expected-profile-time-zone"]).toBe(zone);
      expect(input(tree, names.name).props.value).toBe("");
    });
  }
  it("keeps a user-selected day and start time instead of copying source time", async () => {
    const { harness, writes } = setup();
    await press(harness, "Next activity day");
    let tree = await fill(harness, { time: "10:15" });
    tree = await press(harness, `Use details from ${source.name}`);
    expect(input(tree, names.date).props.value).toBe("2026-11-02");
    expect(input(tree, names.time).props.value).toBe("10:15");
    await press(harness, "Add activity");
    expect(JSON.parse(writes()[0].body).occurredAt).toBe("2026-11-02T16:15:00.000Z");
  });
  it("keeps zero invalid and preserves activity energy policy", async () => {
    const { harness, writes } = setup();
    await press(harness, `Use details from ${source.name}`);
    await fill(harness, { energy: "0" });
    const tree = await press(harness, "Add activity");
    expect(writes()).toHaveLength(0);
    expect(text(tree)).toContain("0.001");
    expect(text(tree)).toContain("Calories do not change your food budget");
  });
  it("protects exact raw dirty details, supports Keep and replaces only the copied-over fields", async () => {
    const { harness, writes } = setup();
    let tree = await fill(harness, {
      name: "  raw draft  ",
      duration: "003",
      energy: "1.200",
      time: "11:12",
    });
    tree = await press(harness, `Use details from ${source.name}`);
    expect(input(tree, names.name).props.value).toBe("  raw draft  ");
    tree = await press(harness, "Keep draft");
    expect(input(tree, names.energy).props.value).toBe("1.200");
    await press(harness, `Use details from ${second.name}`);
    tree = await press(harness, "Replace details");
    expect(input(tree, names.name).props.value).toBe(second.name);
    expect(input(tree, names.duration).props.value).toBe("17");
    expect(input(tree, names.energy).props.value).toBe("");
    expect(input(tree, names.time).props.value).toBe("11:12");
    expect(writes()).toHaveLength(0);
  });
  for (const field of ["name", "duration", "energy", "time", "date"]) {
    it(`invalidates a replacement choice after ${field} draft edits`, async () => {
      const { harness } = setup();
      await fill(harness, { name: "draft" });
      let tree = await press(harness, `Use details from ${source.name}`);
      const old = button(tree, "Replace details").props.onPress;
      input(tree, names[field]).props.onChangeText(field === "date" ? "invalid" : "edited");
      old();
      tree = await harness.settle();
      expect(input(tree, names.name).props.value).toBe(field === "name" ? "edited" : "draft");
      expect(
        nodes(tree, (node) => node.type === "Pressable" && text(node) === "Replace details"),
      ).toHaveLength(0);
    });
  }
  it("keeps controls current after blurring the unchanged selected date", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    input(tree, names.date).props.onEndEditing({ nativeEvent: { text: selectedDate } });
    tree = await harness.settle();
    tree = await press(harness, `Use details from ${source.name}`);
    expect(input(tree, names.name).props.value).toBe(source.name);
  });
  it("restores the synchronous date draft after invalid blur so fresh reuse works", async () => {
    const { harness } = setup();
    let tree = await fill(harness, { date: "invalid" });
    input(tree, names.date).props.onEndEditing({ nativeEvent: { text: "invalid" } });
    tree = await harness.settle();
    expect(input(tree, names.date).props.value).toBe(selectedDate);
    tree = await press(harness, `Use details from ${source.name}`);
    expect(input(tree, names.name).props.value).toBe(source.name);
  });
  it("does not let an old Keep or Replace control dismiss a newer source choice", async () => {
    const { harness } = setup();
    await fill(harness, { name: "draft" });
    let tree = await press(harness, `Use details from ${source.name}`);
    const keep = button(tree, "Keep draft").props.onPress;
    const replace = button(tree, "Replace details").props.onPress;
    tree = await press(harness, `Use details from ${second.name}`);
    keep();
    replace();
    tree = await harness.settle();
    expect(text(tree)).toContain("Replace the Add details with Stretch");
    tree = await press(harness, "Replace details");
    expect(input(tree, names.name).props.value).toBe(second.name);
  });
  it("preserves existing Add details on date switches while rejecting retained choice and field actions", async () => {
    const { harness } = setup();
    await fill(harness, { name: "draft", duration: "17", time: "11:12" });
    let tree = await press(harness, `Use details from ${source.name}`);
    const old = button(tree, "Replace details").props.onPress;
    const oldField = input(tree, names.name).props.onChangeText;
    tree = await press(harness, "Next activity day");
    old();
    oldField("stale");
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe("draft");
    expect(input(tree, names.time).props.value).toBe("11:12");
    expect(
      nodes(tree, (node) => node.type === "Pressable" && text(node) === "Replace details"),
    ).toHaveLength(0);
  });
  for (const change of ["owner", "token", "api", "zone", "route"]) {
    it(`rejects retained private ${change} callbacks before effects`, async () => {
      const { harness, writes } = setup();
      await fill(harness, { name: "draft" });
      let tree = await press(harness, `Use details from ${source.name}`);
      const old = button(tree, "Replace details").props.onPress;
      const add = button(tree, "Add activity").props.onPress;
      harness.updateProps(
        change === "owner"
          ? { expectedOwnerUserId: "new-owner" }
          : change === "token"
            ? { accessToken: "new-token" }
            : change === "api"
              ? { apiBase: new URL("http://127.0.0.1:4001") }
              : change === "zone"
                ? { profileTimeZone: "UTC" }
                : { requestedDate: "2026-11-02" },
      );
      tree = harness.renderWithoutEffects();
      old();
      add();
      expect(input(tree, names.name).props.value).toBe("");
      expect(writes()).toHaveLength(0);
    });
  }
  it("keeps reuse unavailable during row editing and rejects a retained delete confirmation after reuse", async () => {
    const { harness, writes } = setup();
    let tree = await harness.settle();
    const oldUse = button(tree, `Use details from ${source.name}`).props.onPress;
    button(tree, "Delete").props.onPress();
    const oldDelete = Alert.alert.mock.calls.at(-1)[2][1].onPress;
    button(tree, "Edit activity").props.onPress();
    oldUse();
    tree = await harness.settle();
    expect(button(tree, `Use details from ${second.name}`).props.disabled).toBe(true);
    expect(input(tree, names.name).props.value).toBe("");
    await press(harness, "Cancel");
    await press(harness, `Use details from ${source.name}`);
    oldDelete();
    await harness.settle();
    expect(writes()).toHaveLength(0);
  });
  it("keeps an unchanged ambiguous retry key across reload and date-away/back, but accepting reuse starts a new intent", async () => {
    const { harness, writes } = setup((request) =>
      request.method === "POST" ? response({}, 503) : undefined,
    );
    await press(harness, `Use details from ${source.name}`);
    await press(harness, "Add activity");
    await press(harness, "Retry day view");
    await press(harness, "Add activity");
    expect(writes()[1].headers["idempotency-key"]).toBe(writes()[0].headers["idempotency-key"]);
    await press(harness, "Next activity day");
    await press(harness, "Previous activity day");
    await press(harness, "Add activity");
    expect(writes()[2].body).toBe(writes()[0].body);
    expect(writes()[2].headers["idempotency-key"]).toBe(writes()[0].headers["idempotency-key"]);
    await press(harness, "Retry day view");
    await press(harness, `Use details from ${source.name}`);
    await press(harness, "Keep draft");
    await press(harness, "Add activity");
    expect(writes()[3].headers["idempotency-key"]).toBe(writes()[0].headers["idempotency-key"]);
    await press(harness, "Retry day view");
    await press(harness, `Use details from ${source.name}`);
    await press(harness, "Replace details");
    await press(harness, "Add activity");
    expect(writes()[4].body).toBe(writes()[0].body);
    expect(writes()[4].headers["idempotency-key"]).not.toBe(writes()[0].headers["idempotency-key"]);
  });
  it("clears only the accepted Add draft if its refresh fails and retries only the read", async () => {
    let rejectRead = false;
    const { harness, writes } = setup((request) => {
      if (request.method === "POST") {
        rejectRead = true;
        return receipt(request);
      }
      if (rejectRead) {
        rejectRead = false;
        return response({}, 503);
      }
      return undefined;
    });
    await press(harness, `Use details from ${source.name}`);
    let tree = await press(harness, "Add activity");
    expect(input(tree, names.name).props.value).toBe("");
    expect(text(tree)).toContain("activity change was accepted");
    tree = await press(harness, "Retry day view");
    expect(writes()).toHaveLength(1);
    expect(input(tree, names.name).props.value).toBe("");
  });
  it("rejects busy reuse and an old create receipt after background, fresh load and another accepted reuse", async () => {
    const pending = deferred();
    let oldRequest;
    const { harness, requests } = setup((request) => {
      if (request.method === "POST") {
        oldRequest = request;
        return pending.promise;
      }
      return undefined;
    });
    let tree = await press(harness, `Use details from ${source.name}`);
    const oldUse = button(tree, `Use details from ${second.name}`).props.onPress;
    button(tree, "Add activity").props.onPress();
    oldUse();
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe(source.name);
    appState("background");
    tree = await harness.settle();
    expect(button(tree, "Add activity").props.disabled).toBe(true);
    appState("active");
    await harness.settle();
    await press(harness, `Use details from ${second.name}`);
    tree = await press(harness, "Replace details");
    const before = requests.length;
    pending.resolve(receipt(oldRequest));
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe(second.name);
    expect(requests).toHaveLength(before);
    expect(oldRequest.signal.aborted).toBe(true);
  });
  it("fences old controls on effect replay while preserving the Add draft and allowing fresh reuse", async () => {
    const { harness } = setup();
    await fill(harness, { name: "draft" });
    let tree = await press(harness, `Use details from ${source.name}`);
    const old = button(tree, "Replace details").props.onPress;
    harness.replayEffects();
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe("draft");
    await press(harness, `Use details from ${second.name}`);
    tree = await press(harness, "Replace details");
    expect(input(tree, names.name).props.value).toBe(second.name);
  });
  it("ignores a post-unmount receipt without any state writes", async () => {
    const pending = deferred();
    let oldRequest;
    const { harness } = setup((request) => {
      if (request.method === "POST") {
        oldRequest = request;
        return pending.promise;
      }
      return undefined;
    });
    await press(harness, `Use details from ${source.name}`);
    await press(harness, "Add activity");
    harness.unmount();
    pending.resolve(receipt(oldRequest));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
  });
  it("preserves explicit401 closure across effect replay", async () => {
    let closed = false;
    const { harness, props, requests } = setup(() => (closed ? response({}, 401) : undefined));
    await press(harness, `Use details from ${source.name}`);
    closed = true;
    let tree = await press(harness, "Next activity day");
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    const before = requests.length;
    harness.replayEffects();
    tree = await harness.settle();
    expect(requests).toHaveLength(before);
    expect(button(tree, "Add activity").props.disabled).toBe(true);
    expect(input(tree, names.name).props.value).toBe("");
  });
  it("clears accepted details before its own refreshed time zone changes the Add clock", async () => {
    let accepted = false;
    const { harness, writes } = setup((request) => {
      if (request.method === "POST") {
        accepted = true;
        return receipt(request);
      }
      if (accepted) {
        const next = dayBody(selectedDate);
        next.data.timeZone = "America/New_York";
        return response(next);
      }
      return undefined;
    });
    await press(harness, `Use details from ${source.name}`);
    let tree = await press(harness, "Add activity");
    expect(input(tree, names.name).props.value).toBe("");
    expect(input(tree, names.duration).props.value).toBe("");
    expect(input(tree, names.energy).props.value).toBe("");
    expect(input(tree, names.time).props.value).toBe("02:30");
    tree = await press(harness, "Add activity");
    expect(writes()).toHaveLength(1);
  });
  it("rejects a row A field retained through cancellation, reuse and a new row B editor", async () => {
    const { harness } = setup();
    let tree = await press(harness, "Edit activity");
    const old = input(tree, "Edit activity name").props.onChangeText;
    await press(harness, "Cancel");
    await press(harness, `Use details from ${source.name}`);
    tree = await press(harness, "Edit activity", 1);
    old("stale row A");
    tree = await harness.settle();
    expect(input(tree, "Edit activity name").props.value).toBe(second.name);
    expect(input(tree, names.name).props.value).toBe(source.name);
  });
  it("scrolls to and announces the Add draft and its replacement choice", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    const scrollTo = vi.fn();
    nodes(tree, (node) => node.type === "ScrollView")[0].props.ref.current = { scrollTo };
    nodes(
      tree,
      (node) => node.props.accessibilityLabel === "Add an activity form",
    )[0].props.onLayout({ nativeEvent: { layout: { y: 420 } } });
    tree = await press(harness, `Use details from ${source.name}`);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 420, animated: true });
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(
      "Activity details copied to Add an activity. Review and choose Add activity to save.",
    );
    tree = await press(harness, `Use details from ${second.name}`);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(
      "Your Add draft has details. Choose Keep draft or Replace details.",
    );
  });
  for (const boundary of ["owner", "token", "api", "zone", "route"])
    for (const phase of ["fetch", "json"]) {
      it(`ignores a prior create ${phase} receipt after ${boundary} replacement`, async () => {
        const pending = deferred();
        let oldRequest;
        const { harness, requests, props } = setup((request) => {
          if (request.method !== "POST") return undefined;
          oldRequest = request;
          return phase === "fetch"
            ? pending.promise
            : { status: 200, ok: true, json: () => pending.promise };
        });
        await press(harness, `Use details from ${source.name}`);
        await press(harness, "Add activity");
        harness.updateProps(
          boundary === "owner"
            ? { expectedOwnerUserId: "new-owner" }
            : boundary === "token"
              ? { accessToken: "new-token" }
              : boundary === "api"
                ? { apiBase: new URL("http://127.0.0.1:4001") }
                : boundary === "zone"
                  ? { profileTimeZone: "UTC" }
                  : { requestedDate: "2026-11-02" },
        );
        await harness.settle();
        let tree = await press(harness, `Use details from ${second.name}`);
        const before = requests.length;
        pending.resolve(phase === "fetch" ? receipt(oldRequest) : await receipt(oldRequest).json());
        tree = await harness.settle();
        expect(input(tree, names.name).props.value).toBe(second.name);
        expect(requests).toHaveLength(before);
        expect(props.onUnauthorized).not.toHaveBeenCalled();
      });
    }
});

describe("ActivityRoute identity boundary", () => {
  it("executes the actual route and remounts on owner, session, profile, zone or requested day changes", () => {
    const sourceText = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "App.tsx",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const route = parsed.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ActivityRoute",
    );
    expect(route).toBeDefined();
    const compiled = ts.transpileModule(
      `${route.getText(parsed)}\nglobalThis.renderRoute=ActivityRoute;`,
      {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    );
    let date = selectedDate;
    const context = createContext({
      React,
      ActivityScreen,
      useRoute: () => ({ params: { date } }),
    });
    new Script(compiled.outputText).runInContext(context);
    const props = {
      sessionEpoch: 7,
      session: { user: { id: "owner" }, profile: { revision: "12", timeZone: zone } },
    };
    const original = context.renderRoute(props);
    expect(original.type).toBe(ActivityScreen);
    for (const changed of [
      { ...props, sessionEpoch: 8 },
      { ...props, session: { ...props.session, user: { id: "next" } } },
      {
        ...props,
        session: { ...props.session, profile: { ...props.session.profile, revision: "13" } },
      },
      {
        ...props,
        session: { ...props.session, profile: { ...props.session.profile, timeZone: "UTC" } },
      },
    ])
      expect(context.renderRoute(changed).key).not.toBe(original.key);
    date = "2026-11-02";
    expect(context.renderRoute(props).key).not.toBe(original.key);
  });
});

const presetLabel = (minutes) => `Set activity duration to ${minutes} minutes`;
const presets = (tree) => [15, 30, 60].map((minutes) => button(tree, presetLabel(minutes)));

describe("native Activity Add duration presets", () => {
  for (const minutes of [15, 30, 60])
    it(`replaces only duration with ${minutes} minutes and preserves the exact default fold until explicit Add`, async () => {
      const energy = minutes === 30 ? "" : "0.001";
      const { harness, requests, writes } = setup();
      let tree = await fill(harness, { name: "Owner activity", duration: "9", energy });
      const count = requests.length;
      const original = JSON.stringify(source);
      tree = await press(harness, presetLabel(minutes));
      expect(input(tree, names.duration).props.value).toBe(String(minutes));
      expect(input(tree, names.name).props.value).toBe("Owner activity");
      expect(input(tree, names.energy).props.value).toBe(energy);
      expect(input(tree, names.date).props.value).toBe(selectedDate);
      expect(input(tree, names.time).props.value).toBe("01:30");
      expect(presets(tree).map((choice) => choice.props.accessibilityState.selected)).toEqual(
        [15, 30, 60].map((value) => value === minutes),
      );
      expect(requests).toHaveLength(count);
      expect(text(tree)).toContain("62 min");
      expect(JSON.stringify(source)).toBe(original);
      await press(harness, "Add activity");
      expect(writes()).toHaveLength(1);
      expect(JSON.parse(writes()[0].body)).toEqual({
        name: "Owner activity",
        durationMinutes: minutes,
        selfReportedEnergyKilocalories: energy || null,
        occurredAt: "2026-11-01T07:30:45.123Z",
      });
    });

  it("preserves a chosen date/time and exact calorie input", async () => {
    const { harness, requests, writes } = setup();
    await press(harness, "Next activity day");
    await fill(harness, { name: "Selected-day activity", time: "10:15", energy: "12.300" });
    const before = requests.length;
    const tree = await press(harness, presetLabel(60));
    expect(input(tree, names.energy).props.value).toBe("12.300");
    expect(requests).toHaveLength(before);
    await press(harness, "Add activity");
    expect(JSON.parse(writes()[0].body)).toEqual({
      name: "Selected-day activity",
      durationMinutes: 60,
      selfReportedEnergyKilocalories: "12.3",
      occurredAt: "2026-11-02T16:15:00.000Z",
    });
  });

  it("keeps custom whole-minute entry and existing bounds without selecting a shortcut", async () => {
    const { harness, writes } = setup();
    await fill(harness, { name: "Custom activity" });
    await press(harness, presetLabel(15));
    for (const duration of ["0", "1441"]) {
      let tree = await fill(harness, { duration });
      expect(presets(tree).every((choice) => !choice.props.accessibilityState.selected)).toBe(true);
      tree = await press(harness, "Add activity");
      expect(writes()).toHaveLength(0);
      expect(text(tree)).toContain("1");
    }
    for (const duration of ["1", "17", "1440"]) {
      const tree = await fill(harness, { name: "Custom activity", duration });
      expect(presets(tree).every((choice) => !choice.props.accessibilityState.selected)).toBe(true);
      await press(harness, "Add activity");
      expect(JSON.parse(writes().at(-1).body).durationMinutes).toBe(Number(duration));
    }
    expect(writes()).toHaveLength(3);
  });

  it("makes a repeated current preset a no-op so a current Add callback remains usable before paint", async () => {
    const { harness, requests, writes } = setup();
    await fill(harness, { name: "Repeat preset" });
    const tree = await press(harness, presetLabel(30));
    const same = button(tree, presetLabel(30)).props.onPress;
    const add = button(tree, "Add activity").props.onPress;
    const before = requests.length;
    same();
    same();
    expect(requests).toHaveLength(before);
    add();
    await harness.settle();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0].body).durationMinutes).toBe(30);
  });

  it("still treats re-entering the same visible start minute as an explicit time edit", async () => {
    const { harness, writes } = setup();
    await fill(harness, { name: "Explicit time" });
    let tree = await press(harness, presetLabel(15));
    const sameMinute = input(tree, names.time).props.value;
    tree = await fill(harness, { time: sameMinute });
    await press(harness, presetLabel(15));
    await press(harness, "Add activity");
    expect(JSON.parse(writes()[0].body).occurredAt).toBe("2026-11-01T06:30:00.000Z");
  });

  it("rejects retained pre-change Add, all Add fields and date actions after a changed preset", async () => {
    const { harness, requests, writes } = setup();
    const tree = await fill(harness, {
      name: "Current name",
      duration: "9",
      energy: "0.001",
      time: "10:15",
    });
    const fields = [names.name, names.duration, names.energy, names.time].map(
      (label) => input(tree, label).props.onChangeText,
    );
    const dateField = input(tree, names.date).props;
    const oldAdd = button(tree, "Add activity").props.onPress;
    const previous = button(tree, "Previous activity day").props.onPress;
    const next = button(tree, "Next activity day").props.onPress;
    const before = requests.length;
    button(tree, presetLabel(60)).props.onPress();
    for (const change of fields) change("stale");
    dateField.onChangeText("2026-11-02");
    dateField.onEndEditing({ nativeEvent: { text: "2026-11-02" } });
    previous();
    next();
    oldAdd();
    const current = await harness.settle();
    expect(input(current, names.name).props.value).toBe("Current name");
    expect(input(current, names.duration).props.value).toBe("60");
    expect(input(current, names.energy).props.value).toBe("0.001");
    expect(input(current, names.time).props.value).toBe("10:15");
    expect(input(current, names.date).props.value).toBe(selectedDate);
    expect(requests).toHaveLength(before);
    expect(writes()).toHaveLength(0);
  });

  it("preserves a reuse choice on same duration and invalidates it on changed duration", async () => {
    const { harness, writes } = setup();
    await fill(harness, { name: "Existing draft", duration: "30" });
    let tree = await press(harness, `Use details from ${source.name}`);
    const sameChoice = button(tree, "Replace details").props.onPress;
    button(tree, presetLabel(30)).props.onPress();
    sameChoice();
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe(source.name);
    tree = await press(harness, `Use details from ${second.name}`);
    const staleChoice = button(tree, "Replace details").props.onPress;
    button(tree, presetLabel(15)).props.onPress();
    staleChoice();
    tree = await harness.settle();
    expect(input(tree, names.name).props.value).toBe(source.name);
    expect(input(tree, names.duration).props.value).toBe("15");
    expect(text(tree)).not.toContain("Replace the Add details");
    expect(writes()).toHaveLength(0);
  });

  it("changes Add duration while preserving an independent active row editor", async () => {
    const { harness, writes } = setup();
    await fill(harness, { name: "New activity", energy: "0.001" });
    let tree = await press(harness, "Edit activity");
    input(tree, "Edit activity name").props.onChangeText("Edited original");
    tree = await harness.settle();
    expect(button(tree, presetLabel(30)).props.disabled).toBe(false);
    tree = await press(harness, presetLabel(30));
    expect(input(tree, "Edit activity name").props.value).toBe("Edited original");
    expect(input(tree, "Edit activity duration in whole minutes").props.value).toBe("45");
    expect(input(tree, names.duration).props.value).toBe("30");
    input(tree, "Edit activity duration in whole minutes").props.onChangeText("18");
    tree = await harness.settle();
    expect(input(tree, "Edit activity duration in whole minutes").props.value).toBe("18");
    expect(input(tree, names.duration).props.value).toBe("30");
    expect(writes()).toHaveLength(0);
  });

  it("disables presets during initial load and an active write, preserving accepted-write refresh behavior", async () => {
    const read = deferred();
    const write = deferred();
    let firstRead = true;
    let submitted;
    const { harness, writes } = setup((request) => {
      if (request.method === "POST") {
        submitted = request;
        return write.promise;
      }
      if (firstRead) {
        firstRead = false;
        return read.promise;
      }
      return undefined;
    });
    let tree = await harness.settle();
    expect(presets(tree).every((choice) => choice.props.disabled)).toBe(true);
    button(tree, presetLabel(15)).props.onPress();
    read.resolve(response(dayBody(selectedDate)));
    await fill(harness, { name: "Pending activity" });
    tree = await press(harness, presetLabel(15));
    const oldPreset = button(tree, presetLabel(60)).props.onPress;
    button(tree, "Add activity").props.onPress();
    oldPreset();
    tree = await harness.settle();
    expect(presets(tree).every((choice) => choice.props.disabled)).toBe(true);
    expect(input(tree, names.duration).props.value).toBe("15");
    write.resolve(receipt(submitted));
    tree = await harness.settle();
    expect(writes()).toHaveLength(1);
    expect(input(tree, names.duration).props.value).toBe("");
    expect(presets(tree).every((choice) => !choice.props.accessibilityState.selected)).toBe(true);
  });

  for (const boundary of ["date", "scope", "background", "unmount"])
    it(`retains existing preset availability and old-control rejection across ${boundary}`, async () => {
      const { harness, requests, writes } = setup();
      let tree = await fill(harness, { name: "Private draft", duration: "30" });
      const oldPreset = button(tree, presetLabel(60)).props.onPress;
      const before = requests.length;
      if (boundary === "date") {
        input(tree, names.date).props.onChangeText("2026-11-02");
        tree = await harness.settle();
      } else if (boundary === "scope") {
        harness.updateProps({ accessToken: "replacement-token" });
        tree = harness.renderWithoutEffects();
      } else if (boundary === "background") {
        appState("background");
        tree = await harness.settle();
      } else harness.unmount();
      if (boundary !== "unmount")
        expect(presets(tree).every((choice) => choice.props.disabled)).toBe(true);
      oldPreset();
      if (boundary !== "scope" && boundary !== "unmount") tree = await harness.settle();
      expect(requests).toHaveLength(before);
      expect(writes()).toHaveLength(0);
      if (boundary === "date") expect(input(tree, names.duration).props.value).toBe("30");
      if (boundary === "unmount") expect(harness.writesAfterUnmount).toBe(0);
    });

  it("keeps same-intent A→B→A exact body/key retry semantics after ambiguous saves", async () => {
    const { harness, writes } = setup((request) =>
      request.method === "POST" ? response({}, 503) : undefined,
    );
    await fill(harness, { name: "Retry activity", energy: "0.001" });
    await press(harness, presetLabel(15));
    await press(harness, "Add activity");
    const tree = await harness.settle();
    expect(presets(tree).every((choice) => choice.props.disabled)).toBe(true);
    await press(harness, "Retry day view");
    await press(harness, presetLabel(30));
    await press(harness, "Add activity");
    await press(harness, "Retry day view");
    await press(harness, presetLabel(15));
    await press(harness, presetLabel(15));
    await press(harness, "Add activity");
    expect(writes()).toHaveLength(3);
    expect(JSON.parse(writes()[0].body).durationMinutes).toBe(15);
    expect(JSON.parse(writes()[1].body).durationMinutes).toBe(30);
    expect(writes()[1].headers["idempotency-key"]).not.toBe(writes()[0].headers["idempotency-key"]);
    expect(writes()[2].body).toBe(writes()[0].body);
    expect(writes()[2].headers["idempotency-key"]).toBe(writes()[0].headers["idempotency-key"]);
  });
});
