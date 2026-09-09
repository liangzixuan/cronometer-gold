import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiaryScreen } from "../src/diary/DiaryScreen";
import { resetDiaryGroups } from "../src/diary/diary";

const hooks = vi.hoisted(() => ({ current: null }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
}));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: {}, digestStringAsync: vi.fn() }));
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
          tree = DiaryScreen(props);
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

function screenText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(screenText).join(" ");
  return value && typeof value === "object" ? screenText(value.props?.children) : "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile Today supporting-summary refresh", () => {
  it.each(["settled", "pending"])(
    "reloads %s summaries after a same-date outbox receipt while Today remains focused",
    async (initialState) => {
      const selectedDate = "2026-11-01";
      const heldRequests = [];
      const requests = [];
      const response = (kind) => ({
        status: 200,
        ok: true,
        json: async () => ({
          data: {
            localDate: selectedDate,
            timeZone: "America/Chicago",
            revision: "0",
            entries: [],
            ...(kind === "hydration" ? { totalMilliliters: 0 } : { totalDurationMinutes: 0 }),
            updatedAt: null,
          },
        }),
      });
      vi.stubGlobal("React", React);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input, options) => {
          const url = new URL(input);
          const kind =
            url.pathname === "/v1/hydration"
              ? "hydration"
              : url.pathname === "/v1/activities"
                ? "activity"
                : null;
          if (!kind) return { status: 503, ok: false, json: async () => ({}) };
          requests.push({ kind, date: url.searchParams.get("date"), signal: options.signal });
          if (initialState === "pending" && requests.length <= 2) {
            return new Promise((resolve) =>
              heldRequests.push(() => resolve({ status: 503, ok: false, json: async () => ({}) })),
            );
          }
          return response(kind);
        }),
      );
      let receiveReceipt;
      const props = {
        apiBase: new URL("http://127.0.0.1:4000"),
        accessToken: "synthetic-session",
        expectedOwnerUserId: "4afda2f8-e150-40ed-88f1-a327cd5e2430",
        sessionEpoch: 7,
        profileRevision: "12",
        profileTimeZone: "America/Chicago",
        diaryGroups: resetDiaryGroups(),
        requestedDate: selectedDate,
        supportingSummaryRefreshKey: 3,
        quickAddOutboxState: { status: "idle", pendingCount: 0 },
        quickAddOutboxController: {
          pendingDependencies: async () => ({
            correctedEntryIds: [],
            reorderedLocalDates: [],
            pendingLocalDates: [],
          }),
        },
        subscribeQuickAddReceipts: (listener) => {
          receiveReceipt = listener;
          return () => {
            receiveReceipt = undefined;
          };
        },
        onUnauthorized: vi.fn(),
      };
      const harness = screenHarness(props);
      try {
        const before = screenText(await harness.settle());
        expect(requests.map(({ kind }) => kind)).toEqual(["hydration", "activity"]);
        if (initialState === "settled") {
          expect(before).toContain("No plain-water entries on this date.");
          expect(before).toContain("No activities recorded on this local start date.");
        }

        receiveReceipt({ mutation: { affectedDays: [{ localDate: selectedDate }] } });
        const after = screenText(await harness.settle());
        expect(requests.map(({ kind }) => kind)).toEqual([
          "hydration",
          "activity",
          "hydration",
          "activity",
        ]);
        expect(requests.every(({ date }) => date === selectedDate)).toBe(true);
        expect(after).toContain("No plain-water entries on this date.");
        expect(after).toContain("No activities recorded on this local start date.");
        expect(after).not.toContain("Loading water logged");
        expect(after).not.toContain("Loading recorded duration");
        if (initialState === "pending") {
          expect(requests.slice(0, 2).every(({ signal }) => signal.aborted)).toBe(true);
          for (const settle of heldRequests) settle();
          expect(screenText(await harness.settle())).toBe(after);
        }
        expect(props.onUnauthorized).not.toHaveBeenCalled();
      } finally {
        harness.unmount();
      }
    },
  );
});
