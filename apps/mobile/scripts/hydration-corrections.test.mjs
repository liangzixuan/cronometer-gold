import * as React from "react";
import { Alert } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HydrationScreen } from "../src/hydration/HydrationScreen";

const hooks = vi.hoisted(() => ({ current: null }));

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
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => {
        previous?.cleanup?.();
        slots[index].cleanup = effect();
      });
    },
    async settle() {
      for (let turn = 0; turn < 30; turn += 1) {
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
    unmount() {
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
