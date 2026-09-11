import * as React from "react";
import { Alert, AppState } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiaryScreen } from "../src/diary/DiaryScreen";
import { resetDiaryGroups } from "../src/diary/diary";

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
          tree = DiaryScreen(props);
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
      tree = DiaryScreen(props);
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

const nutrient = {
  nutrientId: "1008",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "95.25",
  completeness: "complete",
  isExact: true,
  contributorCount: 1,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 0,
  unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
};

const entry = {
  id: "75d7fa63-4e26-42de-a1f8-0683ce268f62",
  revision: "3",
  entryKind: "food",
  foodVersionId: "202",
  recipeVersionId: null,
  portion: { kind: "serving", servingId: "303", amount: "1.5", servingLabel: "medium apple" },
  food: { name: "Apple", brandName: null },
  recipe: null,
  source: {
    code: "USDA_FDC",
    releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  foodProvenance: {
    kind: "public",
    source: {
      code: "USDA_FDC",
      releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: true,
      attributionText: "Data source: USDA FoodData Central",
    },
  },
  mealSlot: "breakfast",
  resolvedGrams: "150",
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  timeZone: "America/Chicago",
  localTime: "08:30:00.000",
  position: 0,
  nutrients: [nutrient],
  note: null,
};

const { foodProvenance: _publicFoodProvenance, ...entryWithoutFoodProvenance } = entry;
const recipeEntry = {
  ...entryWithoutFoodProvenance,
  id: "c8a7c76f-3c1d-445c-9160-152e57b29e40",
  entryKind: "recipe",
  foodVersionId: null,
  recipeVersionId: "de1f6d0a-f7dc-4b25-b7b9-3eef1d44779a",
  portion: { kind: "serving", amount: "1", servingLabel: "bowl" },
  food: null,
  recipe: {
    id: "df94a52f-e84a-4cd5-873e-227d1e213d62",
    name: "Bean stew",
    versionNumber: 2,
    yieldGrams: "800",
    yieldSource: "measured",
    servingCount: "4",
    servingLabel: "bowl",
    calculationVersion: "recipe-v1",
    retentionPolicy: {
      code: "identity-retention-default",
      version: "1",
      assumption: "No cooking-retention factor was applied.",
    },
    warnings: [
      {
        code: "RETENTION_FACTORS_DEFAULTED",
        message: "Nutrients use identity retention.",
        nutrientIds: [],
      },
    ],
  },
  source: null,
  sources: [entry.source],
  note: "Batch cooked\nKeep half for tomorrow.",
};

const privateCustomEntry = {
  ...entry,
  id: "a8a7c76f-3c1d-445c-9160-152e57b29e41",
  foodVersionId: "404",
  source: null,
  food: { name: "Owner oats", brandName: null },
  foodProvenance: {
    kind: "private_custom",
    customFoodId: "b8a7c76f-3c1d-445c-9160-152e57b29e42",
    customFoodVersionNumber: 3,
  },
};

const selectedDate = "2026-08-15";
const entries = [
  entry,
  { ...privateCustomEntry, mealSlot: "lunch" },
  { ...recipeEntry, mealSlot: "dinner" },
];
function page(
  date,
  rows = entries,
  nextCursor = null,
  totalEntries = rows.length,
  totals = [nutrient],
) {
  return {
    data: {
      id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
      localDate: date,
      timeZone: "America/Chicago",
      status: "open",
      revision: "8",
      orderDigest: "a".repeat(64),
      entries: rows.map((row) => ({ ...row, localDate: date })),
      totals,
      updatedAt: "2026-08-15T13:30:01.000Z",
    },
    page: { nextCursor, totalEntries },
  };
}
const response = (body, status = 200) => ({ status, ok: status === 200, json: async () => body });
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function rawScreenText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawScreenText).join(" ");
  return value && typeof value === "object" ? rawScreenText(value.props?.children) : "";
}
function screenText(value) {
  return rawScreenText(value).replace(/\s+/gu, " ").trim();
}
function nodes(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((child) => nodes(child, predicate));
  if (!value || typeof value !== "object") return [];
  return [...(predicate(value) ? [value] : []), ...nodes(value.props?.children, predicate)];
}
function byLabel(tree, label, type = "Pressable") {
  const found = nodes(
    tree,
    (node) => node.type === type && node.props.accessibilityLabel === label,
  );
  expect(found, label).toHaveLength(1);
  return found[0];
}
const toggle = (tree, label, expanded = true) =>
  byLabel(tree, `${expanded ? "Collapse" : "Expand"} ${label} entries`);
const groupLabels = resetDiaryGroups().map(({ label }) => label);
const mountedHarnesses = [];
function setup(responder = () => undefined, overrides = {}) {
  const requests = [];
  let receipt;
  let queueState = { status: "idle", pendingCount: 0 };
  let dependencies = { correctedEntryIds: [], reorderedLocalDates: [], pendingLocalDates: [] };
  const controller = {
    getState: vi.fn(() => queueState),
    pendingDependencies: vi.fn(async () => dependencies),
    enqueueOperation: vi.fn(async () => ({ operationId: "operation-1" })),
    requestDrain: vi.fn(async () => {}),
    retryBlockedHead: vi.fn(async () => {}),
    discardBlockedHead: vi.fn(async () => {}),
  };
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
    quickAddOutboxState: queueState,
    quickAddOutboxController: controller,
    subscribeQuickAddReceipts: (listener) => {
      receipt = listener;
      return () => {
        receipt = undefined;
      };
    },
    onUnauthorized: vi.fn(async () => {}),
    onSearch: vi.fn(),
    onRecipes: vi.fn(),
    onGoals: vi.fn(),
    onReports: vi.fn(),
    onHydration: vi.fn(),
    onActivity: vi.fn(),
    onHealth: vi.fn(),
    onProfileUpdated: vi.fn(),
    ...overrides,
  };
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      const request = { url: new URL(input), options };
      requests.push(request);
      if (request.url.pathname === "/v1/diary") {
        return (await responder(request)) ?? response(page(request.url.searchParams.get("date")));
      }
      return response({
        data: {
          localDate: request.url.searchParams.get("date"),
          timeZone: props.profileTimeZone,
          revision: "0",
          entries: [],
          updatedAt: null,
          ...(request.url.pathname === "/v1/hydration"
            ? { totalMilliliters: 0 }
            : { totalDurationMinutes: 0 }),
        },
      });
    }),
  );
  const harness = screenHarness(props);
  mountedHarnesses.push(harness);
  return {
    harness,
    props,
    requests,
    controller,
    receive: () => receipt({ mutation: { affectedDays: [{ localDate: selectedDate }] } }),
    setQueue(next, nextDependencies = dependencies, render = true) {
      queueState = next;
      dependencies = nextDependencies;
      if (render) harness.updateProps({ quickAddOutboxState: next });
    },
  };
}
function appState(next) {
  AppState.currentState = next;
  for (const listener of hooks.appListeners) listener(next);
}
afterEach(() => {
  for (const harness of mountedHarnesses.splice(0)) harness.unmount();
  hooks.appListeners.clear();
  AppState.currentState = "active";
  vi.unstubAllGlobals();
});

describe("native diary meal group collapse", () => {
  it("starts expanded and hides only loaded entry content without changing totals, counts or requests", async () => {
    const { harness, requests, controller, props } = setup();
    let tree = await harness.settle();
    for (const label of groupLabels)
      expect(toggle(tree, label).props.accessibilityState.expanded).toBe(true);
    const before = requests.length;
    const original = JSON.stringify(entries);
    const close = toggle(tree, "Breakfast").props.onPress;
    close();
    close();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.accessibilityState.expanded).toBe(false);
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Edit Apple entry and private note"),
    ).toHaveLength(0);
    expect(screenText(tree)).toContain("Loaded entries are hidden.");
    expect(screenText(tree)).toContain("3 of 3 entries loaded");
    expect(screenText(tree)).toContain("95.25 kcal");
    expect(screenText(tree)).toContain("Owner oats");
    expect(screenText(tree)).toContain("Bean stew");
    byLabel(tree, "Add food to Breakfast").props.onPress();
    expect(props.onSearch).toHaveBeenCalledExactlyOnceWith(
      selectedDate,
      "breakfast",
      "America/Chicago",
    );
    toggle(tree, "Breakfast", false).props.onPress();
    tree = await harness.settle();
    expect(byLabel(tree, "Edit Apple entry and private note")).toBeDefined();
    expect(requests).toHaveLength(before);
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
    expect(controller.requestDrain).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).toBe(original);
  });
  it("keeps independent stable meal choices through custom labels, display order and profile revision", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    toggle(tree, "Lunch").props.onPress();
    tree = await harness.settle();
    const groups = resetDiaryGroups()
      .reverse()
      .map((group) => ({
        ...group,
        label:
          group.mealSlot === "breakfast"
            ? "A long breakfast label ".repeat(5)
            : `Custom ${group.mealSlot}`,
      }));
    harness.updateProps({ diaryGroups: groups, profileRevision: "13" });
    tree = await harness.settle();
    expect(
      toggle(tree, groups.find((group) => group.mealSlot === "breakfast").label, false),
    ).toBeDefined();
    expect(toggle(tree, "Custom lunch", false)).toBeDefined();
    expect(toggle(tree, "Custom dinner").props.accessibilityState.expanded).toBe(true);
    byLabel(tree, "Expand all meals").props.onPress();
    tree = await harness.settle();
    for (const group of groups)
      expect(toggle(tree, group.label).props.accessibilityState.expanded).toBe(true);
  });
  it("retains real empty-day and empty-meal meaning", async () => {
    const { harness } = setup(() => response(page(selectedDate, [], null, 0, [])));
    const tree = await harness.settle();
    expect(screenText(tree)).toContain("Start with a food you actually ate.");
    expect(screenText(tree)).toContain("0 of 0 entries loaded");
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Expand all meals"),
    ).toHaveLength(0);
    expect(
      nodes(tree, (node) =>
        node.props.accessibilityLabel?.match(/^(Expand|Collapse) .* entries$/u),
      ),
    ).toHaveLength(0);
  });
  it("retains incomplete meal wording, coherent paging, loaded counts and collapsed choices after load more", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      position: index,
      mealSlot: index === 20 ? "lunch" : "breakfast",
    }));
    const { harness, requests } = setup((request) =>
      response(
        page(
          selectedDate,
          request.url.searchParams.has("cursor") ? rows.slice(20) : rows.slice(0, 20),
          request.url.searchParams.has("cursor") ? null : "d1.next",
          21,
        ),
      ),
    );
    let tree = await harness.settle();
    expect(screenText(tree)).toContain("No entries loaded for this meal yet");
    expect(toggle(tree, "Lunch").props.disabled).toBe(true);
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const before = requests.length;
    byLabel(tree, "Load more diary entries").props.onPress();
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 1);
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    expect(screenText(tree)).toContain("21 of 21 entries loaded");
    expect(screenText(tree)).toContain("No entries");
    expect(screenText(tree)).not.toContain("No entries loaded for this meal yet");
    expect(byLabel(tree, "All diary entries loaded").props.disabled).toBe(true);
  });
  for (const mode of ["zero", "unknown", "partial", "trace"]) {
    it(`preserves ${mode} whole-day nutrition evidence`, async () => {
      const total = {
        ...nutrient,
        knownAmount: "0",
        completeness: mode === "unknown" ? "unknown" : mode === "partial" ? "partial" : "complete",
        isExact: mode === "zero",
        contributorCount: 3,
        quantifiedCount: mode === "unknown" ? 0 : mode === "zero" ? 3 : 2,
        unknownCount: mode === "unknown" ? 3 : mode === "partial" ? 1 : 0,
        traceCount: mode === "trace" ? 1 : 0,
        unknownReasonCounts: {
          not_reported: mode === "unknown" ? 3 : mode === "partial" ? 1 : 0,
          not_analyzed: 0,
          not_applicable: 0,
          withheld: 0,
        },
      };
      const { harness } = setup(() => response(page(selectedDate, entries, null, 3, [total])));
      let tree = await harness.settle();
      const summary = nodes(
        tree,
        (node) =>
          node.type === "View" && screenText(node).startsWith("AUTHORITATIVE SNAPSHOT TOTALS"),
      )[0];
      const before = screenText(summary);
      toggle(tree, "Breakfast").props.onPress();
      tree = await harness.settle();
      expect(
        screenText(
          nodes(
            tree,
            (node) =>
              node.type === "View" && screenText(node).startsWith("AUTHORITATIVE SNAPSHOT TOTALS"),
          )[0],
        ),
      ).toBe(before);
      expect(before).toContain(
        mode === "unknown" ? "Unknown" : mode === "zero" ? "0 kcal" : "≥ 0 kcal",
      );
    });
  }
  it("preserves choices across a same-date authoritative receipt refresh and fences prior controls", async () => {
    const { harness, receive, requests } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const old = toggle(tree, "Breakfast", false).props.onPress;
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    const before = requests.length;
    receive();
    old();
    expand();
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 3);
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    old();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
  });
  it("resets date choices and rejects retained actions even before the new date paints", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const old = toggle(tree, "Breakfast", false).props.onPress;
    byLabel(tree, "Next day").props.onPress();
    old();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
    old();
    tree = await harness.settle();
    byLabel(tree, "Previous day").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
  });
  for (const change of ["owner", "session", "token", "api", "zone"]) {
    it(`resets and rejects a retained ${change} scope before effects`, async () => {
      const { harness } = setup();
      let tree = await harness.settle();
      toggle(tree, "Breakfast").props.onPress();
      tree = await harness.settle();
      const old = toggle(tree, "Breakfast", false).props.onPress;
      const expand = byLabel(tree, "Expand all meals").props.onPress;
      harness.updateProps(
        change === "owner"
          ? { expectedOwnerUserId: "another-owner" }
          : change === "session"
            ? { sessionEpoch: 8 }
            : change === "token"
              ? { accessToken: "fresh-token" }
              : change === "api"
                ? { apiBase: new URL("http://127.0.0.1:4001") }
                : { profileTimeZone: "UTC" },
      );
      tree = harness.renderWithoutEffects();
      expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
      expect(
        nodes(tree, (node) => node.props.accessibilityLabel === "Expand all meals"),
      ).toHaveLength(0);
      old();
      expand();
      tree = harness.renderWithoutEffects();
      expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
    });
  }
  it("fences background controls and permits a fresh foreground action without requests", async () => {
    const { harness, requests } = setup();
    let tree = await harness.settle();
    const old = toggle(tree, "Breakfast").props.onPress;
    const before = requests.length;
    appState("background");
    old();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    appState("active");
    tree = await harness.settle();
    old();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(false);
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    expect(requests).toHaveLength(before);
  });
  it("rejects retained controls after unmount and existing private closure on effect replay", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    const old = toggle(tree, "Breakfast").props.onPress;
    harness.replayEffects();
    tree = await harness.settle();
    old();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    harness.unmount();
    old();
    expect(harness.writesAfterUnmount).toBe(0);
  });
  it("preserves an editor opened before paint and its exact quantity and private-note draft", async () => {
    const { harness, controller } = setup();
    let tree = await harness.settle();
    const old = toggle(tree, "Breakfast").props.onPress;
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    byLabel(tree, "Edit Apple entry and private note").props.onPress();
    old();
    expand();
    tree = await harness.settle();
    byLabel(tree, "Quantity", "TextInput").props.onChangeText("2.0001");
    tree = await harness.settle();
    byLabel(tree, "Private note for Apple", "TextInput").props.onChangeText(
      "  exact draft\nline  ",
    );
    tree = await harness.settle();
    for (const label of groupLabels) expect(toggle(tree, label).props.disabled).toBe(true);
    expect(byLabel(tree, "Expand all meals").props.disabled).toBe(true);
    byLabel(tree, "Expand all meals").props.onPress();
    toggle(tree, "Lunch").props.onPress();
    old();
    expand();
    tree = await harness.settle();
    expect(byLabel(tree, "Quantity", "TextInput").props.value).toBe("2.0001");
    expect(byLabel(tree, "Private note for Apple", "TextInput").props.value).toBe(
      "  exact draft\nline  ",
    );
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
    byLabel(tree, "Cancel editing Apple").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(false);
    old();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
  });
  it("keeps queued edits visible after busy clears and preserves the exact protected enqueue and release", async () => {
    const { harness, controller, setQueue } = setup();
    const pending = deferred();
    controller.enqueueOperation.mockImplementation(() => pending.promise);
    let tree = await harness.settle();
    byLabel(tree, "Edit Apple entry and private note").props.onPress();
    tree = await harness.settle();
    byLabel(tree, "Quantity", "TextInput").props.onChangeText("2.0001");
    tree = await harness.settle();
    byLabel(tree, "Save changes to Apple").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    setQueue(
      { status: "pending", pendingCount: 1 },
      { correctedEntryIds: [entry.id], reorderedLocalDates: [], pendingLocalDates: [selectedDate] },
    );
    pending.resolve({ operationId: "queued-edit" });
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    expect(byLabel(tree, "Edit Apple entry and private note").props.disabled).toBe(true);
    expect(controller.enqueueOperation).toHaveBeenCalledExactlyOnceWith({
      operationKind: "update",
      entryId: entry.id,
      expectedEntryRevision: "3",
      entryName: "Apple",
      portionLabel: "1.5 medium apple",
      localDate: selectedDate,
      mealSlot: "breakfast",
      body: {
        portion: { kind: "serving", servingId: "303", amount: "2.0001" },
        mealSlot: "breakfast",
      },
    });
    expect(controller.requestDrain).toHaveBeenCalledExactlyOnceWith("queued-edit");
  });
  for (const dependency of ["corrected", "reordered", "day", "unknown"]) {
    it(`keeps collapsed content visible while ${dependency} pending work needs attention`, async () => {
      const { harness, setQueue } = setup();
      let tree = await harness.settle();
      toggle(tree, "Breakfast").props.onPress();
      tree = await harness.settle();
      const old = toggle(tree, "Breakfast", false).props.onPress;
      setQueue(
        dependency === "unknown"
          ? { status: "unavailable", reason: "storage", pendingCount: 0 }
          : { status: "idle", pendingCount: 0 },
        {
          correctedEntryIds: dependency === "corrected" ? [entry.id] : [],
          reorderedLocalDates: dependency === "reordered" ? [selectedDate] : [],
          pendingLocalDates: dependency === "day" ? [selectedDate] : [],
        },
      );
      tree = await harness.settle();
      old();
      expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
      expect(byLabel(tree, "Edit Apple entry and private note")).toBeDefined();
    });
  }
  it("rechecks pending controller state synchronously before prop delivery", async () => {
    const { harness, setQueue } = setup();
    let tree = await harness.settle();
    toggle(tree, "Lunch").props.onPress();
    tree = await harness.settle();
    const old = toggle(tree, "Breakfast").props.onPress;
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    setQueue({ status: "pending", pendingCount: 1 }, undefined, false);
    old();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
    expect(toggle(tree, "Lunch", false).props.accessibilityState.expanded).toBe(false);
  });
  for (const transition of ["date", "refresh"]) {
    it(`fences route ${transition} replacement before effects and preserves only same-day choices`, async () => {
      const { harness } = setup();
      let tree = await harness.settle();
      toggle(tree, "Breakfast").props.onPress();
      tree = await harness.settle();
      const old = toggle(tree, "Breakfast", false).props.onPress;
      const expand = byLabel(tree, "Expand all meals").props.onPress;
      harness.updateProps(
        transition === "date"
          ? { requestedDate: "2026-08-16", refreshKey: "next" }
          : { refreshKey: "fresh" },
      );
      tree = harness.renderWithoutEffects();
      expect(toggle(tree, "Breakfast", false).props.disabled).toBe(true);
      old();
      expand();
      toggle(tree, "Breakfast", false).props.onPress();
      harness.flushEffects();
      tree = await harness.settle();
      old();
      expand();
      tree = await harness.settle();
      expect(toggle(tree, "Breakfast", transition === "date")).toBeDefined();
    });
  }
  it("keeps paging retry reachable and retained toggles inert during a pending continuation", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      position: index,
    }));
    const pending = deferred();
    let attempt = 0;
    const { harness } = setup((request) => {
      if (!request.url.searchParams.has("cursor"))
        return response(page(selectedDate, rows.slice(0, 20), "d1.next", 21));
      attempt += 1;
      return attempt === 1
        ? pending.promise
        : response(page(selectedDate, rows.slice(20), null, 21));
    });
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const old = toggle(tree, "Breakfast", false).props.onPress;
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    byLabel(tree, "Load more diary entries").props.onPress();
    old();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.disabled).toBe(true);
    expect(byLabel(tree, "Expand all meals").props.disabled).toBe(true);
    pending.resolve(response({}, 503));
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    old();
    expand();
    byLabel(tree, "Retry loading more diary entries").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    expect(screenText(tree)).toContain("21 of 21 entries loaded");
    byLabel(tree, "Expand all meals").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
    expect(screenText(tree)).toContain("21 of 21 entries loaded");
  });
  it("hides unavailable private snapshots and rejects controls after failed reload or401", async () => {
    let status = 200;
    const { harness, receive, props } = setup(() =>
      status === 200 ? undefined : response({}, status),
    );
    let tree = await harness.settle();
    const old = toggle(tree, "Breakfast").props.onPress;
    status = 503;
    receive();
    tree = await harness.settle();
    old();
    expect(
      nodes(tree, (node) =>
        node.props.accessibilityLabel?.match(/^(Expand|Collapse) .* entries$/u),
      ),
    ).toHaveLength(0);
    status = 401;
    receive();
    tree = await harness.settle();
    old();
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(
      nodes(tree, (node) =>
        node.props.accessibilityLabel?.match(/^(Expand|Collapse) .* entries$/u),
      ),
    ).toHaveLength(0);
  });
  it("keeps blocked queue retry and discard reachable and restores the prior choice only after work clears", async () => {
    const { harness, setQueue, controller } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const old = toggle(tree, "Breakfast", false).props.onPress;
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    setQueue({
      status: "blocked",
      pendingCount: 1,
      operationId: "blocked-operation",
      httpStatus: 409,
      blockedReason: "terminal_http",
      operationKind: "update",
      foodName: "Apple",
      servingLabel: "medium apple",
      localDate: selectedDate,
      mealSlot: "breakfast",
    });
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    expect(byLabel(tree, "Expand all meals").props.disabled).toBe(true);
    byLabel(tree, "Expand all meals").props.onPress();
    expand();
    byLabel(tree, "Retry queued Apple change exactly").props.onPress();
    tree = await harness.settle();
    expect(controller.retryBlockedHead).toHaveBeenCalledExactlyOnceWith("blocked-operation");
    byLabel(tree, "Discard only queued Apple change").props.onPress();
    const [, , actions] = Alert.alert.mock.calls.at(-1);
    expect(actions.map((action) => action.text)).toEqual(["Cancel", "Discard queued change"]);
    expect(controller.discardBlockedHead).not.toHaveBeenCalled();
    actions[1].onPress();
    tree = await harness.settle();
    expect(controller.discardBlockedHead).toHaveBeenCalledExactlyOnceWith("blocked-operation");
    setQueue({ status: "idle", pendingCount: 0 });
    tree = await harness.settle();
    old();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.disabled).toBe(false);
  });
});

function diaryEntryCard(tree, id) {
  const found = nodes(tree, (node) => node.type === "View" && node.key === id);
  expect(found).toHaveLength(1);
  return found[0];
}
function entryNutrientToggle(tree, id = entry.id) {
  const found = nodes(
    diaryEntryCard(tree, id),
    (node) =>
      node.type === "Pressable" &&
      /^(Show|Hide) nutrients for /u.test(node.props.accessibilityLabel ?? ""),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
function entryNutrientDetails(tree, id = entry.id) {
  return nodes(
    diaryEntryCard(tree, id),
    (node) =>
      node.type === "View" && node.props.accessibilityLabel?.startsWith("Saved nutrients for "),
  );
}
async function toggleNutrients(harness, id = entry.id) {
  const button = entryNutrientToggle(await harness.settle(), id);
  expect(button.props.disabled).toBe(false);
  button.props.onPress();
  return harness.settle();
}
function detailedNutrients() {
  const exact = {
    ...nutrient,
    nutrientId: "1",
    code: "fixture_exact",
    name: "Exact saved amount",
    unit: "mg",
    knownAmount: `0.${"1".repeat(198)}`,
  };
  const zero = {
    ...nutrient,
    nutrientId: "2",
    code: "fixture_zero",
    name: "Quantified zero",
    unit: "g",
    knownAmount: "0",
  };
  const trace = {
    ...nutrient,
    nutrientId: "3",
    code: "fixture_trace",
    name: "Trace nutrient",
    unit: "mg",
    knownAmount: "0",
    quantifiedCount: 0,
    traceCount: 1,
    isExact: false,
  };
  const partial = {
    ...nutrient,
    nutrientId: "4",
    code: "fixture_partial",
    name: "Partial nutrient",
    unit: "g",
    knownAmount: "1.230001",
    completeness: "partial",
    isExact: false,
    contributorCount: 2,
    unknownCount: 1,
    unknownReasonCounts: { ...nutrient.unknownReasonCounts, not_reported: 1 },
  };
  return [
    exact,
    zero,
    trace,
    partial,
    ...Object.keys(nutrient.unknownReasonCounts).map((reason, index) => ({
      ...nutrient,
      nutrientId: String(index + 5),
      code: `fixture_unknown_${index}`,
      name: `Unknown ${reason}`,
      unit: "µg",
      knownAmount: "0",
      completeness: "unknown",
      isExact: false,
      quantifiedCount: 0,
      unknownCount: 1,
      unknownReasonCounts: { ...nutrient.unknownReasonCounts, [reason]: 1 },
    })),
  ];
}

describe("native logged diary entry nutrient details", () => {
  it("starts closed for food, private food and recipe; opens independently without requests, writes or changed totals", async () => {
    const rows = entries.map((item) => ({ ...item, nutrients: detailedNutrients() }));
    const { harness, requests, controller } = setup(() => response(page(selectedDate, rows)));
    let tree = await harness.settle();
    const before = requests.length;
    const original = JSON.stringify(rows);
    for (const item of rows)
      expect(entryNutrientToggle(tree, item.id).props.accessibilityState.expanded).toBe(false);
    tree = await toggleNutrients(harness);
    expect(entryNutrientToggle(tree).props.accessibilityState.expanded).toBe(true);
    expect(entryNutrientToggle(tree, rows[1].id).props.accessibilityState.expanded).toBe(false);
    tree = await toggleNutrients(harness, rows[1].id);
    tree = await toggleNutrients(harness, rows[2].id);
    expect(entryNutrientDetails(tree)).toHaveLength(1);
    tree = await toggleNutrients(harness, rows[1].id);
    expect(entryNutrientDetails(tree, rows[1].id)).toHaveLength(0);
    expect(entryNutrientDetails(tree, rows[2].id)).toHaveLength(1);
    expect(screenText(tree)).toContain("3 of 3 entries loaded");
    expect(screenText(tree)).toContain(
      "Nutrition Energy 95.25 kcal Complete coverage · quantified",
    );
    expect(JSON.stringify(rows)).toBe(original);
    expect(requests).toHaveLength(before);
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
    expect(controller.requestDrain).not.toHaveBeenCalled();
  });

  it("shows exact saved strings and units for zero, trace, partial and all unknown reasons in source order", async () => {
    const vector = detailedNutrients();
    const { harness } = setup(() =>
      response(page(selectedDate, [{ ...entry, nutrients: vector }])),
    );
    const tree = await toggleNutrients(harness);
    const [details] = entryNutrientDetails(tree);
    const text = screenText(details);
    expect(text).toContain("Saved logged portion: 1.5 medium apple · entry revision 3");
    expect(text).toContain(`${vector[0].knownAmount} mg`);
    expect(text).toContain("Quantified zero ( g ) 0 g Complete coverage · quantified");
    expect(text).toContain(
      "Trace nutrient ( mg ) ≥ 0 mg Complete coverage · includes trace values",
    );
    expect(text).toContain("Partial nutrient ( g ) ≥ 1.230001 g Partial · 1/2 quantified");
    for (const reason of Object.keys(nutrient.unknownReasonCounts))
      expect(text).toContain(`Unknown ${reason} ( µg ) Unknown 0/1 contributions quantified`);
    const positions = vector.map((item) => text.indexOf(`${item.name} ( ${item.unit} )`));
    expect(
      positions.every(
        (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]),
      ),
    ).toBe(true);
  });

  it("renders all256 rows including long names and units without slicing or changing exact amounts", async () => {
    const vector = Array.from({ length: 256 }, (_, index) => ({
      ...nutrient,
      nutrientId: String(index + 1),
      code: `fixture_nutrient_${index + 1}`,
      name: index === 0 ? "N".repeat(200) : `Saved nutrient ${index + 1}`,
      unit: index === 0 ? "u".repeat(32) : "mg",
      knownAmount: index === 0 ? "1".repeat(200) : String(index),
    }));
    const { harness } = setup(() =>
      response(page(selectedDate, [{ ...entry, nutrients: vector }])),
    );
    const tree = await toggleNutrients(harness);
    const [details] = entryNutrientDetails(tree);
    const rendered = nodes(
      details,
      (node) => node.type === "View" && /^\d+:\d+$/u.test(String(node.key)),
    );
    expect(rendered).toHaveLength(256);
    expect(rendered.map((node) => screenText(node.props.children[0]))).toEqual(
      vector.map((item) => `${item.name} ( ${item.unit} )`),
    );
    expect(screenText(rendered[0])).toContain(`${vector[0].knownAmount} ${vector[0].unit}`);
    expect(screenText(rendered[255])).toContain("255 mg");
  });

  it("preserves accepted repeated nutrient IDs as distinct source rows", async () => {
    const repeated = [
      { ...nutrient, name: "First saved row", knownAmount: "1" },
      { ...nutrient, name: "Second saved row", knownAmount: "2" },
    ];
    const { harness } = setup(() =>
      response(page(selectedDate, [{ ...entry, nutrients: repeated }])),
    );
    const tree = await toggleNutrients(harness);
    const rendered = nodes(
      entryNutrientDetails(tree)[0],
      (node) => node.type === "View" && /^\d+:\d+$/u.test(String(node.key)),
    );
    expect(rendered).toHaveLength(2);
    expect(new Set(rendered.map((node) => node.key)).size).toBe(2);
    expect(rendered.map(screenText)).toEqual([
      "First saved row ( kcal ) 1 kcal Complete coverage · quantified",
      "Second saved row ( kcal ) 2 kcal Complete coverage · quantified",
    ]);
  });

  it("explains an empty vector and remains inspectable on a locked saved day", async () => {
    const body = page(selectedDate, [{ ...entry, nutrients: [] }]);
    body.data.status = "locked";
    const { harness } = setup(() => response(body));
    const tree = await toggleNutrients(harness);
    expect(screenText(entryNutrientDetails(tree)[0])).toContain(
      "Nutrient details are unavailable for this logged entry.",
    );
    expect(screenText(tree)).toContain("This local day is locked");
  });

  it("uses exact entry identity for duplicate labels and fences retained Show/Hide choices", async () => {
    const other = {
      ...entry,
      id: "87e77109-fc67-44e6-a81d-85ef310b5a63",
      position: 1,
      nutrients: [{ ...nutrient, knownAmount: "7" }],
    };
    const { harness } = setup(() => response(page(selectedDate, [entry, other])));
    let tree = await harness.settle();
    const oldShow = entryNutrientToggle(tree).props.onPress;
    oldShow();
    oldShow();
    tree = await harness.settle();
    expect(entryNutrientToggle(tree).props.accessibilityState.expanded).toBe(true);
    expect(entryNutrientToggle(tree, other.id).props.accessibilityState.expanded).toBe(false);
    const oldHide = entryNutrientToggle(tree).props.onPress;
    oldHide();
    oldShow();
    oldHide();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
    tree = await toggleNutrients(harness, other.id);
    expect(screenText(entryNutrientDetails(tree, other.id)[0])).toContain("7 kcal");
    oldShow();
    oldHide();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
  });

  it("preserves exact unsaved correction fields and labels the original logged portion", async () => {
    const { harness, controller } = setup();
    let tree = await harness.settle();
    byLabel(tree, "Edit Apple entry and private note").props.onPress();
    tree = await harness.settle();
    byLabel(tree, "Quantity", "TextInput").props.onChangeText("2.000001");
    tree = await harness.settle();
    byLabel(tree, "Private note for Apple", "TextInput").props.onChangeText("  exact note\nline  ");
    tree = await harness.settle();
    byLabel(tree, "Entry local date", "TextInput").props.onChangeText("2026-08-16");
    tree = await harness.settle();
    const inputs = () =>
      nodes(tree, (node) => node.type === "TextInput").map((node) => [
        node.props.accessibilityLabel,
        node.props.value,
      ]);
    const before = inputs();
    const save = byLabel(tree, "Save changes to Apple").props.onPress;
    tree = await toggleNutrients(harness);
    expect(inputs()).toEqual(before);
    expect(screenText(entryNutrientDetails(tree)[0])).toContain(
      "Saved logged portion: 1.5 medium apple · entry revision 3",
    );
    expect(screenText(entryNutrientDetails(tree)[0])).not.toContain("2.000001 medium apple");
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
    tree = await toggleNutrients(harness);
    expect(inputs()).toEqual(before);
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
    save();
    await harness.settle();
    expect(controller.enqueueOperation).toHaveBeenCalledTimes(1);
    expect(controller.enqueueOperation.mock.calls[0][0]).toMatchObject({
      entryId: entry.id,
      expectedEntryRevision: "3",
      body: {
        portion: { kind: "serving", servingId: "303", amount: "2.000001" },
        note: "  exact note\nline  ",
      },
    });
  });

  it("leaves a pending protected correction and its exact enqueue/drain untouched", async () => {
    const { harness, controller, setQueue } = setup();
    const held = deferred();
    controller.enqueueOperation.mockReturnValue(held.promise);
    let tree = await harness.settle();
    byLabel(tree, "Edit Apple entry and private note").props.onPress();
    tree = await harness.settle();
    byLabel(tree, "Quantity", "TextInput").props.onChangeText("2.0001");
    tree = await harness.settle();
    byLabel(tree, "Save changes to Apple").props.onPress();
    tree = await harness.settle();
    const operation = JSON.stringify(controller.enqueueOperation.mock.calls[0][0]);
    tree = await toggleNutrients(harness);
    expect(screenText(entryNutrientDetails(tree)[0])).toContain("1.5 medium apple");
    setQueue(
      { status: "pending", pendingCount: 1 },
      { correctedEntryIds: [entry.id], reorderedLocalDates: [], pendingLocalDates: [selectedDate] },
    );
    held.resolve({ operationId: "nutrient-edit" });
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(1);
    tree = await toggleNutrients(harness);
    expect(controller.enqueueOperation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.enqueueOperation.mock.calls[0][0])).toBe(operation);
    expect(controller.requestDrain).toHaveBeenCalledExactlyOnceWith("nutrient-edit");
    expect(toggle(tree, "Breakfast").props.disabled).toBe(true);
  });

  it("hides with a collapsed meal, rejects hidden callbacks before paint and restores the unchanged choice on reopen", async () => {
    const { harness, requests } = setup();
    let tree = await toggleNutrients(harness);
    const hide = entryNutrientToggle(tree).props.onPress;
    const before = requests.length;
    toggle(tree, "Breakfast").props.onPress();
    hide();
    tree = await harness.settle();
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
    ).toHaveLength(0);
    hide();
    toggle(tree, "Breakfast", false).props.onPress();
    hide();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(1);
    expect(entryNutrientToggle(tree).props.accessibilityState.expanded).toBe(true);
    expect(requests).toHaveLength(before);
  });

  it("preserves unchanged details through pending/error/coherent paging and starts appended entries closed", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      position: index,
    }));
    const held = deferred();
    let attempts = 0;
    const { harness } = setup((request) =>
      !request.url.searchParams.has("cursor")
        ? response(page(selectedDate, rows.slice(0, 20), "d1.next", 21))
        : ++attempts === 1
          ? held.promise
          : response(page(selectedDate, rows.slice(20), null, 21)),
    );
    let tree = await toggleNutrients(harness, rows[0].id);
    const old = entryNutrientToggle(tree, rows[0].id).props.onPress;
    byLabel(tree, "Load more diary entries").props.onPress();
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree, rows[0].id)).toHaveLength(1);
    expect(entryNutrientToggle(tree, rows[0].id).props.disabled).toBe(true);
    held.resolve(response({}, 503));
    tree = await harness.settle();
    expect(entryNutrientDetails(tree, rows[0].id)).toHaveLength(1);
    byLabel(tree, "Retry loading more diary entries").props.onPress();
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree, rows[0].id)).toHaveLength(1);
    expect(entryNutrientToggle(tree, rows[20].id).props.accessibilityState.expanded).toBe(false);
    expect(screenText(tree)).toContain("21 of 21 entries loaded");
  });

  it("closes immediately on full reload, remains closed through failure and requires fresh Show after recovery", async () => {
    const held = deferred();
    let reads = 0;
    const { harness, receive } = setup(() => (++reads === 2 ? held.promise : undefined));
    let tree = await toggleNutrients(harness);
    const old = entryNutrientToggle(tree).props.onPress;
    receive();
    old();
    tree = await harness.settle();
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
    ).toHaveLength(0);
    held.resolve(response({}, 503));
    tree = await harness.settle();
    old();
    receive();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
    tree = await toggleNutrients(harness);
    expect(entryNutrientDetails(tree)).toHaveLength(1);
  });

  it("closes on a stale-page full refresh and never carries an old entry revision into fresh values", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      position: index,
    }));
    let reads = 0;
    const changed = { ...rows[0], revision: "4", nutrients: [{ ...nutrient, knownAmount: "88" }] };
    const { harness } = setup((request) =>
      request.url.searchParams.has("cursor")
        ? response({ code: "DIARY_PAGE_STALE" }, 409)
        : ++reads === 1
          ? response(page(selectedDate, rows.slice(0, 20), "d1.next", 21))
          : response(page(selectedDate, [changed])),
    );
    let tree = await toggleNutrients(harness, rows[0].id);
    const old = entryNutrientToggle(tree, rows[0].id).props.onPress;
    byLabel(tree, "Load more diary entries").props.onPress();
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree, changed.id)).toHaveLength(0);
    tree = await toggleNutrients(harness, changed.id);
    expect(screenText(entryNutrientDetails(tree, changed.id)[0])).toContain("entry revision 4");
    expect(screenText(entryNutrientDetails(tree, changed.id)[0])).toContain("88 kcal");
  });

  it("closes on date replacement and keeps prior-date callbacks inert after returning", async () => {
    const { harness } = setup();
    let tree = await toggleNutrients(harness);
    const old = entryNutrientToggle(tree).props.onPress;
    byLabel(tree, "Next day").props.onPress();
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
    byLabel(tree, "Previous day").props.onPress();
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(entryNutrientDetails(tree)).toHaveLength(0);
  });

  for (const boundary of [
    "owner",
    "session",
    "token",
    "api",
    "zone",
    "route date",
    "route refresh",
  ]) {
    it(`hides private details before ${boundary} effects and rejects retained callbacks`, async () => {
      const { harness } = setup();
      let tree = await toggleNutrients(harness);
      const old = entryNutrientToggle(tree).props.onPress;
      harness.updateProps(
        boundary === "owner"
          ? { expectedOwnerUserId: "replacement-owner" }
          : boundary === "session"
            ? { sessionEpoch: 8 }
            : boundary === "token"
              ? { accessToken: "replacement-token" }
              : boundary === "api"
                ? { apiBase: new URL("http://127.0.0.1:4001") }
                : boundary === "zone"
                  ? { profileTimeZone: "UTC" }
                  : boundary === "route date"
                    ? { requestedDate: "2026-08-16", refreshKey: "changed-date" }
                    : { requestedDate: selectedDate, refreshKey: "same-day-new-route" },
      );
      tree = harness.renderWithoutEffects();
      old();
      expect(
        nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
      ).toHaveLength(0);
      expect(
        nodes(tree, (node) =>
          /^(Show|Hide) nutrients for /u.test(node.props.accessibilityLabel ?? ""),
        ),
      ).toHaveLength(0);
      harness.flushEffects();
      tree = await harness.settle();
      old();
      tree = await harness.settle();
      expect(
        nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
      ).toHaveLength(0);
    });
  }

  for (const state of ["background", "inactive", "unknown"]) {
    it(`clears on ${state}, leaves a fresh foreground choice closed and rejects old controls`, async () => {
      const { harness, requests } = setup();
      let tree = await toggleNutrients(harness);
      const old = entryNutrientToggle(tree).props.onPress;
      const before = requests.length;
      appState(state);
      old();
      tree = await harness.settle();
      expect(
        nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
      ).toHaveLength(0);
      appState("active");
      tree = await harness.settle();
      old();
      tree = await harness.settle();
      expect(entryNutrientDetails(tree)).toHaveLength(0);
      tree = await toggleNutrients(harness);
      expect(entryNutrientDetails(tree)).toHaveLength(1);
      expect(requests).toHaveLength(before);
    });
  }

  it("rejects removed-entry, closed-session, effect-replay and unmounted callbacks", async () => {
    let mode = "normal";
    const { harness, receive, props } = setup(() =>
      mode === "empty"
        ? response(page(selectedDate, []))
        : mode === "expired"
          ? response({}, 401)
          : undefined,
    );
    let tree = await toggleNutrients(harness);
    const old = entryNutrientToggle(tree).props.onPress;
    mode = "empty";
    receive();
    tree = await harness.settle();
    old();
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
    ).toHaveLength(0);
    mode = "expired";
    receive();
    tree = await harness.settle();
    old();
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    harness.replayEffects();
    tree = await harness.settle();
    old();
    expect(
      nodes(tree, (node) =>
        /^(Show|Hide) nutrients for /u.test(node.props.accessibilityLabel ?? ""),
      ),
    ).toHaveLength(0);
    harness.unmount();
    old();
    expect(harness.writesAfterUnmount).toBe(0);
  });
});

describe("native Expand all diary meals", () => {
  it("restores multiple loaded meals with exact nutrient choices, counts and no local side effects", async () => {
    const { harness, requests, controller } = setup();
    let tree = await toggleNutrients(harness, entry.id);
    tree = await toggleNutrients(harness, recipeEntry.id);
    const original = JSON.stringify(entries);
    const count = requests.length;
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    toggle(tree, "Dinner").props.onPress();
    tree = await harness.settle();
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Apple"),
    ).toHaveLength(0);
    expect(
      nodes(tree, (node) => node.props.accessibilityLabel === "Saved nutrients for Bean stew"),
    ).toHaveLength(0);
    const expand = byLabel(tree, "Expand all meals");
    expect(expand.props.accessibilityRole).toBe("button");
    expect(expand.props.accessibilityState).toEqual({ disabled: false });
    expand.props.onPress();
    tree = await harness.settle();
    for (const label of groupLabels)
      expect(toggle(tree, label).props.accessibilityState.expanded).toBe(true);
    expect(entryNutrientDetails(tree, entry.id)).toHaveLength(1);
    expect(entryNutrientDetails(tree, recipeEntry.id)).toHaveLength(1);
    expect(screenText(tree)).toContain("3 of 3 entries loaded");
    expect(screenText(tree)).toContain("95.25 kcal");
    expect(byLabel(tree, "Add food to Breakfast")).toBeDefined();
    expect(requests).toHaveLength(count);
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
    expect(controller.requestDrain).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).toBe(original);
  });
  it("keeps an already-expanded action mounted/enabled and an exact no-op preserves a current individual toggle", async () => {
    const { harness, requests, controller } = setup();
    let tree = await harness.settle();
    const close = toggle(tree, "Breakfast").props.onPress;
    const expand = byLabel(tree, "Expand all meals");
    expect(expand.props.disabled).toBe(false);
    const writes = harness.stateWrites;
    const count = requests.length;
    expand.props.onPress();
    expand.props.onPress();
    expect(harness.stateWrites).toBe(writes);
    close();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.accessibilityState.expanded).toBe(false);
    expect(byLabel(tree, "Expand all meals").props.disabled).toBe(false);
    expect(requests).toHaveLength(count);
    expect(controller.enqueueOperation).not.toHaveBeenCalled();
  });
  it("invalidates prior callbacks after a real expansion and cannot clear a later collapse choice", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const expand = byLabel(tree, "Expand all meals").props.onPress;
    const oldClose = toggle(tree, "Dinner").props.onPress;
    expand();
    oldClose();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Dinner").props.accessibilityState.expanded).toBe(true);
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    expand();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.accessibilityState.expanded).toBe(false);
  });
  it("rejects a retained Expand across background return and unmount without clearing current choices", async () => {
    const { harness, requests } = setup();
    let tree = await harness.settle();
    toggle(tree, "Breakfast").props.onPress();
    tree = await harness.settle();
    const old = byLabel(tree, "Expand all meals").props.onPress;
    const count = requests.length;
    appState("background");
    old();
    tree = await harness.settle();
    expect(byLabel(tree, "Expand all meals").props.disabled).toBe(true);
    appState("active");
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    const current = byLabel(tree, "Expand all meals").props.onPress;
    harness.unmount();
    current();
    expect(harness.writesAfterUnmount).toBe(0);
    expect(requests).toHaveLength(count);
  });
});
