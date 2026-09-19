import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import * as React from "react";
import { AccessibilityInfo, Alert, AppState } from "react-native";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HydrationScreen } from "../src/hydration/HydrationScreen";

const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set() }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
  useMemo: (...args) => hooks.current.useMemo(...args),
}));
vi.mock("../src/auth/operation-id", () => ({ newOperationId: vi.fn(() => crypto.randomUUID()) }));
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
          tree = HydrationScreen(props);
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
      tree = HydrationScreen(props);
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

function rawScreenText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawScreenText).join(" ");
  return value && typeof value === "object" ? rawScreenText(value.props?.children) : "";
}

const screenText = (value) => rawScreenText(value).replace(/\s+/gu, " ").trim();

afterEach(() => {
  hooks.appListeners.clear();
  AppState.currentState = "active";
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

const pressable = (tree, text) => {
  const found = nodes(tree, (item) => item.type === "Pressable" && screenText(item) === text);
  expect(found).toHaveLength(1);
  return found[0];
};
const input = (tree, label) => {
  const found = nodes(
    tree,
    (item) => item.type === "TextInput" && item.props.accessibilityLabel === label,
  );
  expect(found).toHaveLength(1);
  return found[0];
};
const initialEntry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  amountMilliliters: 375,
  occurredAt: "2026-11-01T07:30:45.250Z",
  localDate: "2026-11-01",
  localTime: "01:30:45.250",
  timeZone: "America/Chicago",
  createdAt: "2026-11-01T07:30:46.000Z",
};
function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function dayResponse(date, entries = [initialEntry], zone = "America/Chicago") {
  const retained = entries.filter((entry) => entry.localDate === date);
  return response({
    data: {
      localDate: date,
      timeZone: zone,
      revision: "6",
      entries: retained,
      totalMilliliters: retained.reduce((sum, entry) => sum + entry.amountMilliliters, 0),
      updatedAt: "2026-11-02T08:00:00.000Z",
    },
  });
}
function receipt(entry, moved = false) {
  return response({
    data: {
      replayed: false,
      entry,
      affectedDays: [
        { localDate: initialEntry.localDate, revision: "6" },
        ...(moved ? [{ localDate: entry.localDate, revision: "1" }] : []),
      ],
    },
  });
}
function setup(handler, overrides = {}) {
  const requests = [];
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      const request = { url: new URL(url), ...options };
      requests.push(request);
      return handler(request, requests);
    }),
  );
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-session",
    profileTimeZone: "America/Chicago",
    requestedDate: initialEntry.localDate,
    onUnauthorized: vi.fn(),
    ...overrides,
  };
  return { harness: screenHarness(props), requests, props };
}
async function editAmount(harness, value = "500") {
  pressable(await harness.settle(), "Edit amount").props.onPress();
  input(await harness.settle(), "Edit milliliters at 01:30").props.onChangeText(value);
  return harness.settle();
}

describe("mobile hydration correction screen", () => {
  it("preserves the later fold and fractional instant when only changing amount after a zone change", async () => {
    let current = initialEntry;
    const { harness, requests } = setup((request) => {
      if (request.method === "PATCH") {
        current = { ...current, revision: "3", amountMilliliters: 500 };
        return receipt(current);
      }
      return dayResponse(request.url.searchParams.get("date"), [current], "America/New_York");
    });
    try {
      const tree = await editAmount(harness);
      expect(screenText(tree)).toContain("Originally 2026-11-01 at 01:30:45.250 · America/Chicago");
      expect(
        nodes(tree, (item) => item.props?.accessibilityLabel === "Correction local time HH:MM"),
      ).toHaveLength(0);
      pressable(tree, "Save amount").props.onPress();
      expect(screenText(await harness.settle())).toContain("Hydration entry updated");
      const writes = requests.filter((request) => request.method === "PATCH");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0].body)).toEqual({ amountMilliliters: 500 });
      expect(writes[0].url.search).toBe("");
      expect(writes[0].headers["x-expected-profile-time-zone"]).toBeUndefined();
      expect(writes[0].headers["if-match"]).toBe('"2"');
      expect(current.occurredAt).toBe(initialEntry.occurredAt);
    } finally {
      harness.unmount();
    }
  });

  it("requires a repeated-time choice, clears it after edits, and submits the selected guarded instant", async () => {
    let current = initialEntry;
    const { harness, requests } = setup((request) => {
      if (request.method === "PATCH") {
        current = { ...current, revision: "3", ...JSON.parse(request.body), localTime: "01:30:00" };
        return receipt(current);
      }
      return dayResponse(request.url.searchParams.get("date"), [current]);
    });
    try {
      pressable(await editAmount(harness, "375"), "Change time").props.onPress();
      let tree = await harness.settle();
      const choices = nodes(tree, (item) => item.props?.accessibilityRole === "radio");
      expect(choices).toHaveLength(2);
      expect(choices.every((item) => item.props.accessibilityState.checked === false)).toBe(true);
      pressable(tree, "Save correction").props.onPress();
      expect(screenText(await harness.settle())).toContain(
        "Choose the earlier or later occurrence",
      );
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
      choices[1].props.onPress();
      tree = await harness.settle();
      input(tree, "Correction local time HH:MM").props.onChangeText("01:31");
      tree = await harness.settle();
      expect(
        nodes(tree, (item) => item.props?.accessibilityRole === "radio").every(
          (item) => !item.props.accessibilityState.checked,
        ),
      ).toBe(true);
      input(tree, "Correction local time HH:MM").props.onChangeText("01:30");
      tree = await harness.settle();
      nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.onPress();
      pressable(await harness.settle(), "Save correction").props.onPress();
      await harness.settle();
      const write = requests.find((request) => request.method === "PATCH");
      expect(write.url.searchParams.get("profileTimeZonePrecondition")).toBe("v1");
      expect(write.headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(JSON.parse(write.body)).toEqual({
        amountMilliliters: 375,
        occurredAt: "2026-11-01T07:30:00.000Z",
      });
    } finally {
      harness.unmount();
    }
  });

  it.each([null, 408, 429])(
    "retries an uncertain write through %s with identical bytes, revision, zone, and idempotency key",
    async (transientStatus) => {
      let writes = 0;
      let current = initialEntry;
      const { harness, requests } = setup((request) => {
        if (request.method === "PATCH") {
          writes += 1;
          if (writes === 1) throw new Error("Connection lost");
          if (writes === 2 && transientStatus)
            return response({ detail: "Retry temporarily unavailable" }, transientStatus);
          current = {
            ...current,
            revision: "3",
            ...JSON.parse(request.body),
            localTime: "01:30:00",
          };
          return receipt(current);
        }
        return dayResponse(request.url.searchParams.get("date"), [current]);
      });
      try {
        pressable(await editAmount(harness), "Change time").props.onPress();
        nodes(
          await harness.settle(),
          (item) => item.props?.accessibilityRole === "radio",
        )[1].props.onPress();
        pressable(await harness.settle(), "Save correction").props.onPress();
        const tree = await harness.settle();
        expect(input(tree, "Edit milliliters at 01:30").props.editable).toBe(false);
        expect(pressable(tree, "Save correction").props.disabled).toBe(true);
        expect(input(tree, "Correction local time HH:MM").props.editable).toBe(false);
        pressable(tree, "Retry saved change").props.onPress();
        if (transientStatus) {
          const retryTree = await harness.settle();
          expect(screenText(retryTree)).toContain("Acceptance is unconfirmed");
          expect(pressable(retryTree, "Save correction").props.disabled).toBe(true);
          pressable(retryTree, "Retry saved change").props.onPress();
        }
        expect(screenText(await harness.settle())).toContain("Hydration entry updated");
        const operations = requests.filter((request) => request.method === "PATCH");
        expect(operations).toHaveLength(transientStatus ? 3 : 2);
        expect(operations[0].headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
        expect(operations[0].url.searchParams.get("profileTimeZonePrecondition")).toBe("v1");
        expect(JSON.parse(operations[0].body).occurredAt).toBe("2026-11-01T07:30:00.000Z");
        for (const retry of operations.slice(1)) {
          expect(retry.body).toBe(operations[0].body);
          expect(retry.headers).toEqual(operations[0].headers);
          expect(retry.url.href).toBe(operations[0].url.href);
        }
      } finally {
        harness.unmount();
      }
    },
  );

  it("rejects a nonexistent time and preserves the original instant when time editing is canceled", async () => {
    let current = initialEntry;
    const { harness, requests } = setup((request) => {
      if (request.method === "PATCH") {
        current = { ...current, revision: "3", ...JSON.parse(request.body) };
        return receipt(current);
      }
      return dayResponse(request.url.searchParams.get("date"), [current]);
    });
    try {
      pressable(await editAmount(harness), "Change time").props.onPress();
      input(await harness.settle(), "Correction date YYYY-MM-DD").props.onChangeText("2026-03-08");
      input(await harness.settle(), "Correction local time HH:MM").props.onChangeText("02:30");
      let tree = await harness.settle();
      expect(screenText(tree)).toContain("This local time does not exist");
      pressable(tree, "Save correction").props.onPress();
      tree = await harness.settle();
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
      pressable(tree, "Keep original time").props.onPress();
      pressable(await harness.settle(), "Save amount").props.onPress();
      expect(screenText(await harness.settle())).toContain("Hydration entry updated");
      const write = requests.find((request) => request.method === "PATCH");
      expect(JSON.parse(write.body)).toEqual({ amountMilliliters: 500 });
      expect(write.headers["x-expected-profile-time-zone"]).toBeUndefined();
      expect(current.occurredAt).toBe(initialEntry.occurredAt);
    } finally {
      harness.unmount();
    }
  });

  it("announces a cross-day move and retries only the read after an accepted write", async () => {
    let current = initialEntry;
    let rejectRead = false;
    const { harness, requests } = setup((request) => {
      if (request.method === "PATCH") {
        current = {
          ...current,
          revision: "3",
          ...JSON.parse(request.body),
          localDate: "2026-11-02",
          localTime: "01:30:00",
        };
        rejectRead = true;
        return receipt(current, true);
      }
      if (rejectRead) {
        rejectRead = false;
        return response({}, 503);
      }
      return dayResponse(request.url.searchParams.get("date"), [current]);
    });
    try {
      pressable(await editAmount(harness), "Change time").props.onPress();
      input(await harness.settle(), "Correction date YYYY-MM-DD").props.onChangeText("2026-11-02");
      pressable(await harness.settle(), "Save correction").props.onPress();
      let tree = await harness.settle();
      expect(screenText(tree)).toContain("accepted and moved to 2026-11-02");
      expect(
        nodes(tree, (item) => item.type === "Pressable" && screenText(item) === "Save correction"),
      ).toHaveLength(0);
      pressable(tree, "Retry day view").props.onPress();
      tree = await harness.settle();
      expect(input(tree, "Hydration date YYYY-MM-DD").props.value).toBe("2026-11-01");
      pressable(tree, "View destination day 2026-11-02").props.onPress();
      tree = await harness.settle();
      expect(input(tree, "Hydration date YYYY-MM-DD").props.value).toBe("2026-11-02");
      expect(screenText(tree)).toContain("500 mL");
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  it.each([409, 412])(
    "requires reload and explicit reconfirmation after a %s conflict",
    async (status) => {
      const { harness, requests } = setup((request) =>
        request.method === "PATCH"
          ? response({ detail: "The entry or zone changed." }, status)
          : dayResponse(request.url.searchParams.get("date")),
      );
      try {
        pressable(await editAmount(harness), "Save amount").props.onPress();
        let tree = await harness.settle();
        expect(pressable(tree, "Save amount").props.disabled).toBe(true);
        expect(
          nodes(
            tree,
            (item) => item.type === "Pressable" && screenText(item) === "Retry saved change",
          ),
        ).toHaveLength(0);
        pressable(tree, "Reload before correcting").props.onPress();
        tree = await harness.settle();
        expect(input(tree, "Edit milliliters at 01:30").props.value).toBe("500");
        pressable(tree, "Discard edits and reload").props.onPress();
        tree = await harness.settle();
        expect(pressable(tree, "Edit amount").props.disabled).toBe(false);
        expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    },
  );

  it("does not accept a receipt for another subject or discard the exact retry operation", async () => {
    const { harness } = setup((request) =>
      request.method === "PATCH"
        ? receipt({
            ...initialEntry,
            id: "5eff67ee-721a-411e-b935-7699065c8d2a",
            revision: "3",
            amountMilliliters: 500,
          })
        : dayResponse(request.url.searchParams.get("date")),
    );
    try {
      pressable(await editAmount(harness), "Save amount").props.onPress();
      const tree = await harness.settle();
      expect(screenText(tree)).toContain("receipt does not match");
      expect(screenText(tree)).not.toContain("entry updated");
      expect(pressable(tree, "Retry saved change")).toBeDefined();
    } finally {
      harness.unmount();
    }
  });

  it.each(["unmount", "session", "zone"])(
    "ignores a late unauthorized write response after %s changes",
    async (change) => {
      let settleWrite;
      const { harness, requests, props } = setup((request) =>
        request.method === "PATCH"
          ? new Promise((resolve) => {
              settleWrite = resolve;
            })
          : dayResponse(request.url.searchParams.get("date")),
      );
      try {
        pressable(await editAmount(harness), "Save amount").props.onPress();
        await harness.settle();
        if (change === "unmount") harness.unmount();
        else {
          harness.updateProps(
            change === "session"
              ? { accessToken: "new-synthetic-session" }
              : { profileTimeZone: "America/New_York" },
          );
          await harness.settle();
        }
        expect(requests.find((request) => request.method === "PATCH").signal.aborted).toBe(true);
        settleWrite(response({}, 401));
        if (change !== "unmount") {
          const tree = await harness.settle();
          expect(pressable(tree, "Edit amount").props.disabled).toBe(false);
          expect(screenText(tree)).not.toContain("accepted");
        } else {
          for (let i = 0; i < 5; i += 1) await Promise.resolve();
        }
        expect(props.onUnauthorized).not.toHaveBeenCalled();
      } finally {
        harness.unmount();
      }
    },
  );
});

describe("mobile hydration retained native confirmation", () => {
  it.each(["unmount", "session", "zone", "date"])(
    "does not start a stale delete after %s changes",
    async (change) => {
      const { harness, requests } = setup((request) =>
        dayResponse(request.url.searchParams.get("date")),
      );
      try {
        let tree = await harness.settle();
        pressable(tree, "Delete").props.onPress();
        const confirm = Alert.alert.mock.calls
          .at(-1)[2]
          .find((button) => button.text === "Delete").onPress;
        if (change === "unmount") harness.unmount();
        else if (change === "date") {
          input(tree, "Hydration date YYYY-MM-DD").props.onSubmitEditing({
            nativeEvent: { text: "2026-11-02" },
          });
          tree = await harness.settle();
        } else {
          harness.updateProps(
            change === "session"
              ? { accessToken: "new-synthetic-session" }
              : { profileTimeZone: "America/New_York" },
          );
          tree = await harness.settle();
        }
        confirm();
        if (change !== "unmount") await harness.settle();
        expect(
          requests.filter((request) => request.method !== undefined && request.method !== "GET"),
        ).toHaveLength(0);
      } finally {
        harness.unmount();
      }
    },
  );
});

function addReceipt(request) {
  const body = JSON.parse(request.body);
  const instant = new Date(body.occurredAt);
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const localDate = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const milliseconds = instant.getUTCMilliseconds();
  const localTime = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
  return response({
    data: {
      replayed: false,
      entry: {
        ...initialEntry,
        ...body,
        id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
        revision: "1",
        localDate,
        localTime,
      },
      affectedDays: [{ localDate, revision: "7" }],
    },
  });
}
function presetSetup(responder = () => undefined) {
  return setup(
    async (request) =>
      (await responder(request)) ??
      (request.method === "POST"
        ? addReceipt(request)
        : dayResponse(request.url.searchParams.get("date"))),
  );
}
function pendingResponse() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const amountInput = (tree) => input(tree, "Hydration amount in milliliters");
const timeInput = (tree) => input(tree, "Hydration local time");
const dateInput = (tree) => input(tree, "Hydration date YYYY-MM-DD");
const writes = (requests) => requests.filter((request) => request.method === "POST");
async function click(harness, label) {
  pressable(await harness.settle(), label).props.onPress();
  return harness.settle();
}
function setAppState(next) {
  AppState.currentState = next;
  for (const listener of hooks.appListeners) listener(next);
}

describe("native hydration Add amount presets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T07:30:45.250Z"));
  });
  it("replaces only amount, supports manual custom values, and leaves history and requests unchanged", async () => {
    const { harness, requests } = presetSetup();
    try {
      let tree = await harness.settle();
      const before = requests.length;
      tree = await click(harness, "250 mL");
      expect(amountInput(tree).props.value).toBe("250");
      expect(pressable(tree, "250 mL").props.accessibilityState.selected).toBe(true);
      expect(pressable(tree, "500 mL").props.accessibilityState.selected).toBe(false);
      expect(timeInput(tree).props.value).toBe("01:30");
      expect(dateInput(tree).props.value).toBe(initialEntry.localDate);
      expect(screenText(tree)).toContain("375 mL");
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(
        "250 milliliters selected. Choose Add entry to save.",
      );
      tree = await click(harness, "500 mL");
      expect(amountInput(tree).props.value).toBe("500");
      amountInput(tree).props.onChangeText("1234");
      tree = await harness.settle();
      expect(amountInput(tree).props.value).toBe("1234");
      expect(pressable(tree, "250 mL").props.accessibilityState.selected).toBe(false);
      expect(pressable(tree, "500 mL").props.accessibilityState.selected).toBe(false);
      expect(requests).toHaveLength(before);
    } finally {
      harness.unmount();
    }
  });
  it("keeps repeated same-value choices usable and preserves the exact untouched fold until explicit Add", async () => {
    const { harness, requests } = presetSetup();
    try {
      let tree = await harness.settle();
      const first = pressable(tree, "250 mL").props.onPress;
      first();
      first();
      tree = await harness.settle();
      const same = pressable(tree, "250 mL").props.onPress;
      same();
      same();
      tree = await harness.settle();
      const submit = pressable(tree, "Add entry").props.onPress;
      submit();
      submit();
      tree = await harness.settle();
      expect(writes(requests)).toHaveLength(1);
      expect(JSON.parse(writes(requests)[0].body)).toEqual({
        amountMilliliters: 250,
        occurredAt: initialEntry.occurredAt,
      });
      expect(writes(requests)[0].headers["x-expected-profile-time-zone"]).toBe("America/Chicago");
      expect(writes(requests)[0].headers["if-match"]).toBeUndefined();
      expect(amountInput(tree).props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });
  it("rejects pre-preset Add, amount, time and date callbacks", async () => {
    const { harness, requests } = presetSetup();
    try {
      let tree = await harness.settle();
      const oldAdd = pressable(tree, "Add entry").props.onPress;
      const oldAmount = amountInput(tree).props.onChangeText;
      const oldTime = timeInput(tree).props.onChangeText;
      const oldDate = dateInput(tree).props.onChangeText;
      const oldBlur = dateInput(tree).props.onEndEditing;
      const oldNext = nodes(tree, (node) => node.props.accessibilityLabel === "Next day")[0].props
        .onPress;
      const oldPrevious = nodes(tree, (node) => node.props.accessibilityLabel === "Previous day")[0]
        .props.onPress;
      const before = requests.length;
      tree = await click(harness, "250 mL");
      oldAdd();
      oldAmount("999");
      oldTime("10:00");
      oldDate("2026-11-02");
      oldNext();
      oldPrevious();
      oldBlur({ nativeEvent: { text: "2026-11-03" } });
      tree = await harness.settle();
      expect(requests).toHaveLength(before);
      expect(amountInput(tree).props.value).toBe("250");
      expect(timeInput(tree).props.value).toBe("01:30");
      expect(dateInput(tree).props.value).toBe(initialEntry.localDate);
      expect(writes(requests)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });
  it("retains selected day and manually entered time across an amount choice", async () => {
    const { harness, requests } = presetSetup();
    try {
      let tree = await harness.settle();
      timeInput(tree).props.onChangeText("10:15");
      tree = await harness.settle();
      nodes(tree, (node) => node.props.accessibilityLabel === "Next day")[0].props.onPress();
      tree = await harness.settle();
      tree = await click(harness, "500 mL");
      expect(timeInput(tree).props.value).toBe("10:15");
      expect(dateInput(tree).props.value).toBe("2026-11-02");
      await click(harness, "Add entry");
      expect(JSON.parse(writes(requests)[0].body).occurredAt).toBe("2026-11-02T16:15:00.000Z");
    } finally {
      harness.unmount();
    }
  });
  it("preserves a row correction draft while choosing an Add amount", async () => {
    const { harness, requests } = presetSetup();
    try {
      let tree = await editAmount(harness, "456");
      const before = requests.length;
      tree = await click(harness, "500 mL");
      expect(input(tree, "Edit milliliters at 01:30").props.value).toBe("456");
      expect(amountInput(tree).props.value).toBe("500");
      expect(requests).toHaveLength(before);
    } finally {
      harness.unmount();
    }
  });
  for (const recovery of ["unchanged", "invalid"])
    it(`keeps fresh presets usable after ${recovery} date blur`, async () => {
      const { harness, requests } = presetSetup();
      try {
        let tree = await harness.settle();
        if (recovery === "invalid") {
          dateInput(tree).props.onChangeText("invalid");
          tree = await harness.settle();
          expect(pressable(tree, "250 mL").props.disabled).toBe(true);
        }
        dateInput(tree).props.onEndEditing({
          nativeEvent: { text: recovery === "invalid" ? "invalid" : initialEntry.localDate },
        });
        tree = await harness.settle();
        tree = await click(harness, "250 mL");
        expect(amountInput(tree).props.value).toBe("250");
        await click(harness, "Add entry");
        expect(writes(requests)).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    });
  it("fences a preset through date edit and restoration", async () => {
    const { harness } = presetSetup();
    try {
      let tree = await harness.settle();
      const old = pressable(tree, "500 mL").props.onPress;
      dateInput(tree).props.onChangeText("invalid");
      tree = await harness.settle();
      old();
      dateInput(tree).props.onChangeText(initialEntry.localDate);
      tree = await harness.settle();
      old();
      tree = await harness.settle();
      expect(amountInput(tree).props.value).toBe("");
      tree = await click(harness, "250 mL");
      expect(amountInput(tree).props.value).toBe("250");
    } finally {
      harness.unmount();
    }
  });
  it("freezes a pending request and key through uncertain acceptance and explicit retry", async () => {
    const held = pendingResponse();
    let attempt = 0;
    const { harness, requests } = presetSetup((request) => {
      if (request.method !== "POST") return undefined;
      return ++attempt === 1 ? held.promise : addReceipt(request);
    });
    try {
      let tree = await click(harness, "250 mL");
      const old = pressable(tree, "500 mL").props.onPress;
      pressable(tree, "Add entry").props.onPress();
      old();
      tree = await harness.settle();
      expect(pressable(tree, "500 mL").props.disabled).toBe(true);
      held.resolve(response({}, 503));
      tree = await harness.settle();
      pressable(tree, "500 mL").props.onPress();
      amountInput(tree).props.onChangeText("999");
      tree = await harness.settle();
      expect(amountInput(tree).props.value).toBe("250");
      tree = await click(harness, "Retry saved change");
      expect(writes(requests)).toHaveLength(2);
      expect(writes(requests)[1].body).toBe(writes(requests)[0].body);
      expect(writes(requests)[1].headers["idempotency-key"]).toBe(
        writes(requests)[0].headers["idempotency-key"],
      );
      old();
      tree = await harness.settle();
      expect(amountInput(tree).props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });
  for (const boundary of ["background", "replay"])
    it(`retains a pending operation across ${boundary} and ignores the aborted receipt before one exact retry`, async () => {
      const held = pendingResponse();
      let original;
      let attempt = 0;
      const { harness, requests } = presetSetup((request) => {
        if (request.method !== "POST") return undefined;
        original ??= request;
        return ++attempt === 1 ? held.promise : addReceipt(request);
      });
      try {
        await click(harness, "250 mL");
        await click(harness, "Add entry");
        if (boundary === "background") {
          setAppState("background");
          const tree = await harness.settle();
          expect(pressable(tree, "250 mL").props.disabled).toBe(true);
          setAppState("active");
        } else harness.replayEffects();
        let tree = await harness.settle();
        expect(writes(requests)).toHaveLength(1);
        expect(original.signal.aborted).toBe(true);
        const before = requests.length;
        held.resolve(addReceipt(original));
        tree = await harness.settle();
        expect(requests).toHaveLength(before);
        expect(amountInput(tree).props.value).toBe("250");
        tree = await click(harness, "Retry saved change");
        expect(writes(requests)).toHaveLength(2);
        expect(writes(requests)[1].body).toBe(writes(requests)[0].body);
        expect(writes(requests)[1].headers["idempotency-key"]).toBe(
          writes(requests)[0].headers["idempotency-key"],
        );
        expect(amountInput(tree).props.value).toBe("");
      } finally {
        harness.unmount();
      }
    });
  for (const boundary of ["token", "api", "zone", "route"])
    for (const phase of ["fetch", "json"])
      it(`fences prior ${phase} receipt and private draft on ${boundary} replacement`, async () => {
        const held = pendingResponse();
        let original;
        const { harness, requests, props } = presetSetup((request) => {
          if (request.method !== "POST") return undefined;
          original = request;
          return phase === "fetch"
            ? held.promise
            : { status: 200, ok: true, json: () => held.promise };
        });
        try {
          let tree = await click(harness, "250 mL");
          const old = pressable(tree, "500 mL").props.onPress;
          await click(harness, "Add entry");
          harness.updateProps(
            boundary === "token"
              ? { accessToken: "fresh-token" }
              : boundary === "api"
                ? { apiBase: new URL("http://127.0.0.1:4001") }
                : boundary === "zone"
                  ? { profileTimeZone: "UTC" }
                  : { requestedDate: "2026-11-02" },
          );
          tree = harness.renderWithoutEffects();
          old();
          expect(amountInput(tree).props.value).toBe("");
          expect(timeInput(tree).props.value).toBe("");
          harness.flushEffects();
          tree = await harness.settle();
          expect(amountInput(tree).props.value).toBe("");
          tree = await click(harness, "500 mL");
          const before = requests.length;
          held.resolve(
            phase === "fetch" ? addReceipt(original) : await addReceipt(original).json(),
          );
          tree = await harness.settle();
          expect(amountInput(tree).props.value).toBe("500");
          expect(requests).toHaveLength(before);
          expect(props.onUnauthorized).not.toHaveBeenCalled();
        } finally {
          harness.unmount();
        }
      });
  it("clears an accepted amount before failed read recovery and retries only the day", async () => {
    let rejectedRead = false;
    const { harness, requests } = presetSetup((request) => {
      if (request.method === "POST") {
        rejectedRead = true;
        return addReceipt(request);
      }
      if (rejectedRead) {
        rejectedRead = false;
        return response({}, 503);
      }
      return undefined;
    });
    try {
      await click(harness, "250 mL");
      let tree = await click(harness, "Add entry");
      expect(amountInput(tree).props.value).toBe("");
      expect(screenText(tree)).toContain("change was accepted");
      expect(pressable(tree, "500 mL").props.disabled).toBe(true);
      tree = await click(harness, "Retry day view");
      expect(writes(requests)).toHaveLength(1);
      expect(amountInput(tree).props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });
  it("keeps presets unavailable until a conflict reload is complete", async () => {
    const { harness } = presetSetup((request) =>
      request.method === "POST" ? response({}, 412) : undefined,
    );
    try {
      await click(harness, "250 mL");
      let tree = await click(harness, "Add entry");
      expect(pressable(tree, "500 mL").props.disabled).toBe(true);
      pressable(tree, "500 mL").props.onPress();
      tree = await harness.settle();
      expect(amountInput(tree).props.value).toBe("250");
      tree = await click(harness, "Reload before correcting");
      tree = await click(harness, "500 mL");
      expect(amountInput(tree).props.value).toBe("500");
    } finally {
      harness.unmount();
    }
  });
  it("keeps explicit401 closure across replay and rejects retained preset actions", async () => {
    let closed = false;
    const { harness, props, requests } = presetSetup(() =>
      closed ? response({}, 401) : undefined,
    );
    try {
      let tree = await click(harness, "250 mL");
      const old = pressable(tree, "500 mL").props.onPress;
      closed = true;
      nodes(tree, (node) => node.props.accessibilityLabel === "Next day")[0].props.onPress();
      tree = await harness.settle();
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
      const before = requests.length;
      harness.replayEffects();
      tree = await harness.settle();
      old();
      expect(requests).toHaveLength(before);
      expect(amountInput(tree).props.value).toBe("");
      expect(pressable(tree, "250 mL").props.disabled).toBe(true);
    } finally {
      harness.unmount();
    }
  });
  it("ignores a receipt and preset callback after unmount without state writes", async () => {
    const held = pendingResponse();
    let original;
    const { harness } = presetSetup((request) => {
      if (request.method !== "POST") return undefined;
      original = request;
      return held.promise;
    });
    const tree = await click(harness, "250 mL");
    const old = pressable(tree, "500 mL").props.onPress;
    await click(harness, "Add entry");
    harness.unmount();
    old();
    held.resolve(addReceipt(original));
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
  });
});

describe("native HydrationRoute identity boundary", () => {
  it("executes the actual route key that remounts on owner/session/profile/zone/date changes", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "App.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const route = parsed.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "HydrationRoute",
    );
    expect(route).toBeDefined();
    const compiled = ts.transpileModule(
      `${route.getText(parsed)}\nglobalThis.renderRoute = HydrationRoute;`,
      {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    );
    let date = initialEntry.localDate;
    const context = createContext({
      React,
      HydrationScreen,
      useRoute: () => ({ params: { date } }),
    });
    new Script(compiled.outputText).runInContext(context);
    const props = {
      sessionEpoch: 7,
      session: { user: { id: "owner" }, profile: { revision: "12", timeZone: "America/Chicago" } },
    };
    const original = context.renderRoute(props);
    expect(original.type).toBe(HydrationScreen);
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

const correctionAmount = (tree) => input(tree, "Edit milliliters at 01:30");
const otherEntry = {
  ...initialEntry,
  id: "5bcfa2bf-4950-43f7-9f24-b983ac803012",
  occurredAt: "2026-11-01T08:30:00.000Z",
  localTime: "02:30:00",
};
const correctionChoices = (tree) =>
  nodes(tree, (item) => item.props?.accessibilityLabel === "Unsaved hydration correction");
const labeledButton = (tree, label) =>
  nodes(tree, (item) => item.type === "Pressable" && item.props.accessibilityLabel === label)[0];
function draftSetup(responder = () => undefined) {
  return setup(
    async (request, requests) =>
      (await responder(request, requests)) ?? dayResponse(request.url.searchParams.get("date")),
  );
}
async function foldedDraft(harness) {
  await editAmount(harness, "500");
  await click(harness, "Change time");
  const tree = await harness.settle();
  nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.onPress();
  return harness.settle();
}
function expectFoldedDraft(tree, amount = "500") {
  expect(correctionAmount(tree).props.value).toBe(amount);
  expect(input(tree, "Correction date YYYY-MM-DD").props.value).toBe(initialEntry.localDate);
  expect(input(tree, "Correction local time HH:MM").props.value).toBe("01:30");
  expect(
    nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.accessibilityState
      .checked,
  ).toBe(true);
}

describe("native hydration correction draft protection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00.000Z"));
  });
  it.each(["Cancel", "Previous day", "Next day", "Jump to today", "typed day", "another row"])(
    "keeps exact correction fields and selected day before explicit %s discard",
    async (action) => {
      const { harness, requests } = draftSetup((request) =>
        dayResponse(request.url.searchParams.get("date"), [initialEntry, otherEntry]),
      );
      try {
        let tree = await harness.settle();
        nodes(
          tree,
          (item) => item.type === "Pressable" && screenText(item) === "Edit amount",
        )[0].props.onPress();
        correctionAmount(await harness.settle()).props.onChangeText("00500");
        tree = await click(harness, "Change time");
        nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.onPress();
        tree = await harness.settle();
        const count = requests.length;
        if (action === "Previous day" || action === "Next day")
          labeledButton(tree, action).props.onPress();
        else if (action === "typed day") {
          dateInput(tree).props.onChangeText("2026-11-03");
          tree = await harness.settle();
          dateInput(tree).props.onSubmitEditing({ nativeEvent: { text: "2026-11-03" } });
        } else if (action === "another row") pressable(tree, "Edit amount").props.onPress();
        else pressable(tree, action).props.onPress();
        tree = await harness.settle();
        expect(correctionChoices(tree)).toHaveLength(1);
        expectFoldedDraft(tree, "00500");
        expect(requests).toHaveLength(count);
        tree = await click(harness, "Keep editing");
        expectFoldedDraft(tree, "00500");
        expect(dateInput(tree).props.value).toBe(initialEntry.localDate);
        expect(correctionChoices(tree)).toHaveLength(0);
        expect(requests).toHaveLength(count);
        if (action === "Previous day" || action === "Next day")
          labeledButton(tree, action).props.onPress();
        else if (action === "typed day")
          dateInput(tree).props.onSubmitEditing({ nativeEvent: { text: "2026-11-03" } });
        else if (action === "another row") pressable(tree, "Edit amount").props.onPress();
        else pressable(tree, action).props.onPress();
        tree = await harness.settle();
        const label =
          action === "Cancel"
            ? "Discard edits"
            : action === "another row"
              ? "Discard edits and open entry"
              : "Discard edits and change day";
        const discard = pressable(tree, label).props.onPress;
        discard();
        discard();
        tree = await harness.settle();
        expect(correctionChoices(tree)).toHaveLength(0);
        if (action === "another row") {
          expect(input(tree, "Edit milliliters at 02:30").props.value).toBe("375");
          expect(requests).toHaveLength(count);
        } else {
          expect(
            nodes(tree, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
          ).toHaveLength(0);
          expect(requests).toHaveLength(action === "Cancel" ? count : count + 1);
        }
        expect(requests.every((request) => !request.method)).toBe(true);
      } finally {
        harness.unmount();
      }
    },
  );
  it.each(["add", "delete"])(
    "preserves a correction through unrelated accepted %s and pins its revision",
    async (kind) => {
      let accepted = false;
      const { harness, requests } = draftSetup((request) => {
        if (request.method === "POST") {
          accepted = true;
          return addReceipt(request);
        }
        if (request.method === "DELETE") {
          accepted = true;
          return receipt(null);
        }
        if (request.method === "PATCH") return response({}, 412);
        return dayResponse(request.url.searchParams.get("date"), [
          accepted ? { ...initialEntry, revision: "3", amountMilliliters: 999 } : initialEntry,
          ...(kind === "delete" && !accepted ? [otherEntry] : []),
        ]);
      });
      try {
        let tree = await harness.settle();
        nodes(
          tree,
          (item) => item.type === "Pressable" && screenText(item) === "Edit amount",
        )[0].props.onPress();
        correctionAmount(await harness.settle()).props.onChangeText("500");
        tree = await click(harness, "Change time");
        nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.onPress();
        tree = await harness.settle();
        if (kind === "add") {
          timeInput(tree).props.onChangeText("12:00");
          tree = await click(harness, "250 mL");
          pressable(tree, "Add entry").props.onPress();
        } else {
          pressable(tree, "Delete").props.onPress();
          Alert.alert.mock.calls
            .at(-1)[2]
            .find((item) => item.text === "Delete")
            .onPress();
        }
        tree = await harness.settle();
        expectFoldedDraft(tree);
        pressable(tree, "Save correction").props.onPress();
        await harness.settle();
        expect(requests.find((item) => item.method === "PATCH").headers["if-match"]).toBe('"2"');
      } finally {
        harness.unmount();
      }
    },
  );
  it.each([409, 412])(
    "retains the conflicted draft until explicit successful reload after %s",
    async (status) => {
      let rejectRead = false;
      const { harness, requests } = draftSetup((request) => {
        if (request.method === "PATCH") return response({}, status);
        if (rejectRead) return response({}, 503);
        return dayResponse(request.url.searchParams.get("date"));
      });
      try {
        let tree = await foldedDraft(harness);
        pressable(tree, "Save correction").props.onPress();
        tree = await harness.settle();
        const count = requests.length;
        pressable(tree, "Reload before correcting").props.onPress();
        tree = await harness.settle();
        expect(correctionChoices(tree)).toHaveLength(1);
        expectFoldedDraft(tree);
        expect(requests).toHaveLength(count);
        tree = await click(harness, "Keep editing");
        expectFoldedDraft(tree);
        expect(pressable(tree, "Save correction").props.disabled).toBe(true);
        await click(harness, "Reload before correcting");
        rejectRead = true;
        tree = await click(harness, "Discard edits and reload");
        expectFoldedDraft(tree);
        expect(pressable(tree, "Save correction").props.disabled).toBe(true);
        rejectRead = false;
        tree = await click(harness, "Retry day view");
        expectFoldedDraft(tree);
        expect(pressable(tree, "Save correction").props.disabled).toBe(true);
        await click(harness, "Reload before correcting");
        tree = await click(harness, "Discard edits and reload");
        expect(
          nodes(tree, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
        ).toHaveLength(0);
        expect(pressable(tree, "Edit amount").props.disabled).toBe(false);
        expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    },
  );
});

describe("native hydration draft boundary regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00.000Z"));
  });
  it("keeps pristine transitions direct and treats entering time mode as a dirty correction", async () => {
    const { harness, requests } = draftSetup();
    try {
      let tree = await click(harness, "Edit amount");
      tree = await click(harness, "Cancel");
      expect(correctionChoices(tree)).toHaveLength(0);
      await click(harness, "Edit amount");
      tree = await click(harness, "Change time");
      tree = await click(harness, "Cancel");
      expect(correctionChoices(tree)).toHaveLength(1);
      await click(harness, "Keep editing");
      await click(harness, "Keep original time");
      tree = await click(harness, "Cancel");
      expect(correctionChoices(tree)).toHaveLength(0);
      await click(harness, "Edit amount");
      labeledButton(await harness.settle(), "Next day").props.onPress();
      tree = await harness.settle();
      expect(correctionChoices(tree)).toHaveLength(0);
      expect(dateInput(tree).props.value).toBe("2026-11-02");
      expect(requests).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });
  it("preserves a dirty correction across same-day and invalid date submission", async () => {
    const { harness, requests } = draftSetup();
    try {
      let tree = await foldedDraft(harness);
      dateInput(tree).props.onEndEditing({ nativeEvent: { text: initialEntry.localDate } });
      tree = await harness.settle();
      dateInput(tree).props.onChangeText("not-a-day");
      tree = await harness.settle();
      dateInput(tree).props.onSubmitEditing({ nativeEvent: { text: "not-a-day" } });
      tree = await harness.settle();
      expectFoldedDraft(tree);
      expect(correctionChoices(tree)).toHaveLength(0);
      expect(dateInput(tree).props.value).toBe(initialEntry.localDate);
      expect(requests).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });
  it("fences retained Save, Cancel, date and choice callbacks synchronously when an edit changes", async () => {
    const { harness, requests } = draftSetup();
    try {
      let tree = await editAmount(harness);
      const save = pressable(tree, "Save amount").props.onPress;
      const cancel = pressable(tree, "Cancel").props.onPress;
      const next = labeledButton(tree, "Next day").props.onPress;
      correctionAmount(tree).props.onChangeText("501");
      save();
      cancel();
      next();
      tree = await harness.settle();
      expect(correctionAmount(tree).props.value).toBe("501");
      expect(correctionChoices(tree)).toHaveLength(0);
      tree = await click(harness, "Cancel");
      const keep = pressable(tree, "Keep editing").props.onPress;
      const discard = pressable(tree, "Discard edits").props.onPress;
      correctionAmount(tree).props.onChangeText("502");
      keep();
      discard();
      tree = await harness.settle();
      expect(correctionAmount(tree).props.value).toBe("502");
      expect(correctionChoices(tree)).toHaveLength(0);
      expect(requests).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });
  it("makes choices reachable at their measured anchor and announces them", async () => {
    const { harness } = draftSetup();
    try {
      const tree = await editAmount(harness);
      const scroll = nodes(tree, (item) => item.type === "ScrollView")[0];
      const scrollTo = vi.fn();
      scroll.props.ref.current = { scrollTo };
      const anchor = nodes(
        tree,
        (item) => item.type === "View" && typeof item.props.onLayout === "function",
      )[0];
      anchor.props.onLayout({ nativeEvent: { layout: { y: 321 } } });
      pressable(tree, "Cancel").props.onPress();
      expect(scrollTo).toHaveBeenCalledWith({ y: 321, animated: true });
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(
        "Your hydration correction has unsaved edits. Keep editing or explicitly discard edits to continue.",
      );
    } finally {
      harness.unmount();
    }
  });
  it.each([
    { accessToken: "replacement-session" },
    { apiBase: new URL("http://127.0.0.1:4001") },
    { profileTimeZone: "America/New_York" },
    { requestedDate: "2026-11-02" },
  ])(
    "hides retained correction and choices before effects after scope replacement %j",
    async (changed) => {
      const { harness, requests } = draftSetup();
      try {
        await foldedDraft(harness);
        const tree = await click(harness, "Cancel");
        const oldDiscard = pressable(tree, "Discard edits").props.onPress;
        const oldSave = pressable(tree, "Save correction").props.onPress;
        const count = requests.length;
        harness.updateProps(changed);
        const hidden = harness.renderWithoutEffects();
        expect(correctionChoices(hidden)).toHaveLength(0);
        expect(
          nodes(hidden, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
        ).toHaveLength(0);
        oldDiscard();
        oldSave();
        expect(requests).toHaveLength(count);
        harness.flushEffects();
        await harness.settle();
      } finally {
        harness.unmount();
      }
    },
  );
  it("invalidates background and unmounted choices without losing the current-scope foreground draft", async () => {
    const { harness, requests } = draftSetup();
    try {
      await foldedDraft(harness);
      let tree = await click(harness, "Cancel");
      const discard = pressable(tree, "Discard edits").props.onPress;
      setAppState("background");
      discard();
      tree = await harness.settle();
      expect(correctionChoices(tree)).toHaveLength(0);
      expect(
        nodes(tree, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
      ).toHaveLength(0);
      setAppState("active");
      tree = await harness.settle();
      expectFoldedDraft(tree);
      discard();
      expectFoldedDraft(await harness.settle());
      tree = await click(harness, "Cancel");
      const latestDiscard = pressable(tree, "Discard edits").props.onPress;
      const count = requests.length;
      harness.unmount();
      latestDiscard();
      expect(requests).toHaveLength(count);
      expect(harness.writesAfterUnmount).toBe(0);
    } finally {
      harness.unmount();
    }
  });
  it("retains an orphan correction after unrelated Add without adding it to the authoritative day total", async () => {
    let accepted = false;
    const { harness, requests } = draftSetup((request) => {
      if (request.method === "POST") {
        accepted = true;
        return addReceipt(request);
      }
      if (request.method === "PATCH") return response({}, 412);
      return dayResponse(request.url.searchParams.get("date"), accepted ? [] : [initialEntry]);
    });
    try {
      await foldedDraft(harness);
      await click(harness, "250 mL");
      timeInput(await harness.settle()).props.onChangeText("12:00");
      let tree = await click(harness, "Add entry");
      expectFoldedDraft(tree);
      expect(
        screenText(
          nodes(
            tree,
            (item) => item.props?.accessibilityLabel === "Exact local-day hydration total",
          )[0],
        ),
      ).toContain("0 mL");
      expect(screenText(tree)).toContain("0 of 64 maximum");
      expect(screenText(tree)).toContain("this entry is not in the loaded day");
      expect(pressable(tree, "Save correction").props.disabled).toBe(true);
      pressable(tree, "Save correction").props.onPress();
      await harness.settle();
      expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(0);
      await click(harness, "Reload before correcting");
      tree = await click(harness, "Discard edits and reload");
      expect(
        nodes(tree, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
      ).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });
  it("shows the retained correction after failed unrelated-delete refresh and retries only the day", async () => {
    let accepted = false;
    let failRead = false;
    const { harness, requests } = draftSetup((request) => {
      if (request.method === "DELETE") {
        accepted = true;
        failRead = true;
        return receipt(null);
      }
      if (failRead) return response({}, 503);
      return dayResponse(request.url.searchParams.get("date"), [
        initialEntry,
        ...(!accepted ? [otherEntry] : []),
      ]);
    });
    try {
      let tree = await harness.settle();
      nodes(
        tree,
        (item) => item.type === "Pressable" && screenText(item) === "Edit amount",
      )[0].props.onPress();
      correctionAmount(await harness.settle()).props.onChangeText("500");
      tree = await click(harness, "Change time");
      nodes(tree, (item) => item.props?.accessibilityRole === "radio")[1].props.onPress();
      tree = await harness.settle();
      pressable(tree, "Delete").props.onPress();
      Alert.alert.mock.calls
        .at(-1)[2]
        .find((item) => item.text === "Delete")
        .onPress();
      tree = await harness.settle();
      expectFoldedDraft(tree);
      expect(pressable(tree, "Save correction").props.disabled).toBe(true);
      failRead = false;
      tree = await click(harness, "Retry day view");
      expectFoldedDraft(tree);
      expect(pressable(tree, "Save correction").props.disabled).toBe(false);
      expect(requests.filter((item) => item.method === "DELETE")).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });
  it("keeps the captured time zone through ordinary refresh and clears it only after successful explicit recovery", async () => {
    let zone = "America/Chicago";
    let failRead = false;
    const { harness, requests } = draftSetup((request) => {
      if (request.method === "POST") {
        zone = "America/New_York";
        return addReceipt(request);
      }
      if (request.method === "PATCH") return response({}, 409);
      if (failRead) return response({}, 503);
      return dayResponse(request.url.searchParams.get("date"), [initialEntry], zone);
    });
    try {
      await foldedDraft(harness);
      await click(harness, "250 mL");
      timeInput(await harness.settle()).props.onChangeText("12:00");
      let tree = await click(harness, "Add entry");
      expectFoldedDraft(tree);
      expect(screenText(tree)).toContain("Change time in America/Chicago");
      tree = await click(harness, "Save correction");
      expect(screenText(tree)).toContain("profile time zone changed");
      expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(0);
      expect(pressable(tree, "Save correction").props.disabled).toBe(true);
      await click(harness, "Reload before correcting");
      tree = await click(harness, "Keep editing");
      expectFoldedDraft(tree);
      await click(harness, "Reload before correcting");
      failRead = true;
      tree = await click(harness, "Discard edits and reload");
      expectFoldedDraft(tree);
      expect(pressable(tree, "Save correction").props.disabled).toBe(true);
      failRead = false;
      await click(harness, "Reload before correcting");
      tree = await click(harness, "Discard edits and reload");
      expect(pressable(tree, "Edit amount").props.disabled).toBe(false);
      tree = await click(harness, "Edit amount");
      tree = await click(harness, "Change time");
      expect(screenText(tree)).toContain("Change time in America/New_York");
    } finally {
      harness.unmount();
    }
  });
  it.each(["wrong day", "malformed"])(
    "retains the conflict guard after a %s recovery response",
    async (failure) => {
      let conflicting = false;
      const { harness } = draftSetup((request) => {
        if (request.method === "PATCH") {
          conflicting = true;
          return response({}, 412);
        }
        if (conflicting)
          return failure === "wrong day" ? dayResponse("2026-11-02") : response({ data: {} });
        return dayResponse(request.url.searchParams.get("date"));
      });
      try {
        await foldedDraft(harness);
        await click(harness, "Save correction");
        await click(harness, "Reload before correcting");
        const tree = await click(harness, "Discard edits and reload");
        expectFoldedDraft(tree);
        expect(pressable(tree, "Save correction").props.disabled).toBe(true);
        expect(pressable(tree, "Reload before correcting")).toBeDefined();
      } finally {
        harness.unmount();
      }
    },
  );
  it("rejects stale conflict-choice callbacks and late recovery after session change", async () => {
    let conflict = false;
    const held = pendingResponse();
    const { harness, requests } = draftSetup((request) => {
      if (request.method === "PATCH") {
        conflict = true;
        return response({}, 412);
      }
      if (conflict) return held.promise;
      return dayResponse(request.url.searchParams.get("date"));
    });
    try {
      await foldedDraft(harness);
      await click(harness, "Save correction");
      let tree = await click(harness, "Reload before correcting");
      const discard = pressable(tree, "Discard edits and reload").props.onPress;
      const oldSave = pressable(tree, "Save correction").props.onPress;
      discard();
      discard();
      oldSave();
      tree = await harness.settle();
      expectFoldedDraft(tree);
      expect(pressable(tree, "Save correction").props.disabled).toBe(true);
      expect(requests).toHaveLength(3);
      harness.updateProps({ accessToken: "replacement" });
      harness.renderWithoutEffects();
      held.resolve(dayResponse(initialEntry.localDate));
      harness.flushEffects();
      tree = await harness.settle();
      expect(
        nodes(tree, (item) => item.props?.accessibilityLabel === "Edit milliliters at 01:30"),
      ).toHaveLength(0);
      expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });
});
