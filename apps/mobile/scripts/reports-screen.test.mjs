import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { NUTRITION_REPORT_NOTICE } from "@nutrition-tracker/contracts";
import * as React from "react";
import { AppState } from "react-native";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedRoutes } from "../src/navigation/routes";
import { ReportsScreen } from "../src/reports/ReportsScreen";
import { nutritionReportLocalDates } from "../src/reports/reports";

const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set() }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
  useMemo: (...args) => hooks.current.useMemo(...args),
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
          tree = ReportsScreen(props);
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
      tree = ReportsScreen(props);
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  hooks.appListeners.clear();
  AppState.currentState = "active";
});

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== "object") return [];
  if (typeof tree.type === "function") return nodes(tree.type(tree.props), predicate);
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

const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const definitions = [
  ["energy", "Energy", "kcal", "energy"],
  ["protein", "Protein", "g", "macronutrient"],
  ["carbohydrate", "Carbohydrate", "g", "macronutrient"],
  ["fat", "Fat", "g", "macronutrient"],
  ["fiber", "Fiber", "g", "macronutrient"],
  ["sugars", "Sugars", "g", "macronutrient"],
  ["sodium", "Sodium", "mg", "mineral"],
  ["potassium", "Potassium", "mg", "mineral"],
  ["calcium", "Calcium", "mg", "mineral"],
  ["iron", "Iron", "mg", "mineral"],
  ["vitamin-c", "Vitamin C", "mg", "vitamin"],
  ["vitamin-d", "Vitamin D", "ug", "vitamin"],
  ["vitamin-b12", "Vitamin B12", "ug", "vitamin"],
  ["folate-dfe", "Folate DFE", "ug_DFE", "vitamin"],
  ["vitamin-a-rae", "Vitamin A RAE", "ug_RAE", "vitamin"],
];
function fixture(from, to, props) {
  const dates = nutritionReportLocalDates(from, to);
  return {
    data: {
      ownerUserId: props.expectedOwnerUserId,
      profileRevision: props.profileRevision,
      timeZone: props.profileTimeZone,
      watermarkRevision: "9",
      snapshotAt: "2026-09-10T12:00:00.000Z",
      dateBasis: "active-profile-time-zone-v1",
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      from,
      to,
      notice: NUTRITION_REPORT_NOTICE,
      days: dates.map((date) => {
        const start = new Date(`${date}T00:00:00.000Z`);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        return {
          localDate: date,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          entryCount: 0,
          sourceDiaries: [],
          sourceTimeZones: [],
        };
      }),
      goalVersions: [],
      targetSegments: [{ from, to, goalVersionId: null }],
      series: definitions.map(([code, name, unit, category], index) => ({
        nutrient: { id: String(index + 1), code, name, unit, category },
        scalePolicy: "max-intake-or-saved-threshold-v1",
        scaleMaximum: "1",
        summary: {
          completeDays: 0,
          diaryDays: 0,
          exactDays: 0,
          missingDays: dates.length,
          partialDays: 0,
          traceDays: 0,
          unknownDays: 0,
        },
        points: dates.map((localDate) => ({
          aggregate: null,
          comparison: null,
          goalVersionId: null,
          knownPercentOfScale: null,
          localDate,
          maximumPercentOfScale: null,
          minimumPercentOfScale: null,
          targetPercentOfScale: null,
        })),
      })),
    },
  };
}
function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(handler = () => undefined) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
  vi.stubGlobal("React", React);
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "report-token",
    expectedOwnerUserId: owner,
    profileRevision: "4",
    profileTimeZone: "UTC",
    sessionEpoch: 1,
    isFocused: true,
    onDiary: vi.fn(),
    onUnauthorized: vi.fn(async () => {}),
  };
  const requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      const request = { url: new URL(url), method: "GET", ...options };
      requests.push(request);
      const result = handler(request, props);
      if (result !== undefined) return result;
      return response(
        fixture(request.url.searchParams.get("from"), request.url.searchParams.get("to"), props),
      );
    }),
  );
  const harness = screenHarness(props);
  const updateProps = (next) => {
    Object.assign(props, next);
    harness.updateProps(next);
  };
  return { harness, requests, props, updateProps };
}
const startInput = (tree) => input(tree, "Report start date YYYY-MM-DD");
const endInput = (tree) => input(tree, "Report end date YYYY-MM-DD");
const rangeValues = (tree) => [startInput(tree).props.value, endInput(tree).props.value];
async function click(harness, label) {
  const button = pressable(await harness.settle(), label);
  expect(button.props.disabled).not.toBe(true);
  button.props.onPress();
  return harness.settle();
}
async function applyRange(harness, from, to) {
  const tree = await harness.settle();
  startInput(tree).props.onChangeText(from);
  endInput(tree).props.onChangeText(to);
  await harness.settle();
  return click(harness, "Update report");
}
function background() {
  AppState.currentState = "background";
  for (const listener of hooks.appListeners) listener("background");
}
function foreground() {
  AppState.currentState = "active";
  for (const listener of hooks.appListeners) listener("active");
}

describe("mobile adjacent report periods actual screen", () => {
  it("moves a loaded seven-day range once and retains the selected nutrient", async () => {
    const { harness, requests } = setup();
    let tree = await applyRange(harness, "2026-09-01", "2026-09-07");
    tree = await click(harness, "Protein");
    const before = requests.length;
    tree = await click(harness, "Previous period");
    expect(rangeValues(tree)).toEqual(["2026-08-25", "2026-08-31"]);
    expect(pressable(tree, "Protein").props.accessibilityState.selected).toBe(true);
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1).url.pathname).toBe("/v1/reports/nutrition");
    expect(requests.at(-1).url.searchParams.get("from")).toBe("2026-08-25");
    tree = await click(harness, "Next period");
    expect(rangeValues(tree)).toEqual(["2026-09-01", "2026-09-07"]);
    expect(screenText(tree)).toContain("Protein by day");
  });
  it("commits and hides synchronously, prevents duplicate activation and fences previous range controls", async () => {
    let delay = false;
    const pending = deferred();
    const { harness, requests } = setup(() => (delay ? pending.promise : undefined));
    let tree = await applyRange(harness, "2026-09-01", "2026-09-07");
    const next = pressable(tree, "Next period").props.onPress;
    const staleStart = startInput(tree).props.onChangeText;
    const staleUpdate = pressable(tree, "Update report").props.onPress;
    const stalePreset = pressable(tree, "30 days").props.onPress;
    const before = requests.length;
    delay = true;
    next();
    next();
    staleStart("2025-01-01");
    staleUpdate();
    stalePreset();
    const during = harness.renderWithoutEffects();
    expect(rangeValues(during)).toEqual(["2026-09-08", "2026-09-14"]);
    expect(screenText(during)).not.toContain("Snapshot captured");
    expect(pressable(during, "Next period").props.disabled).toBe(true);
    harness.flushEffects();
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 1);
    expect(pressable(tree, "Previous period").props.disabled).toBe(true);
    harness.unmount();
    pending.resolve(response({}, 401));
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
  });
  it("blocks dirty dates including invalid edits, and rejects a retained navigator after edit then restore", async () => {
    const { harness, requests } = setup();
    let tree = await applyRange(harness, "2026-09-01", "2026-09-07");
    const oldNext = pressable(tree, "Next period").props.onPress;
    const before = requests.length;
    startInput(tree).props.onChangeText("invalid");
    tree = await harness.settle();
    expect(pressable(tree, "Next period").props.disabled).toBe(true);
    expect(screenText(tree)).toContain("Choose Update report to apply these dates");
    oldNext();
    startInput(tree).props.onChangeText("2026-09-01");
    oldNext();
    tree = await harness.settle();
    expect(requests).toHaveLength(before);
    expect(pressable(tree, "Next period").props.disabled).toBe(false);
    tree = await click(harness, "Next period");
    expect(rangeValues(tree)).toEqual(["2026-09-08", "2026-09-14"]);
  });
  it("applies dirty dates before navigation and keeps presets anchored to today", async () => {
    const { harness } = setup();
    let tree = await applyRange(harness, "2024-02-28", "2024-02-29");
    tree = await click(harness, "Next period");
    expect(rangeValues(tree)).toEqual(["2024-03-01", "2024-03-02"]);
    tree = await click(harness, "7 days");
    expect(rangeValues(tree)).toEqual(["2026-09-03", "2026-09-09"]);
  });
  for (const bound of ["lower", "upper"]) {
    it(`disables only the unavailable direction at the ${bound} bound`, async () => {
      const { harness } = setup();
      let tree = await applyRange(
        harness,
        bound === "lower" ? "0002-01-01" : "9998-12-25",
        bound === "lower" ? "0002-01-07" : "9998-12-31",
      );
      expect(screenText(tree)).toContain("Snapshot captured");
      expect(
        pressable(tree, bound === "lower" ? "Previous period" : "Next period").props.disabled,
      ).toBe(true);
      expect(
        pressable(tree, bound === "lower" ? "Next period" : "Previous period").props.disabled,
      ).toBe(false);
      tree = await click(harness, bound === "lower" ? "Next period" : "Previous period");
      expect(rangeValues(tree)).toEqual(
        bound === "lower" ? ["0002-01-08", "0002-01-14"] : ["9998-12-18", "9998-12-24"],
      );
    });
  }
  it("retries the failed moved range without showing the previous snapshot or losing nutrient selection", async () => {
    let fail = false;
    const { harness, requests } = setup(() => (fail ? response({}, 503) : undefined));
    let tree = await click(harness, "Protein");
    const prior = rangeValues(tree);
    fail = true;
    tree = await click(harness, "Next period");
    const moved = rangeValues(tree);
    expect(moved).not.toEqual(prior);
    expect(screenText(tree)).not.toContain("Snapshot captured");
    expect(pressable(tree, "Next period").props.disabled).toBe(true);
    fail = false;
    const before = requests.length;
    tree = await click(harness, "Retry this range");
    expect(rangeValues(tree)).toEqual(moved);
    expect(requests).toHaveLength(before + 1);
    expect(pressable(tree, "Protein").props.accessibilityState.selected).toBe(true);
  });
  for (const change of ["owner", "token", "destination", "profile", "zone", "epoch"]) {
    it(`hides and fences the previous range on ${change} replacement before effects`, async () => {
      const { harness, requests, updateProps } = setup();
      let tree = await harness.settle();
      const next = pressable(tree, "Next period").props.onPress;
      const field = startInput(tree).props.onChangeText;
      const preset = pressable(tree, "7 days").props.onPress;
      const before = requests.length;
      updateProps(
        change === "owner"
          ? { expectedOwnerUserId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a" }
          : change === "token"
            ? { accessToken: "replacement-token" }
            : change === "destination"
              ? { apiBase: new URL("http://127.0.0.1:4001") }
              : change === "profile"
                ? { profileRevision: "5" }
                : change === "zone"
                  ? { profileTimeZone: "Europe/London" }
                  : { sessionEpoch: 2 },
      );
      tree = harness.renderWithoutEffects();
      expect(screenText(tree)).not.toContain("Snapshot captured");
      expect(pressable(tree, "Next period").props.disabled).toBe(true);
      next();
      field("2025-01-01");
      preset();
      expect(requests).toHaveLength(before);
      harness.unmount();
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
  for (const change of ["token", "destination", "profile"])
    for (const phase of ["fetch", "json"]) {
      it(`ignores a moved report ${phase} after ${change} changes even when abort is ignored`, async () => {
        const pending = deferred();
        let deferredBody;
        let delay = false;
        const { harness, requests, props, updateProps } = setup((request, current) => {
          if (!delay) return undefined;
          deferredBody = fixture(
            request.url.searchParams.get("from"),
            request.url.searchParams.get("to"),
            current,
          );
          deferredBody.data.watermarkRevision = "77";
          return phase === "fetch"
            ? pending.promise
            : { ...response(deferredBody), json: () => pending.promise };
        });
        let tree = await harness.settle();
        delay = true;
        tree = await click(harness, "Next period");
        const old = structuredClone(deferredBody);
        delay = false;
        updateProps(
          change === "token"
            ? { accessToken: "replacement-token" }
            : change === "destination"
              ? { apiBase: new URL("http://127.0.0.1:4001") }
              : { profileRevision: "5" },
        );
        tree = await harness.settle();
        const before = requests.length;
        pending.resolve(phase === "fetch" ? response(old, 401) : old);
        tree = await harness.settle();
        expect(props.onUnauthorized).not.toHaveBeenCalled();
        expect(screenText(tree)).toContain("Snapshot captured");
        expect(screenText(tree)).not.toContain("data revision 77");
        expect(requests).toHaveLength(before);
      });
    }
  it("closes controls on401 and never reopens through retained navigation or retry", async () => {
    let unauthorized = false;
    const { harness, props, requests } = setup(() =>
      unauthorized ? response({}, 401) : undefined,
    );
    let tree = await harness.settle();
    const retained = pressable(tree, "Next period").props.onPress;
    unauthorized = true;
    tree = await click(harness, "Next period");
    const before = requests.length;
    retained();
    tree = await harness.settle();
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(pressable(tree, "Next period").props.disabled).toBe(true);
    expect(pressable(tree, "Update report").props.disabled).toBe(true);
    expect(screenText(tree)).not.toContain("Snapshot captured");
    expect(requests).toHaveLength(before);
  });
  it("keeps an explicit401 closure across effect replay and reopens only for a new scope", async () => {
    let unauthorized = true;
    const { harness, requests, props, updateProps } = setup(() =>
      unauthorized ? response({}, 401) : undefined,
    );
    let tree = await harness.settle();
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    const before = requests.length;
    unauthorized = false;
    harness.replayEffects();
    tree = await harness.settle();
    expect(requests).toHaveLength(before);
    expect(pressable(tree, "Next period").props.disabled).toBe(true);
    expect(screenText(tree)).not.toContain("Snapshot captured");
    updateProps({ accessToken: "new-authenticated-token", sessionEpoch: 2 });
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 1);
    expect(pressable(tree, "Next period").props.disabled).toBe(false);
  });
  it("ignores an old moved-range JSON receipt after a later manual range is applied", async () => {
    let pauseNext = false;
    let oldBody;
    const pending = deferred();
    const { harness, requests } = setup((request, props) => {
      if (!pauseNext) return undefined;
      pauseNext = false;
      oldBody = fixture(
        request.url.searchParams.get("from"),
        request.url.searchParams.get("to"),
        props,
      );
      oldBody.data.watermarkRevision = "77";
      return { ...response(oldBody), json: () => pending.promise };
    });
    await harness.settle();
    pauseNext = true;
    await click(harness, "Next period");
    let tree = await applyRange(harness, "2024-02-28", "2024-02-29");
    const before = requests.length;
    pending.resolve(oldBody);
    tree = await harness.settle();
    expect(rangeValues(tree)).toEqual(["2024-02-28", "2024-02-29"]);
    expect(screenText(tree)).not.toContain("data revision 77");
    expect(requests).toHaveLength(before);
  });
  it("aborts and hides on background, reloads on foreground and fences old controls", async () => {
    const { harness, requests } = setup();
    let tree = await harness.settle();
    const next = pressable(tree, "Next period").props.onPress;
    const range = rangeValues(tree);
    background();
    tree = await harness.settle();
    expect(screenText(tree)).not.toContain("Snapshot captured");
    expect(pressable(tree, "Next period").props.disabled).toBe(true);
    next();
    const before = requests.length;
    foreground();
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 1);
    expect(rangeValues(tree)).toEqual(range);
    next();
    tree = await harness.settle();
    expect(rangeValues(tree)).toEqual(range);
  });
  it("recovers after effect cleanup/setup replay and ignores pre-replay controls", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    const old = pressable(tree, "Next period").props.onPress;
    const range = rangeValues(tree);
    harness.replayEffects();
    tree = await harness.settle();
    expect(screenText(tree)).toContain("Snapshot captured");
    old();
    tree = await harness.settle();
    expect(rangeValues(tree)).toEqual(range);
    tree = await click(harness, "Next period");
    expect(rangeValues(tree)).not.toEqual(range);
  });
});

function sourceFixture(from, to, props, sourceDates, mode = "complete") {
  const body = fixture(from, to, props);
  const day = body.data.days[0];
  day.entryCount = sourceDates.length;
  day.sourceDiaries = sourceDates.map((localDate, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    localDate,
    revision: "3",
  }));
  day.sourceTimeZones = ["America/Los_Angeles", "Pacific/Kiritimati"];
  for (const series of body.data.series) {
    const unknownCount = mode === "unknown" ? day.entryCount : mode === "partial" ? 1 : 0;
    const traceCount = mode === "trace" ? 1 : 0;
    const completeness = mode === "trace" ? "complete" : mode;
    series.points[0].aggregate = {
      nutrientId: series.nutrient.id,
      code: series.nutrient.code,
      name: series.nutrient.name,
      unit: series.nutrient.unit,
      knownAmount: "0",
      completeness,
      isExact: unknownCount === 0 && traceCount === 0,
      contributorCount: day.entryCount,
      quantifiedCount: day.entryCount - unknownCount - traceCount,
      traceCount,
      unknownCount,
      unknownReasonCounts: {
        not_reported: unknownCount,
        not_analyzed: 0,
        not_applicable: 0,
        withheld: 0,
      },
    };
    series.points[0].knownPercentOfScale = "0";
    series.summary = {
      ...series.summary,
      diaryDays: 1,
      missingDays: body.data.days.length - 1,
      completeDays: completeness === "complete" ? 1 : 0,
      exactDays: mode === "complete" ? 1 : 0,
      partialDays: mode === "partial" ? 1 : 0,
      unknownDays: mode === "unknown" ? 1 : 0,
      traceDays: mode === "trace" ? 1 : 0,
    };
  }
  return body;
}
const diaryButtons = (tree) =>
  nodes(
    tree,
    (node) =>
      node.type === "Pressable" && node.props.accessibilityLabel?.startsWith("Open diary for "),
  );
const diaryButton = (tree, date) => {
  const buttons = diaryButtons(tree).filter(
    (button) => button.props.accessibilityLabel === `Open diary for ${date}`,
  );
  expect(buttons).toHaveLength(1);
  return buttons[0];
};

describe("mobile report source diary navigation", () => {
  for (const mode of ["complete", "unknown", "partial", "trace"]) {
    it(`uses sorted unique provenance dates for ${mode} evidence and preserves the report date`, async () => {
      const { harness, requests, props } = setup((request, current) =>
        response(
          sourceFixture(
            request.url.searchParams.get("from"),
            request.url.searchParams.get("to"),
            current,
            ["2026-09-03", "2026-09-01", "2026-09-03"],
            mode,
          ),
        ),
      );
      let tree = await applyRange(harness, "2026-09-02", "2026-09-02");
      expect(diaryButtons(tree).map((button) => button.props.accessibilityLabel)).toEqual([
        "Open diary for 2026-09-01",
        "Open diary for 2026-09-03",
      ]);
      expect(screenText(tree)).toContain("2026-09-02");
      expect(screenText(tree)).toContain("Report days are grouped in UTC");
      expect(screenText(tree)).toContain("Source diary dates may differ");
      expect(screenText(tree)).toContain("it may have changed since this snapshot");
      expect(screenText(tree)).toContain(
        mode === "unknown" ? "Unknown" : mode === "complete" ? "0 kcal" : "≥ 0 kcal",
      );
      const before = requests.length;
      const first = diaryButton(tree, "2026-09-01").props.onPress;
      const second = diaryButton(tree, "2026-09-03").props.onPress;
      first();
      first();
      second();
      tree = await harness.settle();
      expect(props.onDiary).toHaveBeenCalledExactlyOnceWith("2026-09-01");
      expect(requests).toHaveLength(before);
      expect(screenText(tree)).not.toContain("Snapshot captured");
    });
  }
  it("opens the report date for a missing day without converting missingness to zero", async () => {
    const { harness, props, requests } = setup();
    const tree = await applyRange(harness, "2026-09-02", "2026-09-02");
    expect(screenText(tree)).toContain("No diary entries");
    const before = requests.length;
    diaryButton(tree, "2026-09-02").props.onPress();
    await harness.settle();
    expect(props.onDiary).toHaveBeenCalledExactlyOnceWith("2026-09-02");
    expect(requests).toHaveLength(before);
  });
  for (const [reportDate, sourceDate] of [
    ["0002-01-01", "0001-12-31"],
    ["9998-12-31", "9999-01-01"],
  ]) {
    it(`opens valid source date ${sourceDate} beyond the report bounds`, async () => {
      const { harness, props } = setup((request, current) =>
        response(
          sourceFixture(
            request.url.searchParams.get("from"),
            request.url.searchParams.get("to"),
            current,
            [sourceDate],
          ),
        ),
      );
      const tree = await applyRange(harness, reportDate, reportDate);
      diaryButton(tree, sourceDate).props.onPress();
      await harness.settle();
      expect(props.onDiary).toHaveBeenCalledExactlyOnceWith(sourceDate);
    });
  }
  it("disables dirty-date actions and rejects an earlier callback after editing then restoring dates", async () => {
    const { harness, props } = setup();
    let tree = await applyRange(harness, "2026-09-02", "2026-09-02");
    const old = diaryButton(tree, "2026-09-02").props.onPress;
    startInput(tree).props.onChangeText("invalid");
    tree = await harness.settle();
    expect(diaryButton(tree, "2026-09-02").props.disabled).toBe(true);
    expect(screenText(tree)).toContain(
      "Choose Update report to apply these dates before opening a diary",
    );
    old();
    startInput(tree).props.onChangeText("2026-09-02");
    old();
    tree = await harness.settle();
    expect(props.onDiary).not.toHaveBeenCalled();
    expect(diaryButton(tree, "2026-09-02").props.disabled).toBe(false);
    diaryButton(tree, "2026-09-02").props.onPress();
    expect(props.onDiary).toHaveBeenCalledExactlyOnceWith("2026-09-02");
  });
  it("reloads the applied range on actual focus return and rejects old departure controls", async () => {
    const { harness, props, requests, updateProps } = setup();
    let tree = await applyRange(harness, "2026-09-02", "2026-09-02");
    tree = await click(harness, "Protein");
    const old = diaryButton(tree, "2026-09-02").props.onPress;
    old();
    tree = await harness.settle();
    const before = requests.length;
    harness.replayEffects();
    tree = await harness.settle();
    expect(requests).toHaveLength(before);
    updateProps({ isFocused: false });
    tree = await harness.settle();
    old();
    expect(props.onDiary).toHaveBeenCalledTimes(1);
    updateProps({ isFocused: true });
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 1);
    expect(rangeValues(tree)).toEqual(["2026-09-02", "2026-09-02"]);
    expect(pressable(tree, "Protein").props.accessibilityState.selected).toBe(true);
    old();
    expect(props.onDiary).toHaveBeenCalledTimes(1);
    diaryButton(tree, "2026-09-02").props.onPress();
    expect(props.onDiary).toHaveBeenCalledTimes(2);
  });
  for (const boundary of ["range", "error", "closed", "background", "unmount", "replay"]) {
    it(`rejects a retained diary action after ${boundary}`, async () => {
      let status = 200;
      const { harness, props } = setup(() => (status === 200 ? undefined : response({}, status)));
      let tree = await applyRange(harness, "2026-09-02", "2026-09-02");
      const old = diaryButton(tree, "2026-09-02").props.onPress;
      if (boundary === "range") tree = await click(harness, "Next period");
      else if (boundary === "error" || boundary === "closed") {
        status = boundary === "error" ? 503 : 401;
        tree = await click(harness, "Next period");
      } else if (boundary === "background") {
        background();
        tree = await harness.settle();
      } else if (boundary === "unmount") harness.unmount();
      else {
        harness.replayEffects();
        tree = await harness.settle();
      }
      old();
      expect(props.onDiary).not.toHaveBeenCalled();
      expect(harness.writesAfterUnmount).toBe(0);
      if (boundary === "error") {
        status = 200;
        tree = await click(harness, "Retry this range");
        old();
        expect(props.onDiary).not.toHaveBeenCalled();
        diaryButton(tree, "2026-09-03").props.onPress();
        expect(props.onDiary).toHaveBeenCalledExactlyOnceWith("2026-09-03");
      }
    });
  }
  for (const change of ["owner", "token", "destination", "profile", "zone", "epoch", "focus"]) {
    it(`rejects diary navigation on ${change} replacement before effects`, async () => {
      const { harness, props, updateProps } = setup();
      let tree = await applyRange(harness, "2026-09-02", "2026-09-02");
      const old = diaryButton(tree, "2026-09-02").props.onPress;
      updateProps(
        change === "owner"
          ? { expectedOwnerUserId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a" }
          : change === "token"
            ? { accessToken: "next-token" }
            : change === "destination"
              ? { apiBase: new URL("http://127.0.0.1:4001") }
              : change === "profile"
                ? { profileRevision: "5" }
                : change === "zone"
                  ? { profileTimeZone: "Europe/London" }
                  : change === "epoch"
                    ? { sessionEpoch: 2 }
                    : { isFocused: false },
      );
      tree = harness.renderWithoutEffects();
      expect(diaryButtons(tree)).toHaveLength(0);
      old();
      expect(props.onDiary).not.toHaveBeenCalled();
      harness.unmount();
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
});

describe("native ReportsRoute diary wiring", () => {
  it("executes the actual route function and forwards focus plus Today date and refresh key", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "App.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const route = parsed.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ReportsRoute",
    );
    expect(route).toBeDefined();
    const compiled = ts.transpileModule(
      `${route.getText(parsed)}\nglobalThis.renderRoute = ReportsRoute;`,
      {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    );
    const navigation = { navigate: vi.fn() };
    const context = createContext({
      React,
      ReportsScreen,
      Date,
      useNavigation: () => navigation,
      useIsFocused: () => false,
      authenticatedRoutes,
    });
    new Script(compiled.outputText, { filename: "App.ReportsRoute.js" }).runInContext(context);
    const element = context.renderRoute({
      accessToken: "route-token",
      apiBase: new URL("http://127.0.0.1:4000"),
      sessionEpoch: 8,
      session: { user: { id: owner }, profile: { revision: "4", timeZone: "UTC" } },
      onUnauthorized: vi.fn(),
    });
    expect(element.type).toBe(ReportsScreen);
    expect(element.props.isFocused).toBe(false);
    expect(element.props.expectedOwnerUserId).toBe(owner);
    const before = Date.now();
    element.props.onDiary("0001-12-31");
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    const [destination, params] = navigation.navigate.mock.calls[0];
    expect(destination).toBe(authenticatedRoutes.today);
    expect(params.date).toBe("0001-12-31");
    expect(Number(params.refreshKey)).toBeGreaterThanOrEqual(before);
    expect(Number(params.refreshKey)).toBeLessThanOrEqual(Date.now());
  });
});
