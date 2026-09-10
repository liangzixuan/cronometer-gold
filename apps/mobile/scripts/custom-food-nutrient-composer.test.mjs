import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import * as React from "react";
import { AppState } from "react-native";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCanonicalNutrientInput, RetentionScreen } from "../src/retention/RetentionScreen";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../src/retention/reminder-schedule", () => ({
  clearAllLocalReminderSchedules: vi.fn(),
  createSecureReminderScheduleStore: vi.fn(),
  reconcileLocalReminderSchedules: vi.fn(async () => ({ permission: "granted" })),
}));
const hooks = vi.hoisted(() => ({ current: null, appListeners: new Set(), operation: 0 }));
vi.mock("react", async (original) => ({
  ...(await original()),
  useState: (...args) => hooks.current.useState(...args),
  useRef: (...args) => hooks.current.useRef(...args),
  useCallback: (...args) => hooks.current.useCallback(...args),
  useEffect: (...args) => hooks.current.useEffect(...args),
  useMemo: (...args) => hooks.current.useMemo(...args),
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
  Platform: { OS: "web" },
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
          tree = RetentionScreen(props);
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
      tree = RetentionScreen(props);
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

const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const otherOwner = "049eb964-1327-49a1-ab4f-5c7c41a6b68a";
const foodId = "3bcfa2bf-4950-43f7-9f24-b983ac803012";
const timestamp = "2026-09-09T12:00:00.000Z";
const protein = {
  id: "203",
  code: "protein",
  name: "Protein",
  unit: "g",
  category: "macronutrient",
};
const sodium = { id: "307", code: "sodium", name: "Sodium", unit: "mg", category: "mineral" };
const sourceFood = {
  id: foodId,
  status: "active",
  revision: "1",
  currentVersion: {
    id: "123",
    versionNumber: 1,
    name: "Saved private food",
    brandName: "Private brand",
    notes: "Keep notes",
    serving: { id: "456", label: "scoop", grams: "25.000001" },
    nutrients: [
      {
        nutrient: { id: "208", code: "energy", name: "Energy", unit: "kcal" },
        state: "quantified",
        amountPer100Grams: "125.5000",
      },
    ],
    provenance: { kind: "user_entered", statement: "Synthetic owner-entered fixture." },
    createdAt: timestamp,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};
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
function receipt(request, overrides = {}) {
  const body = JSON.parse(request.body);
  const food = structuredClone(sourceFood);
  if (request.url.pathname === "/v1/custom-foods") food.id = "4bcfa2bf-4950-43f7-9f24-b983ac803012";
  food.currentVersion = {
    ...food.currentVersion,
    name: body.name,
    brandName: body.brandName,
    notes: body.notes,
    serving: body.serving ? { id: "456", ...body.serving } : null,
    nutrients: body.nutrients.map((row) => ({
      ...row,
      nutrient: {
        id: row.nutrientId,
        code: `nutrient_${row.nutrientId}`,
        name: `Nutrient ${row.nutrientId}`,
        unit: "g",
      },
    })),
  };
  for (const row of food.currentVersion.nutrients) delete row.nutrientId;
  return response({ data: { replayed: false, customFood: { ...food, ...overrides } } });
}
function setup(handler = () => undefined, overrides = {}) {
  const requests = [];
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      const request = { url: new URL(url), method: "GET", ...options };
      requests.push(request);
      const result = handler(request, requests);
      if (result !== undefined) return result;
      if (request.method === "POST") return receipt(request);
      if (request.url.pathname === "/v1/nutrients/targetable")
        return response({ data: [protein, sodium] });
      if (request.url.pathname === "/v1/custom-foods")
        return response({ data: [sourceFood], page: { nextCursor: null } });
      if (request.url.pathname === "/v1/biometrics/events")
        return response({ data: [], page: { nextCursor: null } });
      return response({ data: [] });
    }),
  );
  const queue = { status: "ready", pendingCount: 0 };
  const props = {
    ownerUserId: owner,
    sessionEpoch: 1,
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-session",
    profileTimeZone: "America/Chicago",
    diaryGroups: [],
    onUnauthorized: vi.fn(async () => {}),
    onErasurePrepared: vi.fn(),
    onErasureAccepted: vi.fn(async () => {}),
    quickAddOutboxController: {
      getState: () => queue,
      enqueueOperation: vi.fn(),
      requestDrain: vi.fn(),
    },
    quickAddOutboxState: queue,
    subscribeQuickAddReceipts: vi.fn(() => () => {}),
    ...overrides,
  };
  return { harness: screenHarness(props), props, requests };
}
function rawText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawText).join(" ");
  return value && typeof value === "object" ? rawText(value.props?.children) : "";
}
const text = (value) => rawText(value).replace(/\s+/gu, " ").trim();
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  if (typeof tree.type === "function") return nodes(tree.type(tree.props), predicate);
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function input(tree, label) {
  const found = nodes(
    tree,
    (node) => node.type === "TextInput" && node.props.accessibilityLabel === label,
  );
  expect(found).toHaveLength(1);
  return found[0];
}
function button(tree, label) {
  const found = nodes(tree, (node) => node.type === "Pressable" && text(node) === label);
  expect(found).toHaveLength(1);
  return found[0];
}
async function click(harness, label) {
  const tree = await harness.settle();
  const target = button(tree, label);
  expect(target.props.disabled).not.toBe(true);
  target.props.onPress();
  return harness.settle();
}
async function type(harness, label, value) {
  const tree = await harness.settle();
  const target = input(tree, label);
  expect(target.props.editable).not.toBe(false);
  target.props.onChangeText(value);
  return harness.settle();
}
const canonical = (tree) => input(tree, "Canonical nutrients per 100 g").props.value;
const writes = (requests) => requests.filter((request) => request.method !== "GET");
function state(value) {
  AppState.currentState = value;
  for (const listener of hooks.appListeners) listener(value);
}
async function fillManual(harness, amount = "0") {
  await type(harness, "Name", "Owner food");
  return type(harness, "Canonical nutrients per 100 g", `208=${amount}`);
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  hooks.appListeners.clear();
  AppState.currentState = "active";
});

describe("native named custom-food nutrient composer", () => {
  it("exposes every loaded name/unit, filters locally and leaves all drafts untouched until Add", async () => {
    const registry = Array.from({ length: 31 }, (_, index) => ({
      ...protein,
      id: String(index + 1),
      code: `n${index}`,
      name: `Available nutrient ${index}`,
    }));
    const { harness, requests } = setup((request) =>
      request.url.pathname === "/v1/nutrients/targetable"
        ? response({ data: registry })
        : undefined,
    );
    try {
      let tree = await fillManual(harness);
      await type(harness, "Definition notes", "Unrelated biometric draft");
      const before = requests.length;
      tree = await type(harness, "Find an available nutrient by name", "nutrient 30");
      tree = await click(harness, "Available nutrient 30 (g)");
      tree = await type(
        harness,
        "Available nutrient 30 amount (g per 100 g)",
        "0.00000000000000100",
      );
      expect(canonical(tree)).toBe("208=0");
      expect(input(tree, "Definition notes").props.value).toBe("Unrelated biometric draft");
      expect(input(tree, "Name").props.value).toBe("Owner food");
      expect(text(tree)).toContain("1 matching of 31 available nutrients");
      expect(requests).toHaveLength(before);
      tree = await click(harness, "Add nutrient row to draft");
      expect(canonical(tree)).toBe("208=0\n31=0.00000000000000100");
      expect(input(tree, "Available nutrient 30 amount (g per 100 g)").props.value).toBe("");
      expect(requests).toHaveLength(before);
    } finally {
      harness.unmount();
    }
  });
  for (const amount of ["0", "0.00000000000000100"])
    it(`appends exact quantified ${amount} losslessly and saves only explicitly`, async () => {
      const { harness, requests } = setup();
      try {
        await type(harness, "Name", " Exact food ");
        const raw = " 208=125.5000\r\n\r\n 999=unknown:withheld  ";
        await type(harness, "Canonical nutrients per 100 g", raw);
        let tree = await click(harness, "Protein (g)");
        expect(input(tree, "Protein amount (g per 100 g)").props.value).toBe("");
        tree = await click(harness, "Add nutrient row to draft");
        expect(canonical(tree)).toBe(raw);
        await type(harness, "Protein amount (g per 100 g)", amount);
        tree = await click(harness, "Add nutrient row to draft");
        expect(canonical(tree).startsWith(raw)).toBe(true);
        expect(canonical(tree).endsWith(`203=${amount}`)).toBe(true);
        expect(writes(requests)).toHaveLength(0);
        tree = await click(harness, "Create private food");
        expect(writes(requests)).toHaveLength(1);
        expect(writes(requests)[0].headers["if-match"]).toBeUndefined();
        expect(JSON.parse(writes(requests)[0].body).nutrients).toEqual([
          { nutrientId: "208", state: "quantified", amountPer100Grams: "125.5000" },
          { nutrientId: "999", state: "unknown", amountPer100Grams: null, reason: "withheld" },
          { nutrientId: "203", state: "quantified", amountPer100Grams: amount },
        ]);
        expect(input(tree, "Name").props.value).toBe("");
        expect(canonical(tree)).toBe("");
      } finally {
        harness.unmount();
      }
    });
  for (const [label, reason] of [
    ["Trace", null],
    ["Not reported", "not_reported"],
    ["Not analyzed", "not_analyzed"],
    ["Not applicable", "not_applicable"],
    ["Withheld", "withheld"],
  ])
    it(`keeps ${label} distinct and requires an explicit unknown reason`, async () => {
      const { harness, requests } = setup();
      try {
        let tree = await click(harness, "Protein (g)");
        tree = await click(harness, reason ? "Unknown" : "Trace");
        if (reason) {
          tree = await click(harness, "Add nutrient row to draft");
          expect(canonical(tree)).toBe("");
          expect(text(tree)).toContain("Choose an explicit unknown reason");
          tree = await click(harness, label);
        }
        tree = await click(harness, "Add nutrient row to draft");
        expect(canonical(tree)).toBe(reason ? `203=unknown:${reason}` : "203=trace");
        expect(writes(requests)).toHaveLength(0);
      } finally {
        harness.unmount();
      }
    });
  it("rejects duplicate or invalid manual text and preserves the draft on failed append", async () => {
    const { harness } = setup();
    try {
      await type(harness, "Canonical nutrients per 100 g", "203=1");
      await click(harness, "Protein (g)");
      await click(harness, "Trace");
      let tree = await click(harness, "Add nutrient row to draft");
      expect(canonical(tree)).toBe("203=1");
      expect(text(tree)).toMatch(/already|once|duplicate/i);
      await type(harness, "Canonical nutrients per 100 g", "broken manual text");
      tree = await click(harness, "Add nutrient row to draft");
      expect(canonical(tree)).toBe("broken manual text");
    } finally {
      harness.unmount();
    }
  });
  for (const registryState of ["empty", "failed"])
    it(`keeps manual calories usable with an ${registryState} named list`, async () => {
      const { harness, requests } = setup((request) =>
        request.url.pathname === "/v1/nutrients/targetable"
          ? response({ data: [] }, registryState === "failed" ? 503 : 200)
          : undefined,
      );
      try {
        let tree = await fillManual(harness, "120.125");
        expect(input(tree, "Canonical nutrients per 100 g").props.editable).toBe(true);
        if (registryState === "failed")
          expect(button(tree, "Add nutrient row to draft").props.disabled).toBe(true);
        tree = await click(harness, "Create private food");
        expect(writes(requests)).toHaveLength(1);
        expect(JSON.parse(writes(requests)[0].body).nutrients[0]).toEqual({
          nutrientId: "208",
          state: "quantified",
          amountPer100Grams: "120.125",
        });
        expect(input(tree, "Name").props.value).toBe("");
      } finally {
        harness.unmount();
      }
    });
  it("preserves all saved metadata on Revise and submits a pinned revision with an appended row", async () => {
    const { harness, requests } = setup();
    try {
      let tree = await click(harness, "Revise");
      expect(canonical(tree)).toBe("208=125.5000");
      await click(harness, "Sodium (mg)");
      await click(harness, "Trace");
      tree = await click(harness, "Add nutrient row to draft");
      expect(input(tree, "Brand (optional)").props.value).toBe("Private brand");
      expect(input(tree, "Serving grams").props.value).toBe("25.000001");
      await click(harness, "Save new version");
      const saved = writes(requests)[0];
      expect(saved.url.pathname).toBe(`/v1/custom-foods/${foodId}/revisions`);
      expect(saved.headers["if-match"]).toBe('"1"');
      expect(JSON.parse(saved.body)).toMatchObject({
        notes: "Keep notes",
        serving: { label: "scoop", grams: "25.000001" },
      });
    } finally {
      harness.unmount();
    }
  });
  it("fences stale manual/choice/Add/Save/Revise/Cancel controls and keeps same-value edits usable", async () => {
    const { harness, requests } = setup();
    try {
      let tree = await click(harness, "Revise");
      const oldCancel = button(tree, "Cancel edit").props.onPress;
      const oldSave = button(tree, "Save new version").props.onPress;
      const oldRevise = button(tree, "Revise").props.onPress;
      const oldManual = input(tree, "Canonical nutrients per 100 g").props.onChangeText;
      const oldTrace = button(tree, "Trace").props.onPress;
      await click(harness, "Protein (g)");
      tree = await type(harness, "Protein amount (g per 100 g)", "2.00");
      const oldAdd = button(tree, "Add nutrient row to draft").props.onPress;
      tree = await type(harness, "Protein amount (g per 100 g)", "3.00");
      oldCancel();
      oldSave();
      oldRevise();
      oldManual("208=999");
      oldTrace();
      oldAdd();
      tree = await harness.settle();
      expect(canonical(tree)).toBe("208=125.5000");
      expect(input(tree, "Protein amount (g per 100 g)").props.value).toBe("3.00");
      input(tree, "Protein amount (g per 100 g)").props.onChangeText("3.00");
      const add = button(tree, "Add nutrient row to draft").props.onPress;
      add();
      add();
      tree = await harness.settle();
      expect(canonical(tree)).toBe("208=125.5000\n203=3.00");
      expect(writes(requests)).toHaveLength(0);
      tree = await click(harness, "Cancel edit");
      expect(input(tree, "Exact amount per 100 g").props.value).toBe("");
      expect(canonical(tree)).toBe("");
    } finally {
      harness.unmount();
    }
  });
  it("holds exact body/key through malformed success and A-to-B-to-A retries", async () => {
    let attempt = 0;
    const { harness, requests } = setup((request) =>
      request.method === "POST"
        ? ++attempt === 1
          ? response({ data: { nonsense: true } })
          : response({}, 503)
        : undefined,
    );
    try {
      await fillManual(harness, "1.00");
      const tree = await click(harness, "Create private food");
      expect(input(tree, "Name").props.value).toBe("Owner food");
      await click(harness, "Create private food");
      await type(harness, "Canonical nutrients per 100 g", "208=2.00");
      await click(harness, "Create private food");
      await type(harness, "Canonical nutrients per 100 g", "208=1.00");
      await click(harness, "Create private food");
      const sent = writes(requests);
      expect(sent).toHaveLength(4);
      expect(sent[0].body).toBe(sent[1].body);
      expect(sent[0].body).toBe(sent[3].body);
      expect(sent[0].headers["idempotency-key"]).toBe(sent[1].headers["idempotency-key"]);
      expect(sent[0].headers["idempotency-key"]).toBe(sent[3].headers["idempotency-key"]);
      expect(sent[2].headers["idempotency-key"]).not.toBe(sent[0].headers["idempotency-key"]);
    } finally {
      harness.unmount();
    }
  });
  it("blocks same-render double save and all custom edits during the exact pending request", async () => {
    const held = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    try {
      let tree = await fillManual(harness);
      const save = button(tree, "Create private food").props.onPress;
      const edit = input(tree, "Name").props.onChangeText;
      const choose = button(tree, "Protein (g)").props.onPress;
      save();
      save();
      edit("while saving");
      choose();
      tree = await harness.settle();
      expect(writes(requests)).toHaveLength(1);
      expect(input(tree, "Name").props.editable).toBe(false);
      expect(input(tree, "Name").props.value).toBe("Owner food");
      held.resolve(receipt(writes(requests)[0]));
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });
  for (const boundary of ["owner", "session", "token", "API"])
    for (const phase of ["fetch", "JSON"])
      it(`fences ${phase} receipt and old private controls through ${boundary} replacement`, async () => {
        const held = deferred();
        const { harness, props, requests } = setup((request) =>
          request.method === "POST"
            ? phase === "fetch"
              ? held.promise
              : { status: 200, ok: true, json: () => held.promise }
            : undefined,
        );
        try {
          let tree = await fillManual(harness);
          await click(harness, "Protein (g)");
          tree = await click(harness, "Unknown");
          const oldField = input(tree, "Name").props.onChangeText;
          const oldAdd = button(tree, "Add nutrient row to draft").props.onPress;
          await click(harness, "Create private food");
          harness.updateProps(
            boundary === "owner"
              ? { ownerUserId: otherOwner }
              : boundary === "session"
                ? { sessionEpoch: 2 }
                : boundary === "token"
                  ? { accessToken: "replacement-token" }
                  : { apiBase: new URL("http://127.0.0.1:4001") },
          );
          tree = harness.renderWithoutEffects();
          expect(input(tree, "Name").props.value).toBe("");
          expect(canonical(tree)).toBe("");
          expect(button(tree, "Unknown").props.accessibilityState.selected).toBe(false);
          expect(input(tree, "Exact amount per 100 g").props.value).toBe("");
          oldField("stale");
          oldAdd();
          harness.flushEffects();
          await harness.settle();
          tree = await type(harness, "Name", "New owner draft");
          const accepted = receipt(writes(requests)[0]);
          held.resolve(phase === "fetch" ? accepted : await accepted.json());
          tree = await harness.settle();
          expect(input(tree, "Name").props.value).toBe("New owner draft");
          expect(props.onUnauthorized).not.toHaveBeenCalled();
          expect(text(tree)).not.toContain("Saved owner-entered private food version");
        } finally {
          harness.unmount();
        }
      });
  it("never merges a previous owner's saved list after the replacement list fails and a manual save succeeds", async () => {
    let replacement = false;
    const { harness, requests } = setup((request) =>
      replacement && request.method === "GET"
        ? response({}, 503)
        : request.url.pathname === "/v1/custom-foods" && request.method === "GET"
          ? response({ data: [sourceFood], page: { nextCursor: "old-owner-page" } })
          : undefined,
    );
    try {
      await harness.settle();
      replacement = true;
      harness.updateProps({ ownerUserId: otherOwner, accessToken: "new-owner" });
      await harness.settle();
      await fillManual(harness);
      const tree = await click(harness, "Create private food");
      expect(writes(requests)).toHaveLength(1);
      expect(text(tree)).not.toContain("Saved private food");
      expect(text(tree)).toContain("Owner food");
      expect(
        nodes(tree, (node) => node.type === "Pressable" && text(node) === "Load more custom foods"),
      ).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });
  it("rejects a retained Revise callback after a same-scope list refresh installs a newer row", async () => {
    let newer = false;
    const { harness } = setup((request) =>
      newer && request.url.pathname === "/v1/custom-foods"
        ? response({
            data: [
              {
                ...sourceFood,
                revision: "2",
                currentVersion: {
                  ...sourceFood.currentVersion,
                  name: "New version",
                  versionNumber: 2,
                },
              },
            ],
            page: { nextCursor: null },
          })
        : undefined,
    );
    try {
      let tree = await harness.settle();
      const old = button(tree, "Revise").props.onPress;
      newer = true;
      tree = await click(harness, "Refresh private data");
      old();
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
      tree = await click(harness, "Revise");
      expect(input(tree, "Name").props.value).toBe("New version");
    } finally {
      harness.unmount();
    }
  });
  for (const boundary of ["background", "replay"])
    it(`retains uncertain save identity across ${boundary} and rejects its late401`, async () => {
      const held = deferred();
      let attempt = 0;
      const { harness, requests, props } = setup((request) =>
        request.method === "POST" ? (++attempt === 1 ? held.promise : receipt(request)) : undefined,
      );
      try {
        let tree = await fillManual(harness, "0.0100");
        const old = input(tree, "Name").props.onChangeText;
        await click(harness, "Create private food");
        if (boundary === "background") {
          state("background");
          tree = await harness.settle();
          expect(input(tree, "Name").props.value).toBe("");
          state("active");
        } else harness.replayEffects();
        tree = await harness.settle();
        old("late old field");
        held.resolve(response({}, 401));
        tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("Owner food");
        expect(props.onUnauthorized).not.toHaveBeenCalled();
        tree = await click(harness, "Create private food");
        const sent = writes(requests);
        expect(sent).toHaveLength(2);
        expect(sent[1].body).toBe(sent[0].body);
        expect(sent[1].headers["idempotency-key"]).toBe(sent[0].headers["idempotency-key"]);
        expect(input(tree, "Name").props.value).toBe("");
      } finally {
        harness.unmount();
      }
    });
  it("closes current401 before async cleanup and keeps custom work closed across effect replay", async () => {
    const cleanup = deferred();
    const { harness, props } = setup(
      (request) => (request.method === "POST" ? response({}, 401) : undefined),
      { onUnauthorized: vi.fn(() => cleanup.promise) },
    );
    try {
      await fillManual(harness);
      let tree = await click(harness, "Create private food");
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
      expect(input(tree, "Name").props.value).toBe("");
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      harness.replayEffects();
      tree = await harness.settle();
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      cleanup.resolve();
      await harness.settle();
    } finally {
      harness.unmount();
    }
  });
  it("ignores delayed JSON and retained callbacks after unmount without custom state writes", async () => {
    const held = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? { status: 200, ok: true, json: () => held.promise } : undefined,
    );
    const tree = await fillManual(harness);
    const old = input(tree, "Name").props.onChangeText;
    await click(harness, "Create private food");
    harness.unmount();
    old("unmounted");
    held.resolve(await receipt(writes(requests)[0]).json());
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
  });
  it("retries a transport failure exactly and accepts normalized server-expanded nutrient evidence", async () => {
    let attempt = 0;
    const { harness, requests } = setup((request) => {
      if (request.method !== "POST") return undefined;
      if (++attempt === 1) throw new Error("Connection lost");
      const accepted = structuredClone(sourceFood);
      accepted.currentVersion.name = "Owner food";
      accepted.currentVersion.nutrients[0].amountPer100Grams = "1";
      accepted.currentVersion.nutrients.push({
        nutrient: { id: "203", code: "protein", name: "Protein", unit: "g" },
        state: "unknown",
        amountPer100Grams: null,
        reason: "not_reported",
      });
      return response({ data: { customFood: accepted, replayed: true } });
    });
    try {
      await fillManual(harness, "1.000");
      let tree = await click(harness, "Create private food");
      expect(canonical(tree)).toBe("208=1.000");
      tree = await click(harness, "Create private food");
      expect(writes(requests)[1].body).toBe(writes(requests)[0].body);
      expect(writes(requests)[1].headers["idempotency-key"]).toBe(
        writes(requests)[0].headers["idempotency-key"],
      );
      expect(input(tree, "Name").props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });
  for (const outcome of ["success", "failure"])
    it(`leaves a newer pending save busy when an old ${outcome} arrives`, async () => {
      const old = deferred();
      const current = deferred();
      let attempt = 0;
      const { harness, requests } = setup((request) =>
        request.method === "POST" ? (++attempt === 1 ? old.promise : current.promise) : undefined,
      );
      try {
        await fillManual(harness);
        await click(harness, "Create private food");
        state("background");
        await harness.settle();
        state("active");
        await harness.settle();
        await type(harness, "Name", "New draft");
        await click(harness, "Create private food");
        old.resolve(outcome === "success" ? receipt(writes(requests)[0]) : response({}, 503));
        let tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("New draft");
        expect(button(tree, "Create private food").props.disabled).toBe(true);
        expect(writes(requests)[1].signal.aborted).toBe(false);
        current.resolve(receipt(writes(requests)[1]));
        tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("");
      } finally {
        harness.unmount();
      }
    });
  for (const uncertain of [null, "unknown", "extension"])
    it(`requires exact active AppState instead of ${uncertain}`, async () => {
      AppState.currentState = uncertain;
      const { harness, requests } = setup();
      try {
        let tree = await harness.settle();
        expect(input(tree, "Name").props.editable).toBe(false);
        button(tree, "Create private food").props.onPress();
        expect(writes(requests)).toHaveLength(0);
        state("active");
        tree = await harness.settle();
        expect(input(tree, "Name").props.editable).toBe(true);
        tree = await click(harness, "Refresh private data");
        expect(button(tree, "Add nutrient row to draft").props.disabled).toBe(false);
      } finally {
        harness.unmount();
      }
    });
  it("preserves the manual draft and recovers a background-deferred named list through explicit refresh", async () => {
    const held = deferred();
    let attempt = 0;
    const { harness } = setup((request) =>
      request.url.pathname === "/v1/nutrients/targetable" && ++attempt === 1
        ? held.promise
        : undefined,
    );
    try {
      await harness.settle();
      state("background");
      held.resolve(response({ data: [protein, sodium] }));
      await harness.settle();
      state("active");
      let tree = await harness.settle();
      expect(button(tree, "Add nutrient row to draft").props.disabled).toBe(true);
      expect(text(tree)).toContain("Choose Refresh private data to try again");
      await fillManual(harness, "12.00");
      tree = await click(harness, "Refresh private data");
      expect(button(tree, "Add nutrient row to draft").props.disabled).toBe(false);
      expect(canonical(tree)).toBe("208=12.00");
      expect(input(tree, "Name").props.value).toBe("Owner food");
    } finally {
      harness.unmount();
    }
  });
  for (const phase of ["fetch401", "JSON"])
    it(`rejects an old-owner custom-food continuation ${phase}`, async () => {
      const held = deferred();
      let replacement = false;
      const otherFood = {
        ...sourceFood,
        id: "5bcfa2bf-4950-43f7-9f24-b983ac803012",
        currentVersion: { ...sourceFood.currentVersion, name: "Current owner food" },
      };
      const { harness, props } = setup((request) => {
        if (request.url.pathname !== "/v1/custom-foods") return undefined;
        if (request.url.searchParams.has("cursor"))
          return phase === "JSON"
            ? { status: 200, ok: true, json: () => held.promise }
            : held.promise;
        return response({
          data: replacement ? [otherFood] : [sourceFood],
          page: { nextCursor: replacement ? null : "next-page" },
        });
      });
      try {
        await click(harness, "Load more custom foods");
        replacement = true;
        harness.updateProps({ ownerUserId: otherOwner, accessToken: "replacement-owner" });
        await harness.settle();
        held.resolve(
          phase === "JSON" ? { data: [sourceFood], page: { nextCursor: null } } : response({}, 401),
        );
        const tree = await harness.settle();
        expect(text(tree)).toContain("Current owner food");
        expect(text(tree)).not.toContain("Saved private food");
        expect(props.onUnauthorized).not.toHaveBeenCalled();
        expect(button(tree, "Create private food").props.disabled).toBe(false);
      } finally {
        harness.unmount();
      }
    });
  it("keeps the parser's old screen export and unrelated profile-change drafts compatible", async () => {
    expect(parseCanonicalNutrientInput("208=0")).toEqual([
      { nutrientId: "208", state: "quantified", amountPer100Grams: "0" },
    ]);
    const { harness } = setup();
    try {
      await fillManual(harness);
      await type(harness, "Definition notes", "Unrelated draft");
      harness.updateProps({
        profileTimeZone: "UTC",
        diaryGroups: [{ mealSlot: "lunch", label: "Lunch" }],
      });
      const tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("Owner food");
      expect(input(tree, "Definition notes").props.value).toBe("Unrelated draft");
    } finally {
      harness.unmount();
    }
  });
});

describe("actual HealthRoute custom-editor identity wiring", () => {
  it("passes current owner/session identity without remounting unrelated retention flows", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "App.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const route = parsed.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "HealthRoute",
    );
    expect(route).toBeDefined();
    const compiled = ts.transpileModule(
      `${route.getText(parsed)}; globalThis.renderRoute = HealthRoute;`,
      { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const context = createContext({ React, RetentionScreen: "RetentionScreen" });
    new Script(compiled).runInContext(context);
    const props = {
      session: { user: { id: owner }, profile: { diaryGroups: [], timeZone: "UTC" } },
      sessionEpoch: 3,
      accessToken: "route-token",
      apiBase: new URL("http://127.0.0.1:4000"),
    };
    const rendered = context.renderRoute(props);
    expect(rendered.props.ownerUserId).toBe(owner);
    expect(rendered.props.sessionEpoch).toBe(3);
    expect(rendered.key).toBe(null);
    const replacement = context.renderRoute({
      ...props,
      sessionEpoch: 4,
      session: { ...props.session, user: { id: otherOwner } },
    });
    expect(replacement.props.ownerUserId).toBe(otherOwner);
    expect(replacement.props.sessionEpoch).toBe(4);
  });
});

function disclosure(tree, food = sourceFood) {
  const suffix = ` nutrients for ${food.currentVersion.name}, version ${food.currentVersion.versionNumber}`;
  const found = nodes(
    tree,
    (node) => node.type === "Pressable" && node.props.accessibilityLabel?.endsWith(suffix),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
function savedDetails(tree, food = sourceFood) {
  return nodes(
    tree,
    (node) => node.props.nativeID === `saved-nutrients-${food.id}-${food.currentVersion.id}`,
  );
}
async function toggleSaved(harness, food = sourceFood) {
  const target = disclosure(await harness.settle(), food);
  expect(target.props.disabled).not.toBe(true);
  target.props.onPress();
  return harness.settle();
}
function logEditor(tree) {
  const found = nodes(
    tree,
    (node) =>
      node.type === "View" &&
      React.Children.toArray(node.props.children).some(
        (child) => child.type === "Text" && text(child).startsWith("Log Saved private food v"),
      ),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
function editorSnapshot(tree) {
  return {
    inputs: nodes(tree, (node) => node.type === "TextInput").map((node) => [
      node.props.accessibilityLabel,
      node.props.value,
      node.props.editable,
    ]),
    choices: nodes(tree, (node) => node.props.accessibilityRole === "radio").map((node) => [
      text(node),
      node.props.accessibilityState,
    ]),
    messages: nodes(tree, (node) => node.props.accessibilityLiveRegion === "polite").map(text),
  };
}
const archivedFood = {
  ...sourceFood,
  id: "5bcfa2bf-4950-43f7-9f24-b983ac803012",
  status: "archived",
  currentVersion: { ...sourceFood.currentVersion, id: "124", name: "Archived private food" },
};

describe("native saved custom-food nutrient details", () => {
  it("starts closed and renders every saved row in order with exact values and all missingness states", async () => {
    const longAmount = `0.${"1234567890".repeat(19)}12345678`;
    expect(longAmount).toHaveLength(200);
    const rows = [
      sourceFood.currentVersion.nutrients[0],
      {
        nutrient: { id: "1001", code: "zero", name: "Same saved name", unit: "mg" },
        state: "quantified",
        amountPer100Grams: "0",
      },
      {
        nutrient: { id: "1002", code: "long", name: "Same saved name", unit: "g" },
        state: "quantified",
        amountPer100Grams: longAmount,
      },
      {
        nutrient: { id: "1003", code: "trace_only", name: "Trace evidence", unit: "mcg" },
        state: "trace",
        amountPer100Grams: null,
      },
      ...["not_reported", "not_analyzed", "not_applicable", "withheld"].map((reason, index) => ({
        nutrient: {
          id: String(1004 + index),
          code: `missing_${index}`,
          name: `Unknown evidence ${index}`,
          unit: "mg",
        },
        state: "unknown",
        amountPer100Grams: null,
        reason,
      })),
    ];
    while (rows.length < 256) {
      const index = rows.length;
      rows.push({
        nutrient: {
          id: String(2000 + index),
          code: `manual_${index}`,
          name:
            index === 255 ? `Last saved nutrient ${"n".repeat(100)}` : `Saved nutrient ${index}`,
          unit: index === 255 ? "u".repeat(32) : "g",
        },
        state: "quantified",
        amountPer100Grams: "0.00000100",
      });
    }
    const food = {
      ...sourceFood,
      currentVersion: { ...sourceFood.currentVersion, nutrients: rows },
    };
    const { harness, requests } = setup((request) =>
      request.url.pathname === "/v1/custom-foods"
        ? response({ data: [food], page: { nextCursor: null } })
        : request.url.pathname === "/v1/nutrients/targetable"
          ? response({ data: [] })
          : undefined,
    );
    try {
      let tree = await harness.settle();
      expect(savedDetails(tree, food)).toHaveLength(0);
      expect(disclosure(tree, food).props.accessibilityState).toEqual({
        expanded: false,
        disabled: false,
      });
      const before = requests.length;
      tree = await toggleSaved(harness, food);
      expect(disclosure(tree, food).props.accessibilityState.expanded).toBe(true);
      const details = savedDetails(tree, food)[0];
      expect(text(details)).toContain("Saved private food · Version 1 Saved nutrients per 100 g");
      const renderedRows = nodes(details, (node) => node.type === "View").slice(1);
      expect(renderedRows).toHaveLength(256);
      const reasons = {
        not_reported: "Not reported",
        not_analyzed: "Not analyzed",
        not_applicable: "Not applicable",
        withheld: "Withheld",
      };
      expect(
        renderedRows.map((row) => nodes(row, (node) => node.type === "Text").map(text)),
      ).toEqual(
        rows.map((row) => [
          `${row.nutrient.name} (${row.nutrient.unit})`,
          row.state === "quantified"
            ? row.amountPer100Grams
            : row.state === "trace"
              ? "Trace"
              : `Unknown · ${reasons[row.reason]}`,
        ]),
      );
      tree = await toggleSaved(harness, food);
      expect(savedDetails(tree, food)).toHaveLength(0);
      expect(requests).toHaveLength(before);
    } finally {
      harness.unmount();
    }
  });

  it("opens active and archived cards independently and rejects repeated or retained toggle controls", async () => {
    const { harness, requests } = setup((request) =>
      request.url.pathname === "/v1/custom-foods"
        ? response({ data: [sourceFood, archivedFood], page: { nextCursor: null } })
        : undefined,
    );
    try {
      let tree = await harness.settle();
      const oldShow = disclosure(tree).props.onPress;
      oldShow();
      oldShow();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(1);
      const oldHide = disclosure(tree).props.onPress;
      tree = await toggleSaved(harness, archivedFood);
      expect(savedDetails(tree, archivedFood)).toHaveLength(1);
      expect(savedDetails(tree)).toHaveLength(1);
      oldHide();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(1);
      tree = await toggleSaved(harness);
      oldShow();
      oldHide();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(0);
      expect(savedDetails(tree, archivedFood)).toHaveLength(1);
      expect(requests).toHaveLength(6);
    } finally {
      harness.unmount();
    }
  });

  for (const draft of ["create", "revise"])
    it(`preserves the ${draft} draft, named composer, log fields, status and retained draft actions`, async () => {
      const { harness, requests, props } = setup();
      try {
        if (draft === "revise") await click(harness, "Revise");
        else await fillManual(harness, "4.00100");
        await type(harness, "Notes", "Unsaved note");
        await click(harness, "Log exact version");
        await type(harness, "Quantity", "1.000001");
        input(logEditor(await harness.settle()), "Local date").props.onChangeText("2026-09-08");
        input(logEditor(await harness.settle()), "Local time").props.onChangeText("12:34");
        await type(harness, "Find an available nutrient by name", "sod");
        await click(harness, "Sodium (mg)");
        await click(harness, "Unknown");
        let tree = await click(harness, "Withheld");
        const add = button(tree, "Add nutrient row to draft").props.onPress;
        const before = editorSnapshot(tree);
        const count = requests.length;
        tree = await toggleSaved(harness);
        expect(editorSnapshot(tree)).toEqual(before);
        expect(text(savedDetails(tree)[0])).toContain("125.5000");
        tree = await toggleSaved(harness);
        expect(editorSnapshot(tree)).toEqual(before);
        expect(requests).toHaveLength(count);
        expect(props.quickAddOutboxController.enqueueOperation).not.toHaveBeenCalled();
        expect(props.quickAddOutboxController.requestDrain).not.toHaveBeenCalled();
        add();
        tree = await harness.settle();
        expect(canonical(tree)).toContain("307=unknown:withheld");
        expect(input(tree, "Quantity").props.value).toBe("1.000001");
      } finally {
        harness.unmount();
      }
    });

  it("allows toggles during a pending save and preserves ambiguous body/key retry and accepted cleanup", async () => {
    const held = deferred();
    let count = 0;
    const { harness, requests } = setup((request) =>
      request.method === "POST" && ++count === 1 ? held.promise : undefined,
    );
    try {
      let tree = await fillManual(harness, "1.00000100");
      const save = button(tree, "Create private food").props.onPress;
      await toggleSaved(harness);
      save();
      tree = await harness.settle();
      expect(writes(requests)).toHaveLength(1);
      const pending = editorSnapshot(tree);
      tree = await toggleSaved(harness);
      expect(editorSnapshot(tree)).toEqual(pending);
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      held.resolve(response({ data: { malformed: true } }));
      tree = await harness.settle();
      const failed = editorSnapshot(tree);
      const retry = button(tree, "Create private food").props.onPress;
      tree = await toggleSaved(harness);
      expect(editorSnapshot(tree)).toEqual(failed);
      retry();
      tree = await harness.settle();
      const sent = writes(requests);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toBe(sent[0].body);
      expect(sent[1].headers["idempotency-key"]).toBe(sent[0].headers["idempotency-key"]);
      expect(input(tree, "Name").props.value).toBe("");
      expect(savedDetails(tree)).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  it("preserves open unchanged rows, ordering and deduplication through paging and terminal empty pages", async () => {
    const held = deferred();
    let page = 0;
    const { harness, requests } = setup((request) =>
      request.url.pathname === "/v1/custom-foods"
        ? request.url.searchParams.has("cursor")
          ? ++page === 1
            ? held.promise
            : response({ data: [], page: { nextCursor: null } })
          : response({ data: [sourceFood], page: { nextCursor: "page-one" } })
        : undefined,
    );
    try {
      let tree = await toggleSaved(harness);
      const oldHide = disclosure(tree).props.onPress;
      tree = await click(harness, "Load more custom foods");
      expect(disclosure(tree).props.disabled).toBe(false);
      expect(savedDetails(tree)).toHaveLength(1);
      held.resolve(
        response({ data: [sourceFood, archivedFood], page: { nextCursor: "page-two" } }),
      );
      tree = await harness.settle();
      oldHide();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(1);
      expect(savedDetails(tree, archivedFood)).toHaveLength(0);
      expect(
        nodes(
          tree,
          (node) =>
            node.type === "Pressable" && node.props.accessibilityLabel?.includes(" nutrients for "),
        ).map((node) => node.props.accessibilityLabel),
      ).toEqual([
        "Hide nutrients for Saved private food, version 1",
        "Show nutrients for Archived private food, version 1",
      ]);
      tree = await toggleSaved(harness, archivedFood);
      tree = await click(harness, "Load more custom foods");
      expect(savedDetails(tree)).toHaveLength(1);
      expect(savedDetails(tree, archivedFood)).toHaveLength(1);
      expect(
        nodes(tree, (node) => node.type === "Pressable" && text(node) === "Load more custom foods"),
      ).toHaveLength(0);
      expect(requests).toHaveLength(8);
    } finally {
      harness.unmount();
    }
  });

  for (const outcome of ["same version", "replacement version", "removed", "failure"])
    it(`collapses at full refresh start and fences prior controls through ${outcome}`, async () => {
      const held = deferred();
      let refresh = false;
      const { harness } = setup((request) =>
        refresh && request.url.pathname === "/v1/custom-foods" ? held.promise : undefined,
      );
      try {
        await fillManual(harness, "5.000");
        let tree = await harness.settle();
        const oldShow = disclosure(tree).props.onPress;
        tree = await toggleSaved(harness);
        const oldHide = disclosure(tree).props.onPress;
        refresh = true;
        button(tree, "Refresh private data").props.onPress();
        oldHide();
        oldShow();
        tree = await harness.settle();
        expect(savedDetails(tree)).toHaveLength(0);
        expect(disclosure(tree).props.disabled).toBe(true);
        const pendingShow = disclosure(tree).props.onPress;
        pendingShow();
        const replacement = {
          ...sourceFood,
          revision: "2",
          currentVersion: {
            ...sourceFood.currentVersion,
            id: "999",
            versionNumber: 2,
            name: "Replacement saved food",
          },
        };
        held.resolve(
          outcome === "failure"
            ? response({}, 503)
            : response({
                data:
                  outcome === "removed"
                    ? []
                    : [outcome === "replacement version" ? replacement : sourceFood],
                page: { nextCursor: null },
              }),
        );
        tree = await harness.settle();
        oldShow();
        oldHide();
        pendingShow();
        tree = await harness.settle();
        expect(
          nodes(tree, (node) => node.props.nativeID?.startsWith("saved-nutrients-")),
        ).toHaveLength(0);
        expect(canonical(tree)).toBe("208=5.000");
        if (outcome === "failure") {
          expect(disclosure(tree).props.disabled).toBe(true);
          expect(text(tree)).toContain(
            "Choose Refresh private data to load saved nutrient details.",
          );
          disclosure(tree).props.onPress();
          tree = await harness.settle();
          expect(savedDetails(tree)).toHaveLength(0);
          refresh = false;
          tree = await click(harness, "Refresh private data");
          expect(canonical(tree)).toBe("208=5.000");
        }
        if (outcome !== "removed") {
          tree = await toggleSaved(
            harness,
            outcome === "replacement version" ? replacement : sourceFood,
          );
          expect(
            nodes(tree, (node) => node.props.nativeID?.startsWith("saved-nutrients-")),
          ).toHaveLength(1);
        }
      } finally {
        harness.unmount();
      }
    });

  it("closes the accepted replacement version without changing the exact save operation", async () => {
    const held = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    try {
      await click(harness, "Revise");
      await type(harness, "Canonical nutrients per 100 g", "208=222.000001");
      let tree = await harness.settle();
      const oldShow = disclosure(tree).props.onPress;
      tree = await toggleSaved(harness);
      const oldHide = disclosure(tree).props.onPress;
      await click(harness, "Save new version");
      const accepted = await receipt(writes(requests)[0]).json();
      accepted.data.customFood.currentVersion.id = "888";
      accepted.data.customFood.currentVersion.versionNumber = 2;
      accepted.data.customFood.revision = "2";
      held.resolve(response(accepted));
      tree = await harness.settle();
      oldShow();
      oldHide();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(0);
      const revised = accepted.data.customFood;
      expect(disclosure(tree, revised).props.accessibilityState.expanded).toBe(false);
      tree = await toggleSaved(harness, revised);
      expect(text(savedDetails(tree, revised)[0])).toContain("222.000001");
      expect(text(savedDetails(tree, revised)[0])).not.toContain("125.5000");
      expect(writes(requests)).toHaveLength(1);
      expect(writes(requests)[0].headers["if-match"]).toBe('"1"');
    } finally {
      harness.unmount();
    }
  });

  for (const boundary of ["owner", "session", "token", "API"])
    it(`hides open saved values before ${boundary} replacement effects and rejects old controls`, async () => {
      const { harness } = setup();
      try {
        let tree = await harness.settle();
        const oldShow = disclosure(tree).props.onPress;
        tree = await toggleSaved(harness);
        const oldHide = disclosure(tree).props.onPress;
        harness.updateProps(
          boundary === "owner"
            ? { ownerUserId: otherOwner }
            : boundary === "session"
              ? { sessionEpoch: 2 }
              : boundary === "token"
                ? { accessToken: "next-token" }
                : { apiBase: new URL("http://127.0.0.1:4001") },
        );
        tree = harness.renderWithoutEffects();
        expect(savedDetails(tree)).toHaveLength(0);
        expect(text(tree)).not.toContain("125.5000");
        oldShow();
        oldHide();
        harness.flushEffects();
        tree = await harness.settle();
        expect(savedDetails(tree)).toHaveLength(0);
        oldShow();
        oldHide();
        tree = await harness.settle();
        expect(savedDetails(tree)).toHaveLength(0);
        tree = await toggleSaved(harness);
        expect(savedDetails(tree)).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    });

  for (const boundary of ["background", "inactive", "unknown", null, "replay"])
    it(`closes saved details across ${boundary} and requires a fresh foreground action`, async () => {
      const { harness } = setup();
      try {
        let tree = await harness.settle();
        const oldShow = disclosure(tree).props.onPress;
        tree = await toggleSaved(harness);
        const oldHide = disclosure(tree).props.onPress;
        if (boundary === "replay") harness.replayEffects();
        else state(boundary);
        oldShow();
        oldHide();
        tree = await harness.settle();
        expect(savedDetails(tree)).toHaveLength(0);
        if (boundary !== "replay") state("active");
        tree = await harness.settle();
        oldShow();
        oldHide();
        tree = await harness.settle();
        expect(savedDetails(tree)).toHaveLength(0);
        tree = await toggleSaved(harness);
        expect(savedDetails(tree)).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    });

  it("cannot disclose after current session closure or effect replay", async () => {
    const { harness } = setup((request) =>
      request.method === "POST" ? response({}, 401) : undefined,
    );
    try {
      await fillManual(harness);
      let tree = await harness.settle();
      const oldShow = disclosure(tree).props.onPress;
      tree = await toggleSaved(harness);
      const oldHide = disclosure(tree).props.onPress;
      await click(harness, "Create private food");
      oldShow();
      oldHide();
      harness.replayEffects();
      tree = await harness.settle();
      oldShow();
      oldHide();
      tree = await harness.settle();
      expect(savedDetails(tree)).toHaveLength(0);
      expect(text(tree)).not.toContain("125.5000");
    } finally {
      harness.unmount();
    }
  });

  it("keeps the exact pinned log request after opening and closing saved nutrients", async () => {
    const { harness, props, requests } = setup();
    props.quickAddOutboxController.enqueueOperation.mockResolvedValue({
      operationId: "queued-log",
    });
    try {
      await click(harness, "Log exact version");
      await type(harness, "Quantity", "1.000001");
      input(logEditor(await harness.settle()), "Local date").props.onChangeText("2026-09-08");
      input(logEditor(await harness.settle()), "Local time").props.onChangeText("12:34");
      const log = button(await harness.settle(), "Secure & log pinned version").props.onPress;
      await toggleSaved(harness);
      await toggleSaved(harness);
      expect(props.quickAddOutboxController.enqueueOperation).not.toHaveBeenCalled();
      log();
      await harness.settle();
      expect(props.quickAddOutboxController.enqueueOperation).toHaveBeenCalledExactlyOnceWith({
        operationKind: "custom_food",
        customFoodName: "Saved private food",
        customFoodId: foodId,
        customFoodVersionId: "123",
        customFoodVersionNumber: 1,
        portion: { kind: "serving", servingId: "456", amount: "1.000001", servingLabel: "scoop" },
        mealSlot: "breakfast",
        localDate: "2026-09-08",
        occurredAt: "2026-09-08T17:34:00.000Z",
      });
      expect(props.quickAddOutboxController.requestDrain).toHaveBeenCalledExactlyOnceWith(
        "queued-log",
      );
      expect(writes(requests)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });

  it("never installs an old owner's custom list from a retained private Refresh callback", async () => {
    const replacement = {
      ...archivedFood,
      currentVersion: { ...archivedFood.currentVersion, name: "New owner saved food" },
    };
    const { harness } = setup((request) =>
      request.url.pathname === "/v1/custom-foods" &&
      request.headers.authorization === "Bearer replacement-token"
        ? response({ data: [replacement], page: { nextCursor: null } })
        : undefined,
    );
    try {
      let tree = await harness.settle();
      const oldRefresh = button(tree, "Refresh private data").props.onPress;
      const oldShow = disclosure(tree).props.onPress;
      harness.updateProps({ ownerUserId: otherOwner, accessToken: "replacement-token" });
      tree = await harness.settle();
      tree = await toggleSaved(harness, replacement);
      oldRefresh();
      tree = await harness.settle();
      oldShow();
      tree = await harness.settle();
      expect(text(tree)).not.toContain("Saved private food");
      expect(savedDetails(tree, replacement)).toHaveLength(1);
      expect(disclosure(tree, replacement).props.accessibilityState.expanded).toBe(true);
    } finally {
      harness.unmount();
    }
  });

  it("rejects retained disclosure callbacks after unmount without any state writes", async () => {
    const { harness, requests } = setup();
    let tree = await harness.settle();
    const oldShow = disclosure(tree).props.onPress;
    tree = await toggleSaved(harness);
    const oldHide = disclosure(tree).props.onPress;
    harness.unmount();
    oldShow();
    oldHide();
    expect(harness.writesAfterUnmount).toBe(0);
    expect(requests).toHaveLength(6);
  });
});

const trendDefinition = {
  id: "0bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "1",
  status: "active",
  name: "Weight trend metric",
  dimension: "mass",
  canonicalUnit: "kg",
  notes: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const otherTrendDefinition = {
  ...trendDefinition,
  id: "1bcfa2bf-4950-43f7-9f24-b983ac803012",
  name: "Other weight metric",
};
function trendAggregate(nutrient, variant = "zero") {
  if (variant === "missing") return null;
  return {
    nutrientId: nutrient.id,
    code: nutrient.code,
    name: nutrient.name,
    unit: nutrient.unit,
    knownAmount: variant === "partial" ? "12.34500100" : "0",
    completeness:
      variant === "partial" ? "partial" : variant === "unknown" ? "unknown" : "complete",
    isExact: variant === "zero",
    contributorCount: variant === "partial" ? 2 : 1,
    quantifiedCount: variant === "zero" || variant === "partial" ? 1 : 0,
    traceCount: variant === "trace" ? 1 : 0,
    unknownCount: variant === "partial" || variant === "unknown" ? 1 : 0,
    unknownReasonCounts: {
      not_reported: variant === "partial" ? 1 : 0,
      not_analyzed: 0,
      not_applicable: 0,
      withheld: variant === "unknown" ? 1 : 0,
    },
  };
}
function nutrientTrendResponse(request, nutrient = protein, variant = "zero") {
  return {
    data: {
      nutrient: {
        id: nutrient.id,
        code: nutrient.code,
        name: `Loaded ${nutrient.name}`,
        unit: nutrient.unit,
      },
      from: request.url.searchParams.get("from"),
      to: request.url.searchParams.get("to"),
      timeZone: "America/Chicago",
      bucket: "day",
      watermarkRevision: "1",
      points: [
        {
          localDate: request.url.searchParams.get("from"),
          startsAt: "2026-11-01T05:00:00.000Z",
          endsAt: "2026-11-02T06:00:00.000Z",
          aggregate: trendAggregate(nutrient, variant),
        },
      ],
    },
  };
}
function biometricTrendResponse(request, definition = trendDefinition) {
  return {
    data: {
      definition: { ...definition, name: `Loaded ${definition.name}` },
      from: request.url.searchParams.get("from"),
      to: request.url.searchParams.get("to"),
      timeZone: "America/Chicago",
      bucket: "day",
      points: [
        {
          localDate: request.url.searchParams.get("from"),
          startsAt: "2026-11-01T05:00:00.000Z",
          endsAt: "2026-11-02T06:00:00.000Z",
          count: 1,
          first: "70.000001",
          last: "70.000001",
          minimum: "70.000001",
          maximum: "70.000001",
        },
      ],
    },
  };
}
function setupTrends(
  handler = () => undefined,
  {
    available = [protein, sodium],
    metrics = [trendDefinition, otherTrendDefinition],
    props = {},
  } = {},
) {
  return setup((request, requests) => {
    const override = handler(request, requests);
    if (override !== undefined) return override;
    if (request.url.pathname === "/v1/nutrients/targetable") return response({ data: available });
    if (request.url.pathname === "/v1/biometrics/definitions") return response({ data: metrics });
    if (request.url.pathname === "/v1/trends/nutrients")
      return response(
        nutrientTrendResponse(
          request,
          available.find((item) => item.id === request.url.searchParams.get("nutrientId")),
        ),
      );
    if (request.url.pathname === "/v1/trends/biometrics")
      return response(
        biometricTrendResponse(
          request,
          metrics.find((item) => item.id === request.url.searchParams.get("definitionId")),
        ),
      );
    return undefined;
  }, props);
}
const trendRequests = (requests) =>
  requests.filter((request) => request.url.pathname.startsWith("/v1/trends/"));
async function setTrendDates(harness) {
  await type(harness, "From (YYYY-MM-DD)", "2026-11-01");
  return type(harness, "To (YYYY-MM-DD)", "2026-11-01");
}
function trendSection(tree) {
  const found = nodes(
    tree,
    (node) =>
      node.type === "View" &&
      React.Children.toArray(node.props.children).some(
        (child) => child.type === "Text" && text(child) === "Trends",
      ),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
async function clickTrend(harness, label) {
  const target = button(trendSection(await harness.settle()), label);
  expect(target.props.disabled).not.toBe(true);
  target.props.onPress();
  return harness.settle();
}
function trendHeaders(tree) {
  return nodes(
    tree,
    (node) => node.props.accessibilityRole === "header" && text(node).startsWith("Loaded "),
  ).map(text);
}

describe("native full loaded trend nutrient selection", () => {
  for (const size of [31, 256])
    it(`exposes all ${size} ordered nutrient names/units and loads the last exact ID only on request`, async () => {
      const available = Array.from({ length: size }, (_, index) => ({
        ...protein,
        id: String(index + 1),
        code: `n_${index}`,
        name: index > size - 3 ? "Duplicate nutrient name" : `Nutrient ${index}`,
        unit: index === size - 1 ? "mg" : "g",
      }));
      const { harness, requests } = setupTrends(undefined, { available, metrics: [] });
      try {
        let tree = await setTrendDates(harness);
        const choices = nodes(
          tree,
          (node) => node.props.accessibilityRole === "radio" && text(node).includes(" · "),
        );
        expect(choices.map(text)).toEqual(available.map((item) => `${item.name} · ${item.unit}`));
        expect(text(tree)).toContain(`${size} matching of ${size} loaded trend nutrients.`);
        const count = requests.length;
        tree = await click(harness, "Duplicate nutrient name · mg");
        expect(text(tree)).toContain("Selected nutrient: Duplicate nutrient name · mg");
        expect(requests).toHaveLength(count);
        tree = await click(harness, "Load local-day trends");
        expect(trendRequests(requests)).toHaveLength(1);
        expect(Object.fromEntries(trendRequests(requests)[0].url.searchParams)).toEqual({
          nutrientId: String(size),
          from: "2026-11-01",
          to: "2026-11-01",
        });
        expect(trendHeaders(tree)).toEqual([
          "Loaded Duplicate nutrient name (mg) · 2026-11-01 to 2026-11-01 · America/Chicago",
        ]);
      } finally {
        harness.unmount();
      }
    });

  it("filters literal trimmed case-insensitive names without changing selection/results and keeps Clear/same-value actions usable", async () => {
    const literal = { ...sodium, name: "Sodium [.*]" };
    const { harness, requests } = setupTrends(undefined, { available: [protein, literal] });
    try {
      await setTrendDates(harness);
      let tree = await click(harness, "Load local-day trends");
      const beforeHeaders = trendHeaders(tree);
      const before = requests.length;
      tree = await type(harness, "Find a trend nutrient by name", "  [.*]  ");
      expect(button(tree, "Sodium [.*] · mg")).toBeDefined();
      expect(text(tree)).toContain("Selected nutrient: Protein · g");
      tree = await type(harness, "Find a trend nutrient by name", " no such nutrient ");
      expect(text(tree)).toContain("0 matching of 2 loaded trend nutrients.");
      expect(text(tree)).toContain("No loaded nutrients match this name.");
      expect(trendHeaders(tree)).toEqual(beforeHeaders);
      const last = input(tree, "Find a trend nutrient by name").props.value;
      input(tree, "Find a trend nutrient by name").props.onChangeText("x".repeat(201));
      tree = await harness.settle();
      expect(input(tree, "Find a trend nutrient by name").props.value).toBe(last);
      tree = await type(harness, "Find a trend nutrient by name", "x".repeat(200));
      expect(input(tree, "Find a trend nutrient by name").props.value).toHaveLength(200);
      tree = await type(harness, "Find a trend nutrient by name", " pRoTeIn ");
      expect(button(tree, "Protein · g")).toBeDefined();
      tree = await click(harness, "Clear trend nutrient filter");
      expect(requests).toHaveLength(before);
      const load = button(tree, "Load local-day trends").props.onPress;
      input(tree, "Find a trend nutrient by name").props.onChangeText("");
      button(tree, "Clear trend nutrient filter").props.onPress();
      button(tree, "Protein · g").props.onPress();
      load();
      await harness.settle();
      expect(trendRequests(requests)).toHaveLength(4);
    } finally {
      harness.unmount();
    }
  });

  for (const [variant, label] of [
    ["zero", "0 g · exact"],
    ["trace", "At least 0 g · complete"],
    ["partial", "At least 12.34500100 g · partial"],
    ["unknown", "At least 0 g · unknown"],
    ["missing", "No data"],
  ])
    it(`preserves existing ${variant} trend evidence and response identity`, async () => {
      const { harness } = setupTrends(
        (request) =>
          request.url.pathname === "/v1/trends/nutrients"
            ? response(nutrientTrendResponse(request, protein, variant))
            : undefined,
        { metrics: [] },
      );
      try {
        await setTrendDates(harness);
        const tree = await click(harness, "Load local-day trends");
        expect(trendHeaders(tree)).toEqual([
          "Loaded Protein (g) · 2026-11-01 to 2026-11-01 · America/Chicago",
        ]);
        expect(text(tree)).toContain(`2026-11-01 : ${label}`);
      } finally {
        harness.unmount();
      }
    });

  for (const field of ["nutrient", "biometric", "date"])
    it(`clears only the affected ${field} result and keeps the paired loaded identity`, async () => {
      const { harness, requests } = setupTrends();
      try {
        await setTrendDates(harness);
        await click(harness, "Load local-day trends");
        const count = requests.length;
        const tree =
          field === "nutrient"
            ? await click(harness, "Sodium · mg")
            : field === "biometric"
              ? await clickTrend(harness, "Other weight metric")
              : await type(harness, "From (YYYY-MM-DD)", "2026-10-31");
        const headers = trendHeaders(tree);
        expect(headers).toHaveLength(field === "date" ? 0 : 1);
        if (field === "nutrient") expect(headers[0]).toContain("Loaded Weight trend metric (kg)");
        if (field === "biometric") expect(headers[0]).toContain("Loaded Protein (g)");
        expect(requests).toHaveLength(count);
      } finally {
        harness.unmount();
      }
    });

  it("keeps a paired in-flight read current through filtering and preserves unrelated pending save identity and disclosures", async () => {
    const held = deferred();
    let trendRequest;
    const { harness, requests } = setupTrends((request) => {
      if (request.url.pathname === "/v1/trends/nutrients") {
        trendRequest = request;
        return held.promise;
      }
      if (request.method === "POST") return response({}, 503);
      return undefined;
    });
    try {
      await setTrendDates(harness);
      await fillManual(harness, "0.00001");
      await click(harness, "Create private food");
      let tree = await toggleSaved(harness);
      await click(harness, "Load local-day trends");
      tree = await type(harness, "Find a trend nutrient by name", "sod");
      expect(trendRequest.signal.aborted).toBe(false);
      held.resolve(response(nutrientTrendResponse(trendRequest)));
      tree = await harness.settle();
      expect(trendHeaders(tree)).toHaveLength(2);
      expect(input(tree, "Name").props.value).toBe("Owner food");
      expect(canonical(tree)).toBe("208=0.00001");
      expect(savedDetails(tree)).toHaveLength(1);
      const snapshot = editorSnapshot(tree);
      const count = requests.length;
      tree = await click(harness, "Sodium · mg");
      expect(savedDetails(tree)).toHaveLength(1);
      expect(input(tree, "Name").props.value).toBe("Owner food");
      expect(editorSnapshot(tree).messages).toEqual(snapshot.messages);
      expect(requests).toHaveLength(count);
      await click(harness, "Create private food");
      const sent = writes(requests);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toBe(sent[0].body);
      expect(sent[1].headers["idempotency-key"]).toBe(sent[0].headers["idempotency-key"]);
    } finally {
      harness.unmount();
    }
  });

  it("permits current local picker actions while an unrelated custom save owns the busy state", async () => {
    const held = deferred();
    const { harness, requests } = setupTrends((request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    try {
      await fillManual(harness);
      await click(harness, "Create private food");
      let tree = await type(harness, "Find a trend nutrient by name", "sod");
      tree = await click(harness, "Sodium · mg");
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      expect(button(tree, "Load local-day trends").props.disabled).toBe(true);
      expect(writes(requests)).toHaveLength(1);
      held.resolve(receipt(writes(requests)[0]));
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
      expect(text(tree)).toContain("Selected nutrient: Sodium · mg");
    } finally {
      harness.unmount();
    }
  });

  it("rejects stale filter/Clear/choice/date/biometric/Load callbacks across edit-and-restore input generations", async () => {
    const { harness, requests } = setupTrends();
    try {
      let tree = await setTrendDates(harness);
      const oldFilter = input(tree, "Find a trend nutrient by name").props.onChangeText;
      const oldChoice = button(tree, "Sodium · mg").props.onPress;
      tree = await type(harness, "Find a trend nutrient by name", "sod");
      const clear = button(tree, "Clear trend nutrient filter").props.onPress;
      tree = await type(harness, "Find a trend nutrient by name", "protein");
      clear();
      oldFilter("stale");
      oldChoice();
      tree = await harness.settle();
      expect(input(tree, "Find a trend nutrient by name").props.value).toBe("protein");
      expect(text(tree)).toContain("Selected nutrient: Protein · g");
      const load = button(tree, "Load local-day trends").props.onPress;
      const oldDate = input(tree, "From (YYYY-MM-DD)").props.onChangeText;
      const oldMetric = button(trendSection(tree), "Other weight metric").props.onPress;
      await type(harness, "From (YYYY-MM-DD)", "2026-10-31");
      await type(harness, "From (YYYY-MM-DD)", "2026-11-01");
      load();
      oldDate("2026-10-30");
      oldMetric();
      tree = await harness.settle();
      expect(input(tree, "From (YYYY-MM-DD)").props.value).toBe("2026-11-01");
      expect(
        button(trendSection(tree), "Weight trend metric").props.accessibilityState.selected,
      ).toBe(true);
      expect(trendRequests(requests)).toHaveLength(0);
      const currentLoad = button(tree, "Load local-day trends").props.onPress;
      currentLoad();
      currentLoad();
      await harness.settle();
      expect(trendRequests(requests)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  for (const mismatch of [
    "nutrient ID",
    "nutrient unit",
    "aggregate ID",
    "aggregate unit",
    "nutrient from",
    "nutrient to",
    "nutrient zone",
    "definition ID",
    "biometric from",
    "biometric to",
    "biometric zone",
  ])
    it(`rejects a syntactically valid wrong ${mismatch} without installing the paired result`, async () => {
      const { harness } = setupTrends((request) => {
        const kind = request.url.pathname;
        if (!kind.startsWith("/v1/trends/")) return undefined;
        const value = kind.endsWith("/nutrients")
          ? nutrientTrendResponse(request)
          : biometricTrendResponse(request);
        if (kind.endsWith("/nutrients")) {
          if (mismatch === "nutrient ID") value.data.nutrient.id = "999";
          if (mismatch === "nutrient unit") value.data.nutrient.unit = "mg";
          if (mismatch === "aggregate ID") value.data.points[0].aggregate.nutrientId = "999";
          if (mismatch === "aggregate unit") value.data.points[0].aggregate.unit = "mg";
          if (mismatch === "nutrient from") value.data.from = "2026-10-31";
          if (mismatch === "nutrient to") value.data.to = "2026-11-02";
          if (mismatch === "nutrient zone") value.data.timeZone = "UTC";
        } else {
          if (mismatch === "definition ID") value.data.definition.id = otherTrendDefinition.id;
          if (mismatch === "biometric from") value.data.from = "2026-10-31";
          if (mismatch === "biometric to") value.data.to = "2026-11-02";
          if (mismatch === "biometric zone") value.data.timeZone = "UTC";
        }
        return response(value);
      });
      try {
        await setTrendDates(harness);
        const tree = await click(harness, "Load local-day trends");
        expect(trendHeaders(tree)).toHaveLength(0);
        expect(text(tree)).toContain("does not match the selected");
        expect(button(tree, "Load local-day trends").props.disabled).toBe(false);
      } finally {
        harness.unmount();
      }
    });

  it("distinguishes verified empty nutrients from unavailable metadata and allows biometric-only loading", async () => {
    const { harness, requests } = setupTrends(undefined, { available: [] });
    try {
      await setTrendDates(harness);
      let tree = await harness.settle();
      expect(text(tree)).toContain("No trend nutrients are available in the loaded list.");
      expect(text(tree)).toContain("No trend nutrient selected.");
      tree = await click(harness, "Load local-day trends");
      expect(trendRequests(requests).map((item) => item.url.pathname)).toEqual([
        "/v1/trends/biometrics",
      ]);
      expect(trendHeaders(tree)).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  for (const outcome of ["same", "removed", "failed"])
    it(`invalidates at full refresh start and handles ${outcome} metadata without silently substituting a selection`, async () => {
      const held = deferred();
      let refreshing = false;
      const { harness, requests } = setupTrends((request) =>
        refreshing && request.url.pathname === "/v1/nutrients/targetable"
          ? held.promise
          : undefined,
      );
      try {
        await setTrendDates(harness);
        await click(harness, "Sodium · mg");
        let tree = await type(harness, "Find a trend nutrient by name", "sod");
        const oldFilter = input(tree, "Find a trend nutrient by name").props.onChangeText;
        const oldLoad = button(tree, "Load local-day trends").props.onPress;
        refreshing = true;
        button(tree, "Refresh private data").props.onPress();
        oldLoad();
        oldFilter("late");
        tree = await harness.settle();
        expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(false);
        const pendingClear = button(tree, "Clear trend nutrient filter").props.onPress;
        held.resolve(
          outcome === "failed"
            ? response({}, 503)
            : response({ data: outcome === "removed" ? [protein] : [protein, sodium] }),
        );
        tree = await harness.settle();
        oldLoad();
        pendingClear();
        oldFilter("older");
        tree = await harness.settle();
        expect(input(tree, "Find a trend nutrient by name").props.value).toBe("sod");
        expect(trendRequests(requests)).toHaveLength(0);
        if (outcome === "same") expect(text(tree)).toContain("Selected nutrient: Sodium · mg");
        if (outcome === "removed") expect(text(tree)).toContain("No trend nutrient selected.");
        if (outcome === "failed") {
          expect(text(tree)).toContain("The trend nutrient list is unavailable.");
          expect(button(tree, "Load local-day trends").props.disabled).toBe(true);
          refreshing = false;
          tree = await click(harness, "Refresh private data");
          expect(text(tree)).toContain("Selected nutrient: Sodium · mg");
        }
      } finally {
        harness.unmount();
      }
    });

  for (const boundary of ["owner", "session", "token", "API", "zone"])
    for (const phase of ["fetch401", "JSON"])
      it(`hides old results and rejects retained inputs and late ${phase} after ${boundary} replacement before effects`, async () => {
        const held = deferred();
        let delay = false;
        let captured;
        const { harness, props } = setupTrends((request) => {
          if (delay && request.url.pathname === "/v1/trends/nutrients") {
            captured = request;
            return phase === "fetch401"
              ? held.promise
              : { status: 200, ok: true, json: () => held.promise };
          }
          return undefined;
        });
        try {
          await setTrendDates(harness);
          let tree = await click(harness, "Load local-day trends");
          const oldFilter = input(tree, "Find a trend nutrient by name").props.onChangeText;
          const oldChoice = button(tree, "Sodium · mg").props.onPress;
          const oldLoad = button(tree, "Load local-day trends").props.onPress;
          delay = true;
          await click(harness, "Load local-day trends");
          harness.updateProps(
            boundary === "owner"
              ? { ownerUserId: otherOwner }
              : boundary === "session"
                ? { sessionEpoch: 2 }
                : boundary === "token"
                  ? { accessToken: "changed-token" }
                  : boundary === "API"
                    ? { apiBase: new URL("http://127.0.0.1:4001") }
                    : { profileTimeZone: "UTC" },
          );
          tree = harness.renderWithoutEffects();
          expect(trendHeaders(tree)).toHaveLength(0);
          expect(input(tree, "Find a trend nutrient by name").props.value).toBe("");
          oldFilter("stale");
          oldChoice();
          oldLoad();
          held.resolve(phase === "fetch401" ? response({}, 401) : nutrientTrendResponse(captured));
          await Promise.resolve();
          harness.flushEffects();
          tree = await harness.settle();
          expect(trendHeaders(tree)).toHaveLength(0);
          expect(input(tree, "Find a trend nutrient by name").props.value).toBe("");
          expect(props.onUnauthorized).not.toHaveBeenCalled();
          expect(captured.signal.aborted).toBe(true);
        } finally {
          harness.unmount();
        }
      });

  for (const boundary of ["background", "unknown", null, "replay"])
    it(`aborts the old trend across ${boundary} while preserving custom data and allowing a fresh Load`, async () => {
      const held = deferred();
      let captured;
      let slow = true;
      const { harness, props } = setupTrends((request) => {
        if (slow && request.url.pathname === "/v1/trends/nutrients") {
          captured = request;
          return held.promise;
        }
        return undefined;
      });
      try {
        await setTrendDates(harness);
        await fillManual(harness, "7.00");
        await type(harness, "Find a trend nutrient by name", "prot");
        await click(harness, "Load local-day trends");
        if (boundary === "replay") harness.replayEffects();
        else state(boundary);
        let tree = await harness.settle();
        expect(trendHeaders(tree)).toHaveLength(0);
        expect(captured.signal.aborted).toBe(true);
        held.resolve(response({}, 401));
        slow = false;
        if (boundary !== "replay") state("active");
        tree = await harness.settle();
        expect(input(tree, "Find a trend nutrient by name").props.value).toBe("");
        expect(canonical(tree)).toBe("208=7.00");
        expect(props.onUnauthorized).not.toHaveBeenCalled();
        tree = await click(harness, "Load local-day trends");
        expect(trendHeaders(tree)).toHaveLength(2);
      } finally {
        harness.unmount();
      }
    });

  it("does not let an obsolete read release a later trend or custom save's busy state", async () => {
    const first = deferred();
    const second = deferred();
    const save = deferred();
    let attempt = 0;
    let secondRequest;
    const { harness, requests } = setupTrends((request) => {
      if (request.method === "POST") return save.promise;
      if (request.url.pathname === "/v1/trends/nutrients") {
        if (++attempt === 1) return first.promise;
        secondRequest = request;
        return second.promise;
      }
      return undefined;
    });
    try {
      await setTrendDates(harness);
      await fillManual(harness);
      await click(harness, "Load local-day trends");
      await click(harness, "Sodium · mg");
      await click(harness, "Load local-day trends");
      first.resolve(response({}, 503));
      let tree = await harness.settle();
      expect(button(tree, "Loading…").props.disabled).toBe(true);
      await type(harness, "From (YYYY-MM-DD)", "2026-10-31");
      await click(harness, "Create private food");
      second.resolve(response(nutrientTrendResponse(secondRequest, sodium)));
      tree = await harness.settle();
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      expect(trendHeaders(tree)).toHaveLength(0);
      save.resolve(receipt(writes(requests)[0]));
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
    } finally {
      harness.unmount();
    }
  });

  it("closes current unauthorized trend scope and keeps it closed across effect replay", async () => {
    const { harness, props } = setupTrends((request) =>
      request.url.pathname === "/v1/trends/nutrients" ? response({}, 401) : undefined,
    );
    try {
      await setTrendDates(harness);
      let tree = await harness.settle();
      const oldLoad = button(tree, "Load local-day trends").props.onPress;
      await click(harness, "Load local-day trends");
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
      harness.replayEffects();
      oldLoad();
      tree = await harness.settle();
      expect(button(tree, "Load local-day trends").props.disabled).toBe(true);
      expect(trendHeaders(tree)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });

  for (const action of ["create", "revise", "archive"])
    it(`keeps current nutrient metadata available after a successful metric ${action}`, async () => {
      const { harness } = setupTrends((request) => {
        if (
          request.method === "GET" ||
          !request.url.pathname.startsWith("/v1/biometrics/definitions")
        )
          return undefined;
        const body = request.body ? JSON.parse(request.body) : {};
        return response({
          data: {
            definition: {
              ...trendDefinition,
              ...(action === "create" ? { id: "2bcfa2bf-4950-43f7-9f24-b983ac803012" } : {}),
              name: body.name ?? trendDefinition.name,
              revision: "2",
              status: action === "archive" ? "archived" : "active",
            },
          },
        });
      });
      try {
        await setTrendDates(harness);
        await click(harness, "Sodium · mg");
        await type(harness, "Find a trend nutrient by name", "sod");
        let tree = await toggleSaved(harness);
        if (action !== "create") {
          const cards = nodes(
            tree,
            (node) =>
              node.type === "View" &&
              React.Children.toArray(node.props.children).some(
                (child) => child.type === "Text" && text(child) === trendDefinition.name,
              ),
          );
          expect(cards).toHaveLength(1);
          button(cards[0], action === "revise" ? "Revise" : "Archive").props.onPress();
          tree = await harness.settle();
        }
        if (action !== "archive") {
          await type(harness, "Metric name", "Updated metric");
          tree = await click(
            harness,
            action === "create" ? "Create definition" : "Save definition revision",
          );
        }
        expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(true);
        expect(input(tree, "Find a trend nutrient by name").props.value).toBe("sod");
        expect(text(tree)).toContain("Selected nutrient: Sodium · mg");
        expect(savedDetails(tree)).toHaveLength(1);
        tree = await click(harness, "Load local-day trends");
        expect(trendHeaders(tree)).toHaveLength(2);
      } finally {
        harness.unmount();
      }
    });

  for (const delayed of ["save", "archive"])
    it(`merges a delayed metric ${delayed} into the latest same-context accepted definition list`, async () => {
      const held = deferred();
      const created = {
        ...trendDefinition,
        id: "2bcfa2bf-4950-43f7-9f24-b983ac803012",
        name: "Concurrent metric",
      };
      const archived = { ...trendDefinition, status: "archived", revision: "2" };
      const { harness, requests } = setupTrends((request) => {
        if (request.url.pathname === "/v1/biometrics/definitions" && request.method === "POST")
          return delayed === "save" ? held.promise : response({ data: { definition: created } });
        if (
          request.url.pathname === `/v1/biometrics/definitions/${trendDefinition.id}` &&
          request.method === "DELETE"
        )
          return delayed === "archive"
            ? held.promise
            : response({ data: { definition: archived } });
        return undefined;
      });
      const archive = async () => {
        const cards = nodes(
          await harness.settle(),
          (node) =>
            node.type === "View" &&
            React.Children.toArray(node.props.children).some(
              (child) => child.type === "Text" && text(child) === trendDefinition.name,
            ),
        );
        expect(cards).toHaveLength(1);
        button(cards[0], "Archive").props.onPress();
        await harness.settle();
      };
      try {
        await setTrendDates(harness);
        await type(harness, "Metric name", "Concurrent metric");
        if (delayed === "save") {
          await click(harness, "Create definition");
          await archive();
        } else {
          await archive();
          await click(harness, "Create definition");
        }
        held.resolve(response({ data: { definition: delayed === "save" ? created : archived } }));
        let tree = await harness.settle();
        const metricChoices = nodes(
          trendSection(tree),
          (node) => node.props.accessibilityRole === "radio" && !text(node).includes(" · "),
        ).map(text);
        expect(metricChoices).toEqual([
          "Concurrent metric",
          "Weight trend metric (archived)",
          "Other weight metric",
        ]);
        expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(true);
        expect(writes(requests)).toHaveLength(2);
        tree = await click(harness, "Load local-day trends");
        expect(trendHeaders(tree)).toHaveLength(2);
      } finally {
        harness.unmount();
      }
    });

  it("accepts a pending metric save after same-owner Refresh installs a new definition list", async () => {
    const held = deferred();
    const created = {
      ...trendDefinition,
      id: "2bcfa2bf-4950-43f7-9f24-b983ac803012",
      name: "Metric accepted after refresh",
    };
    const { harness, requests } = setupTrends((request) =>
      request.method === "POST" && request.url.pathname === "/v1/biometrics/definitions"
        ? held.promise
        : undefined,
    );
    try {
      await setTrendDates(harness);
      await type(harness, "Metric name", created.name);
      await click(harness, "Create definition");
      let tree = await click(harness, "Refresh private data");
      expect(text(tree)).toContain("Private health data is current.");
      expect(input(tree, "Metric name").props.value).toBe(created.name);
      held.resolve(response({ data: { definition: created } }));
      tree = await harness.settle();
      expect(input(tree, "Metric name").props.value).toBe("Weight");
      expect(text(tree)).toContain(
        "Biometric definition saved; its dimension and unit are immutable history.",
      );
      const metricChoices = nodes(
        trendSection(tree),
        (node) => node.props.accessibilityRole === "radio" && !text(node).includes(" · "),
      ).map(text);
      expect(metricChoices).toEqual([created.name, trendDefinition.name, "Other weight metric"]);
      expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(true);
      expect(writes(requests)).toHaveLength(1);
      tree = await click(harness, "Load local-day trends");
      expect(trendHeaders(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  it("retains a same-owner metric accepted while background and cleans its saved draft", async () => {
    const held = deferred();
    const created = {
      ...trendDefinition,
      id: "2bcfa2bf-4950-43f7-9f24-b983ac803012",
      name: "Metric accepted while background",
    };
    const { harness, requests } = setupTrends((request) =>
      request.method === "POST" && request.url.pathname === "/v1/biometrics/definitions"
        ? held.promise
        : undefined,
    );
    try {
      await setTrendDates(harness);
      await type(harness, "Metric name", created.name);
      await click(harness, "Create definition");
      state("background");
      await harness.settle();
      held.resolve(response({ data: { definition: created } }));
      let tree = await harness.settle();
      expect(input(tree, "Metric name").props.value).toBe("Weight");
      expect(text(tree)).toContain(
        "Biometric definition saved; its dimension and unit are immutable history.",
      );
      expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(false);
      expect(trendHeaders(tree)).toHaveLength(0);
      state("active");
      tree = await harness.settle();
      expect(button(trendSection(tree), created.name).props.accessibilityState.disabled).toBe(
        false,
      );
      expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(true);
      expect(writes(requests)).toHaveLength(1);
      tree = await click(harness, "Load local-day trends");
      expect(trendHeaders(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  it("does not promote an old-owner metric receipt or retained Refresh into current picker metadata", async () => {
    const held = deferred();
    const { harness, requests } = setupTrends((request) =>
      request.method === "POST" && request.url.pathname === "/v1/biometrics/definitions"
        ? held.promise
        : undefined,
    );
    try {
      await setTrendDates(harness);
      let tree = await harness.settle();
      const oldRefresh = button(tree, "Refresh private data").props.onPress;
      await click(harness, "Create definition");
      harness.updateProps({ ownerUserId: otherOwner, accessToken: "new-owner-token" });
      tree = await harness.settle();
      const count = requests.length;
      oldRefresh();
      held.resolve(
        response({ data: { definition: { ...trendDefinition, name: "Obsolete private metric" } } }),
      );
      tree = await harness.settle();
      expect(requests).toHaveLength(count);
      expect(text(tree)).not.toContain("Obsolete private metric");
      expect(input(tree, "Find a trend nutrient by name").props.editable).toBe(true);
      tree = await click(harness, "Load local-day trends");
      expect(trendHeaders(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  it("keeps own Loading state when another operation releases the shared busy label", async () => {
    const held = deferred();
    let captured;
    const { harness } = setupTrends((request) => {
      if (request.method === "POST" && request.url.pathname === "/v1/biometrics/definitions")
        return response({}, 503);
      if (request.url.pathname === "/v1/trends/nutrients") {
        captured = request;
        return held.promise;
      }
      return undefined;
    });
    try {
      await setTrendDates(harness);
      await click(harness, "Load local-day trends");
      let tree = await click(harness, "Create definition");
      expect(button(tree, "Loading…").props.disabled).toBe(true);
      expect(captured.signal.aborted).toBe(false);
      held.resolve(response(nutrientTrendResponse(captured)));
      tree = await harness.settle();
      expect(button(tree, "Load local-day trends").props.disabled).toBe(false);
      expect(trendHeaders(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  it("suppresses stale trend finally state writes between private-scope render and effects", async () => {
    const held = deferred();
    let captured;
    const { harness } = setupTrends((request) => {
      if (request.url.pathname === "/v1/trends/nutrients") {
        captured = request;
        return { status: 200, ok: true, json: () => held.promise };
      }
      return undefined;
    });
    try {
      await setTrendDates(harness);
      await click(harness, "Load local-day trends");
      harness.updateProps({ accessToken: "replacement-before-effects" });
      const tree = harness.renderWithoutEffects();
      expect(trendHeaders(tree)).toHaveLength(0);
      const before = harness.stateWrites;
      held.resolve(nutrientTrendResponse(captured));
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
      expect(harness.stateWrites).toBe(before);
      harness.flushEffects();
      await harness.settle();
    } finally {
      harness.unmount();
    }
  });

  it("rejects delayed JSON and retained picker/Load after unmount without state writes", async () => {
    const held = deferred();
    let captured;
    const { harness, props } = setupTrends((request) => {
      if (request.url.pathname === "/v1/trends/nutrients") {
        captured = request;
        return { status: 200, ok: true, json: () => held.promise };
      }
      return undefined;
    });
    await setTrendDates(harness);
    const tree = await harness.settle();
    const oldFilter = input(tree, "Find a trend nutrient by name").props.onChangeText;
    const oldLoad = button(tree, "Load local-day trends").props.onPress;
    await click(harness, "Load local-day trends");
    harness.unmount();
    oldFilter("unmounted");
    oldLoad();
    held.resolve(nutrientTrendResponse(captured));
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
    expect(props.onUnauthorized).not.toHaveBeenCalled();
  });
});
