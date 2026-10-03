import * as React from "react";
import { AppState } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiaryGroups } from "../src/diary/diary";
import {
  createQuickAddOutboxController,
  QuickAddEnqueueAmbiguousError,
} from "../src/diary/quick-add-outbox";
import { createQuickAddOutboxStore } from "../src/diary/quick-add-outbox-store";
import { FoodSearchScreen } from "../src/search/FoodSearchScreen";

const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set() }));
vi.mock("react", async (original) => ({
  ...(await original()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
}));
vi.mock("expo-camera", () => ({ useCameraPermissions: () => [null, vi.fn(), vi.fn()] }));
vi.mock("../src/search/BarcodeScannerModal", () => ({
  BarcodeScannerModal: "BarcodeScannerModal",
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event, listener) => {
      hooks.appListeners.add(listener);
      return { remove: () => hooks.appListeners.delete(listener) };
    },
  },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
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
          tree = FoodSearchScreen(props);
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
      tree = FoodSearchScreen(props);
      return tree;
    },
    flushEffects() {
      const pendingEffects = effects;
      effects = [];
      for (const effect of pendingEffects) effect();
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

const owner = "4afda2f8-e150-40ed-88f1-a327cd5e2430";
const hit = {
  foodId: "101",
  foodVersionId: "202",
  kind: "generic",
  name: "Apple",
  brandName: null,
  marketCode: "US",
  languageTag: "en-US",
  source: {
    code: "USDA_FDC",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  defaultServing: {
    servingId: "303",
    label: "1 medium",
    quantity: "1",
    unit: "apple",
    gramWeight: "182",
    milliliterVolume: null,
  },
};
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
function byLabel(tree, label, type = "TextInput") {
  const found = nodes(
    tree,
    (node) => node.type === type && node.props.accessibilityLabel === label,
  );
  expect(found, label).toHaveLength(1);
  return found[0];
}
function add(tree) {
  const found = nodes(
    tree,
    (node) =>
      node.type === "Pressable" && /^Add .+ of Apple$/u.test(node.props.accessibilityLabel ?? ""),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
const response = (body) => ({ ok: true, status: 200, json: async () => body });
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const mounted = [];
async function setup(overrides = {}, mode = "search") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-17T16:12:34.567Z"));
  const requests = [];
  let receipt;
  const controller = {
    getState: vi.fn(() => ({ status: "idle", pendingCount: 0 })),
    enqueueOperation: vi.fn(async () => ({ operationId: "operation-1" })),
    requestDrain: vi.fn(async () => {}),
    retryBlockedHead: vi.fn(async () => {}),
    discardBlockedHead: vi.fn(async () => {}),
  };
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    profileTimeZone: "America/Chicago",
    profileRevision: "12",
    ownerUserId: owner,
    sessionEpoch: 7,
    isFocused: true,
    routeKey: "search-route",
    diaryDate: "2026-09-16",
    mealSlot: "lunch",
    diaryGroups: resetDiaryGroups(),
    quickAddOutboxController: controller,
    quickAddOutboxState: controller.getState(),
    subscribeQuickAddReceipts: (listener) => {
      receipt = listener;
      return () => {
        receipt = undefined;
      };
    },
    onAdded: vi.fn(),
    ...overrides,
  };
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      requests.push(String(url));
      return response(
        String(url).includes("/barcodes/")
          ? { data: hit }
          : String(url).includes("/autocomplete")
            ? { data: [] }
            : { data: [hit], page: { nextCursor: null } },
      );
    }),
  );
  const h = screenHarness(props);
  mounted.push(h);
  let tree = await h.settle();
  if (mode === "search") {
    byLabel(tree, "Food or brand").props.onChangeText("apple");
    tree = await h.settle();
    byLabel(tree, "Food or brand").props.onSubmitEditing();
  } else {
    byLabel(tree, "UPC, EAN, or GTIN digits").props.onChangeText("012345678905");
    tree = await h.settle();
    byLabel(tree, "Look up typed barcode", "Pressable").props.onPress();
  }
  tree = await h.settle();
  const ctx = {
    h,
    props,
    controller: props.quickAddOutboxController,
    requests,
    get tree() {
      return tree;
    },
    receive(operationId = "operation-1") {
      receipt?.({
        operationId,
        mutation: { entry: { localDate: "2026-09-16", mealSlot: "lunch" }, affectedDays: [] },
      });
    },
    async settle() {
      tree = await h.settle();
      return tree;
    },
    async edit(label, value) {
      byLabel(tree, label).props.onChangeText(value);
      return ctx.settle();
    },
    async pressAdd() {
      add(tree).props.onPress();
      return ctx.settle();
    },
    async change(next, effects = true) {
      h.updateProps(next);
      tree = effects ? await h.settle() : h.renderWithoutEffects();
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native optional public-food log time", () => {
  it.each(["search", "barcode"])(
    "logs an explicit time and raw serving quantity from %s",
    async (mode) => {
      const c = await setup({}, mode);
      expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("");
      expect(text(c.tree)).toContain("America/Chicago");
      const before = c.requests.length;
      await c.edit("Local time (optional)", "18:45");
      await c.edit("Apple quantity", "1.250000");
      expect(c.requests).toHaveLength(before);
      await c.pressAdd();
      expect(c.controller.enqueueOperation).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          operationKind: "public_food",
          foodVersionId: "202",
          localDate: "2026-09-16",
          mealSlot: "lunch",
          occurredAt: "2026-09-16T23:45:00.000Z",
          portion: {
            kind: "serving",
            servingId: "303",
            amount: "1.250000",
            servingLabel: "1 medium",
          },
        }),
      );
    },
  );
  it.each([
    ["2026-09-17", "", "2026-09-17T16:12:34.567Z"],
    ["2026-09-16", "", "2026-09-16T17:00:00.000Z"],
    ["2026-09-16", "00:00", "2026-09-16T05:00:00.000Z"],
    ["2026-11-01", "01:30", "2026-11-01T06:30:00.000Z"],
  ])(
    "resolves date %s and time %j without changing existing conventions",
    async (date, time, expected) => {
      const c = await setup({ diaryDate: date });
      await c.edit("Local time (optional)", time);
      byLabel(c.tree, "Use grams", "Pressable").props.onPress();
      await c.settle();
      await c.edit("Apple quantity", "15.000001");
      await c.pressAdd();
      expect(c.controller.enqueueOperation.mock.calls[0][0]).toMatchObject({
        occurredAt: expected,
        portion: { kind: "grams", grams: "15.000001" },
      });
    },
  );
  it("preserves the exact second-fold instant when automatic today is selected", async () => {
    const c = await setup({ diaryDate: "2026-11-01" });
    vi.setSystemTime(new Date("2026-11-01T07:30:45.123Z"));
    await c.pressAdd();
    expect(c.controller.enqueueOperation.mock.calls[0][0].occurredAt).toBe(
      "2026-11-01T07:30:45.123Z",
    );
  });
  it.each([" ", " 12:30", "12:30 ", "2:30", "24:00", "12:60", "02:30"])(
    "rejects raw %j before enqueue on the DST-gap date",
    async (time) => {
      const c = await setup({ diaryDate: "2026-03-08" });
      await c.edit("Local time (optional)", time);
      await c.pressAdd();
      expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
      expect(c.controller.requestDrain).not.toHaveBeenCalled();
    },
  );
  it("preserves time through search, meal and quantity changes and fences old draft controls", async () => {
    const c = await setup();
    const oldAdd = add(c.tree).props.onPress;
    const oldEdit = byLabel(c.tree, "Local time (optional)").props.onChangeText;
    await c.edit("Local time (optional)", "14:00");
    oldAdd();
    oldEdit("15:00");
    await c.settle();
    expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("14:00");
    const breakfast = nodes(
      c.tree,
      (node) => node.type === "Pressable" && text(node) === "Breakfast",
    )[0];
    breakfast.props.onPress();
    await c.settle();
    await c.edit("Food or brand", "apples");
    byLabel(c.tree, "Food or brand").props.onSubmitEditing();
    await c.settle();
    await c.edit("Apple quantity", "2");
    expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("14:00");
    expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
    await c.pressAdd();
    expect(c.controller.enqueueOperation.mock.calls[0][0]).toMatchObject({
      mealSlot: "breakfast",
      occurredAt: "2026-09-16T19:00:00.000Z",
    });
  });
  it.each([
    ["owner", { ownerUserId: "other-owner" }],
    ["session", { sessionEpoch: 8 }],
    ["profile", { profileRevision: "13" }],
    ["zone", { profileTimeZone: "UTC" }],
    ["route", { routeKey: "next-search" }],
    ["date", { diaryDate: "2026-09-15" }],
    ["meal", { mealSlot: "dinner" }],
    ["api", { apiBase: new URL("http://127.0.0.1:4001") }],
  ])(
    "clears time and rejects retained controls before %s replacement effects",
    async (_name, next) => {
      const c = await setup();
      await c.edit("Local time (optional)", "16:00");
      const oldAdd = add(c.tree).props.onPress;
      const oldEdit = byLabel(c.tree, "Local time (optional)").props.onChangeText;
      await c.change(next, false);
      expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("");
      oldAdd();
      oldEdit("17:00");
      c.h.flushEffects();
      await c.settle();
      oldAdd();
      expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
      expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("");
    },
  );
  it.each(["background", "inactive", "unknown", "blur", "unmount"])(
    "rejects retained log controls across %s",
    async (boundary) => {
      const c = await setup();
      await c.edit("Local time (optional)", "16:00");
      const oldAdd = add(c.tree).props.onPress;
      const oldEdit = byLabel(c.tree, "Local time (optional)").props.onChangeText;
      if (boundary === "unmount") c.h.unmount();
      else if (boundary === "blur") await c.change({ isFocused: false });
      else await c.app(boundary);
      oldAdd();
      oldEdit("17:00");
      expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
      expect(c.h.writesAfterUnmount).toBe(0);
      if (boundary !== "unmount") {
        if (boundary === "blur") await c.change({ isFocused: true });
        else await c.app("active");
        oldAdd();
        await c.settle();
        expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
        await c.pressAdd();
        expect(c.controller.enqueueOperation).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("suppresses a retired enqueue outcome while preserving the secured operation and its drain", async () => {
    const c = await setup();
    const held = deferred();
    c.controller.enqueueOperation.mockReturnValue(held.promise);
    await c.edit("Local time (optional)", "16:00");
    await c.pressAdd();
    await c.change({ routeKey: "replacement-route" });
    const before = text(c.tree);
    held.resolve({ operationId: "operation-1" });
    await c.settle();
    c.receive();
    await c.settle();
    expect(text(c.tree)).toBe(before);
    expect(c.controller.requestDrain).toHaveBeenCalledExactlyOnceWith("operation-1");
    expect(c.props.onAdded).not.toHaveBeenCalled();
  });
  it("retains receipt ownership after ordinary draft edits and ambiguous enqueue recovery", async () => {
    const c = await setup();
    c.controller.enqueueOperation.mockRejectedValue(
      new QuickAddEnqueueAmbiguousError("operation-1"),
    );
    await c.edit("Local time (optional)", "14:30");
    await c.pressAdd();
    await c.edit("Local time (optional)", "15:30");
    c.receive();
    await c.settle();
    expect(c.controller.requestDrain).toHaveBeenCalledExactlyOnceWith("operation-1");
    expect(c.props.onAdded).toHaveBeenCalledExactlyOnceWith("2026-09-16");
  });
  it("lets the real protected queue replay unchanged bytes and identity after draft and clock changes", async () => {
    const values = new Map();
    const store = createQuickAddOutboxStore({
      lockKey: `food-time-${crypto.randomUUID()}`,
      storage: {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
    });
    const wire = [];
    let nextId = 0;
    const controller = createQuickAddOutboxController({
      apiBase: new URL("http://127.0.0.1:4000"),
      ownerUserId: owner,
      expectedTimeZone: "America/Chicago",
      store,
      accessToken: () => "synthetic-session",
      isForeground: () => true,
      operationId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
      sha256Hex: async () => "f".repeat(64),
      onUnauthorized: async () => {},
      onFatalStoreError: async () => {},
      fetcher: async (url, options) => {
        wire.push({ url: String(url), body: options.body, headers: new Headers(options.headers) });
        throw new Error("Synthetic network loss");
      },
    });
    const enqueue = vi.spyOn(controller, "enqueueOperation");
    try {
      const c = await setup({
        quickAddOutboxController: controller,
        quickAddOutboxState: controller.getState(),
      });
      await c.edit("Local time (optional)", "14:45");
      await c.pressAdd();
      await enqueue.mock.results[0].value;
      await c.settle();
      await controller.requestDrain();
      const saved = (await store.snapshot(owner)).items[0];
      const first = wire[0];
      expect(saved.body.occurredAt).toBe("2026-09-16T19:45:00.000Z");
      expect(first.body).toBe(JSON.stringify(saved.body));
      expect(first.headers.get("idempotency-key")).toBe(saved.operationId);
      expect(first.headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
      await c.edit("Local time (optional)", "18:30");
      vi.setSystemTime(new Date("2026-09-18T01:00:00.000Z"));
      byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress();
      await c.settle();
      expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-17");
      const before = wire.length;
      await controller.requestDrain();
      expect(wire).toHaveLength(before + 1);
      expect(wire.at(-1).body).toBe(first.body);
      expect(wire.at(-1).headers.get("idempotency-key")).toBe(saved.operationId);
      expect((await store.snapshot(owner)).items[0]).toEqual(saved);
    } finally {
      controller.close();
    }
  });
});

describe("public-food receipt lifecycle retirement", () => {
  for (const boundary of ["focus", "background"]) {
    for (const pending of [false, true]) {
      it(`does not publish a ${pending ? "pending enqueue" : "registered operation"} receipt after ${boundary} retirement`, async () => {
        const c = await setup();
        const held = deferred();
        if (pending) c.controller.enqueueOperation.mockReturnValue(held.promise);
        await c.edit("Local time (optional)", "16:00");
        await c.pressAdd();
        if (boundary === "focus") {
          await c.change({ isFocused: false });
          await c.change({ isFocused: true });
        } else {
          await c.app("background");
          await c.app("active");
        }
        if (pending) {
          held.resolve({ operationId: "operation-1" });
          await c.settle();
        }
        c.receive();
        await c.settle();
        expect(c.props.onAdded).not.toHaveBeenCalled();
        expect(text(c.tree)).not.toContain("A queued food was confirmed");
        expect(c.controller.requestDrain).toHaveBeenCalledExactlyOnceWith("operation-1");
        expect(c.controller.enqueueOperation).toHaveBeenCalledTimes(1);
      });
    }
  }
});

describe("native public-food log date shortcuts", () => {
  it.each(["search", "barcode"])(
    "chooses profile-local dates without changing %s results, time, meal or quantity",
    async (mode) => {
      const c = await setup({ profileTimeZone: "Asia/Tokyo" }, mode);
      await c.edit("Local time (optional)", "14:35");
      if (mode === "barcode") {
        byLabel(c.tree, "Use grams", "Pressable").props.onPress();
        await c.settle();
      }
      await c.edit("Apple quantity", "1.000001");
      const results = nodes(
        c.tree,
        (node) => node.type === "View" && node.props.accessibilityLabel?.startsWith("Apple."),
      ).map((node) => node.props.accessibilityLabel);
      const requests = c.requests.length;
      const today = byLabel(c.tree, "Set diary date to today", "Pressable");
      expect(today.props.accessibilityRole).toBe("button");
      expect(today.props.accessibilityState.disabled).toBe(false);
      today.props.onPress();
      await c.settle();
      expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-18");
      byLabel(c.tree, "Set diary date to yesterday", "Pressable").props.onPress();
      await c.settle();
      expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-17");
      expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("14:35");
      expect(byLabel(c.tree, "Apple quantity").props.value).toBe("1.000001");
      expect(
        nodes(
          c.tree,
          (node) => node.type === "View" && node.props.accessibilityLabel?.startsWith("Apple."),
        ).map((node) => node.props.accessibilityLabel),
      ).toEqual(results);
      expect(c.requests).toHaveLength(requests);
      expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
      expect(c.controller.requestDrain).not.toHaveBeenCalled();
      await c.pressAdd();
      expect(c.controller.enqueueOperation.mock.calls[0][0]).toMatchObject({
        foodVersionId: "202",
        localDate: "2026-09-17",
        mealSlot: "lunch",
        occurredAt: "2026-09-17T05:35:00.000Z",
        portion:
          mode === "barcode"
            ? { kind: "grams", grams: "1.000001" }
            : { kind: "serving", amount: "1.000001", servingId: "303" },
      });
    },
  );

  it("uses the tap-time clock when the current screen spans profile-local midnight", async () => {
    const c = await setup();
    vi.setSystemTime(new Date("2026-09-18T04:59:59.000Z"));
    const today = byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress;
    vi.setSystemTime(new Date("2026-09-18T05:00:01.234Z"));
    today();
    await c.settle();
    expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-18");
    expect(byLabel(c.tree, "Local time (optional)").props.value).toBe("");
    await c.pressAdd();
    expect(c.controller.enqueueOperation.mock.calls[0][0].occurredAt).toBe(
      "2026-09-18T05:00:01.234Z",
    );
  });

  it.each([
    ["2027-01-01T18:00:00.000Z", "2026-12-31", "2026-12-31T18:00:00.000Z"],
    ["2028-03-01T18:00:00.000Z", "2028-02-29", "2028-02-29T18:00:00.000Z"],
    ["2026-11-02T05:30:00.000Z", "2026-10-31", "2026-10-31T17:00:00.000Z"],
  ])("chooses yesterday as a calendar day at %s", async (now, date, noon) => {
    const c = await setup();
    vi.setSystemTime(new Date(now));
    byLabel(c.tree, "Set diary date to yesterday", "Pressable").props.onPress();
    await c.settle();
    expect(byLabel(c.tree, "Diary local date").props.value).toBe(date);
    await c.pressAdd();
    expect(c.controller.enqueueOperation.mock.calls[0][0].occurredAt).toBe(noon);
  });

  it("retires stale draft shortcuts but keeps unchanged-date controls and manual date entry usable", async () => {
    const c = await setup();
    const oldToday = byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress;
    await c.edit("Local time (optional)", "12:30");
    oldToday();
    await c.settle();
    expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-16");
    await c.edit("Diary local date", "2026-09-17");
    const currentAdd = add(c.tree).props.onPress;
    byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress();
    await c.settle();
    currentAdd();
    await c.settle();
    expect(c.controller.enqueueOperation).toHaveBeenCalledTimes(1);
    expect(c.controller.enqueueOperation.mock.calls[0][0].occurredAt).toBe(
      "2026-09-17T17:30:00.000Z",
    );
  });

  it.each([
    ["session", { sessionEpoch: 8 }],
    ["profile", { profileTimeZone: "Asia/Tokyo", profileRevision: "13" }],
    ["route", { routeKey: "new-search" }],
  ])("keeps retained shortcuts inert across %s replacement", async (_name, next) => {
    const c = await setup();
    const oldToday = byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress;
    const oldYesterday = byLabel(c.tree, "Set diary date to yesterday", "Pressable").props.onPress;
    await c.change(next, false);
    expect(byLabel(c.tree, "Set diary date to today", "Pressable").props.disabled).toBe(true);
    oldToday();
    oldYesterday();
    c.h.flushEffects();
    await c.settle();
    await c.edit("Diary local date", "2026-09-14");
    oldToday();
    oldYesterday();
    await c.settle();
    expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-14");
    expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
  });

  it.each(["background", "blur", "unmount"])(
    "keeps inactive or retired shortcuts inert after %s",
    async (boundary) => {
      const c = await setup();
      const old = byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress;
      if (boundary === "unmount") c.h.unmount();
      else if (boundary === "blur") await c.change({ isFocused: false });
      else await c.app("background");
      old();
      if (boundary !== "unmount") {
        await c.settle();
        expect(byLabel(c.tree, "Set diary date to today", "Pressable").props.disabled).toBe(true);
        if (boundary === "blur") await c.change({ isFocused: true });
        else await c.app("active");
        old();
        await c.settle();
        expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-16");
      }
      expect(c.h.writesAfterUnmount).toBe(0);
      expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
    },
  );

  it("disables shortcuts during secure enqueue and preserves the original operation", async () => {
    const c = await setup();
    const held = deferred();
    c.controller.enqueueOperation.mockReturnValue(held.promise);
    const oldToday = byLabel(c.tree, "Set diary date to today", "Pressable").props.onPress;
    await c.pressAdd();
    const operation = JSON.stringify(c.controller.enqueueOperation.mock.calls[0][0]);
    const today = byLabel(c.tree, "Set diary date to today", "Pressable");
    expect(today.props.disabled).toBe(true);
    expect(today.props.accessibilityState.disabled).toBe(true);
    oldToday();
    today.props.onPress();
    await c.settle();
    expect(byLabel(c.tree, "Diary local date").props.value).toBe("2026-09-16");
    held.resolve({ operationId: "operation-1" });
    await c.settle();
    expect(JSON.stringify(c.controller.enqueueOperation.mock.calls[0][0])).toBe(operation);
    expect(c.controller.enqueueOperation).toHaveBeenCalledTimes(1);
  });
});

// Feature lifecycle fixtures retain their existing synthetic transport. The
// real origin and native transport boundary is covered by mobile-profile tests.
vi.mock("../src/api/mobile-fetch", () => ({
  mobileFetch: (...arguments_) => globalThis.fetch(...arguments_),
}));

describe("mobile search request retirement", () => {
  function button(tree, label) {
    const found = nodes(tree, (n) => n.type === "Pressable" && text(n).trim() === label);
    expect(found).toHaveLength(1);
    return found[0];
  }
  function page(rows = [hit], nextCursor = null) {
    return response({ data: rows, page: { nextCursor } });
  }
  function installSearch(responder) {
    const requests = [];
    globalThis.fetch.mockImplementation((input, options) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/autocomplete")) return Promise.resolve(response({ data: [] }));
      expect(url.pathname).toBe("/v1/foods/search");
      const request = { url, signal: options.signal };
      requests.push(request);
      return Promise.resolve().then(() => responder(request));
    });
    return requests;
  }
  async function submit(c, query) {
    await c.edit("Food or brand", query);
    byLabel(c.tree, "Food or brand").props.onSubmitEditing();
    return c.settle();
  }
  function expectEmpty(c) {
    expect(text(c.tree)).toContain("Enter a food or brand name before searching.");
    expect(
      nodes(c.tree, (n) => /^Add .+ of Apple$/u.test(n.props.accessibilityLabel ?? "")),
    ).toHaveLength(0);
    expect(
      nodes(c.tree, (n) => n.type === "Pressable" && text(n).trim() === "Load more results"),
    ).toHaveLength(0);
    expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
    expect(c.controller.requestDrain).not.toHaveBeenCalled();
  }

  for (const blank of ["", " \t\n "]) {
    for (const phase of ["response", "body"]) {
      it(`keeps ${blank === "" ? "empty" : "whitespace"} keyboard submission empty after a retired ${phase}`, async () => {
        const c = await setup();
        const held = deferred();
        const requests = installSearch(() =>
          phase === "response" ? held.promise : { ok: true, status: 200, json: () => held.promise },
        );
        try {
          await submit(c, "retired apples");
          expect(requests).toHaveLength(1);
          await submit(c, blank);
          expectEmpty(c);
          const emptyView = text(c.tree);
          held.resolve(
            phase === "response"
              ? page([hit], "s1.next")
              : { data: [hit], page: { nextCursor: "s1.next" } },
          );
          await c.settle();
          expectEmpty(c);
          expect(text(c.tree)).toBe(emptyView);
          expect(requests[0].signal.aborted).toBe(true);
          expect(requests).toHaveLength(1);
          installSearch(() => page());
          await submit(c, "fresh apples");
          expect(add(c.tree)).toBeDefined();
          expect(text(c.tree)).toContain("1 result shown for “fresh apples”.");
          expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
        } finally {
          held.resolve(page());
          await c.settle();
        }
      });
    }
  }

  for (const outcome of ["network", "http", "malformed"]) {
    it(`ignores a retired ${outcome} failure after blank validation`, async () => {
      const c = await setup();
      const held = deferred();
      const requests = installSearch(() =>
        held.promise.then(() => {
          if (outcome === "network") throw new Error("synthetic unavailable");
          if (outcome === "http") return { ok: false, status: 503, json: async () => ({}) };
          return response({ data: "malformed" });
        }),
      );
      try {
        await submit(c, "retired apples");
        await submit(c, "");
        const emptyView = text(c.tree);
        held.resolve();
        await c.settle();
        expectEmpty(c);
        expect(text(c.tree)).toBe(emptyView);
        expect(requests[0].signal.aborted).toBe(true);
      } finally {
        held.resolve();
        await c.settle();
      }
    });
  }

  for (const destination of ["blank", "fresh search"]) {
    it(`ignores a retired invalid continuation after ${destination}`, async () => {
      const c = await setup();
      const held = deferred();
      const requests = installSearch(({ url }) =>
        url.searchParams.has("cursor") ? held.promise : page([hit], "s1.next"),
      );
      try {
        await submit(c, "paged apples");
        button(c.tree, "Load more results").props.onPress();
        await c.settle();
        expect(requests).toHaveLength(2);
        await submit(c, destination === "blank" ? "" : "fresh apples");
        const currentView = text(c.tree);
        held.resolve({ ok: false, status: 400, json: async () => ({}) });
        await c.settle();
        expect(text(c.tree)).toBe(currentView);
        expect(requests[1].signal.aborted).toBe(true);
        expect(text(c.tree)).not.toContain("These results changed while you were browsing");
        if (destination === "blank") expectEmpty(c);
        else expect(text(c.tree)).toContain("1 result shown for “fresh apples”.");
        expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
        expect(c.controller.requestDrain).not.toHaveBeenCalled();
      } finally {
        held.resolve({ ok: false, status: 400 });
        await c.settle();
      }
    });
  }

  it("retains valid pagination merging and current continuation-expiry recovery", async () => {
    const c = await setup();
    const second = { ...hit, foodId: "102", foodVersionId: "203", name: "Pear" };
    const requests = installSearch(({ url }) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "s1.first") return page([hit, second], "s1.expired");
      if (cursor === "s1.expired") return { ok: false, status: 400 };
      return page([hit], "s1.first");
    });
    await submit(c, "fruit");
    button(c.tree, "Load more results").props.onPress();
    await c.settle();
    expect(text(c.tree)).toContain("2 results shown for “fruit”.");
    expect(add(c.tree)).toBeDefined();
    expect(
      nodes(c.tree, (n) => /^Add .+ of Pear$/u.test(n.props.accessibilityLabel ?? "")),
    ).toHaveLength(1);
    expect(requests[1].url.searchParams.get("cursor")).toBe("s1.first");
    button(c.tree, "Load more results").props.onPress();
    await c.settle();
    expect(text(c.tree)).toContain(
      "These results changed while you were browsing. Search again for a fresh result set.",
    );
    expect(
      nodes(c.tree, (n) => n.type === "Pressable" && text(n).trim() === "Load more results"),
    ).toHaveLength(0);
    await submit(c, "fresh fruit");
    expect(text(c.tree)).toContain("1 result shown for “fresh fruit”.");
    expect(requests).toHaveLength(4);
    expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
    expect(c.controller.requestDrain).not.toHaveBeenCalled();
  });

  it("does not write a late continuation error after unmount", async () => {
    const c = await setup();
    const held = deferred();
    const requests = installSearch(({ url }) =>
      url.searchParams.has("cursor") ? held.promise : page([hit], "s1.next"),
    );
    await submit(c, "paged apples");
    button(c.tree, "Load more results").props.onPress();
    await c.settle();
    c.h.unmount();
    held.resolve({ ok: false, status: 400 });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(requests[1].signal.aborted).toBe(true);
    expect(c.h.writesAfterUnmount).toBe(0);
    expect(c.controller.enqueueOperation).not.toHaveBeenCalled();
  });
});
