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
  });
  it("retains real empty-day and empty-meal meaning", async () => {
    const { harness } = setup(() => response(page(selectedDate, [], null, 0, [])));
    const tree = await harness.settle();
    expect(screenText(tree)).toContain("Start with a food you actually ate.");
    expect(screenText(tree)).toContain("0 of 0 entries loaded");
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
    const before = requests.length;
    receive();
    old();
    tree = await harness.settle();
    expect(requests).toHaveLength(before + 3);
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    old();
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
      old();
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
    byLabel(tree, "Edit Apple entry and private note").props.onPress();
    old();
    tree = await harness.settle();
    byLabel(tree, "Quantity", "TextInput").props.onChangeText("2.0001");
    tree = await harness.settle();
    byLabel(tree, "Private note for Apple", "TextInput").props.onChangeText(
      "  exact draft\nline  ",
    );
    tree = await harness.settle();
    for (const label of groupLabels) expect(toggle(tree, label).props.disabled).toBe(true);
    toggle(tree, "Lunch").props.onPress();
    old();
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
    const old = toggle(tree, "Breakfast").props.onPress;
    setQueue({ status: "pending", pendingCount: 1 }, undefined, false);
    old();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast").props.accessibilityState.expanded).toBe(true);
  });
  for (const transition of ["date", "refresh"]) {
    it(`fences route ${transition} replacement before effects and preserves only same-day choices`, async () => {
      const { harness } = setup();
      let tree = await harness.settle();
      toggle(tree, "Breakfast").props.onPress();
      tree = await harness.settle();
      const old = toggle(tree, "Breakfast", false).props.onPress;
      harness.updateProps(
        transition === "date"
          ? { requestedDate: "2026-08-16", refreshKey: "next" }
          : { refreshKey: "fresh" },
      );
      tree = harness.renderWithoutEffects();
      expect(toggle(tree, "Breakfast", false).props.disabled).toBe(true);
      old();
      toggle(tree, "Breakfast", false).props.onPress();
      harness.flushEffects();
      tree = await harness.settle();
      old();
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
    byLabel(tree, "Load more diary entries").props.onPress();
    old();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.disabled).toBe(true);
    pending.resolve(response({}, 503));
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
    old();
    byLabel(tree, "Retry loading more diary entries").props.onPress();
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false)).toBeDefined();
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
    tree = await harness.settle();
    expect(toggle(tree, "Breakfast", false).props.disabled).toBe(false);
  });
});
