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

const savedFoodFilterLabel = "Filter loaded custom foods by name";
const clearSavedFoodFilterLabel = "Clear custom food filter";
function savedFoodCards(tree) {
  return nodes(
    tree,
    (node) =>
      node.type === "Pressable" && node.props.accessibilityLabel?.includes(" nutrients for "),
  );
}
function nonFilterSnapshot(tree) {
  const snapshot = editorSnapshot(tree);
  return {
    ...snapshot,
    inputs: snapshot.inputs.filter(([label]) => label !== savedFoodFilterLabel),
    messages: snapshot.messages.filter((value) => !value.includes("loaded custom foods.")),
    trends: trendHeaders(tree),
  };
}

describe("native loaded saved custom-food name filter", () => {
  it("matches trimmed literal names, preserves duplicate IDs/order and bounds raw input at 200 characters", async () => {
    const foods = [
      sourceFood,
      {
        ...archivedFood,
        currentVersion: { ...archivedFood.currentVersion, name: sourceFood.currentVersion.name },
      },
      {
        ...sourceFood,
        id: "6bcfa2bf-4950-43f7-9f24-b983ac803012",
        currentVersion: { ...sourceFood.currentVersion, id: "125", name: "Literal [.*] food" },
      },
    ];
    const { harness, requests } = setup((request) =>
      request.url.pathname === "/v1/custom-foods"
        ? response({ data: foods, page: { nextCursor: null } })
        : undefined,
    );
    try {
      let tree = await harness.settle();
      const before = requests.length;
      expect(savedFoodCards(tree)).toHaveLength(3);
      tree = await type(harness, savedFoodFilterLabel, "  SAVED pRIVATE  ");
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("  SAVED pRIVATE  ");
      const matches = savedFoodCards(tree);
      expect(matches).toHaveLength(2);
      matches[0].props.onPress();
      tree = await harness.settle();
      expect(savedDetails(tree, foods[0])).toHaveLength(1);
      expect(savedDetails(tree, foods[1])).toHaveLength(0);
      savedFoodCards(tree)[1].props.onPress();
      tree = await harness.settle();
      expect(savedDetails(tree, foods[1])).toHaveLength(1);
      expect(text(tree)).toContain("2 matching · 3 loaded custom foods.");
      tree = await type(harness, savedFoodFilterLabel, "[.*]");
      expect(savedFoodCards(tree).map((node) => node.props.accessibilityLabel)).toEqual([
        "Show nutrients for Literal [.*] food, version 1",
      ]);
      tree = await type(harness, savedFoodFilterLabel, "x".repeat(201));
      expect(input(tree, savedFoodFilterLabel).props.maxLength).toBe(200);
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("x".repeat(200));
      expect(text(tree)).toContain("0 matching · 3 loaded custom foods.");
      expect(text(tree)).toContain("No loaded custom foods match this filter.");
      tree = await type(harness, savedFoodFilterLabel, "  ");
      expect(savedFoodCards(tree)).toHaveLength(3);
      tree = await click(harness, clearSavedFoodFilterLabel);
      expect(savedDetails(tree, foods[0])).toHaveLength(1);
      expect(savedDetails(tree, foods[1])).toHaveLength(1);
      expect(requests).toHaveLength(before);
    } finally {
      harness.unmount();
    }
  });

  it("rejects retained field/Clear callbacks and keeps same-value edits and empty Clear usable no-ops", async () => {
    const { harness, requests } = setup();
    try {
      let tree = await harness.settle();
      const originalField = input(tree, savedFoodFilterLabel).props.onChangeText;
      const originalClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
      originalField("");
      originalClear();
      originalField("saved");
      tree = await harness.settle();
      const currentField = input(tree, savedFoodFilterLabel).props.onChangeText;
      const currentClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
      currentField("saved");
      currentField("PRIVATE");
      originalClear();
      originalField("obsolete");
      tree = await harness.settle();
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("PRIVATE");
      await click(harness, clearSavedFoodFilterLabel);
      currentClear();
      currentField("old");
      tree = await harness.settle();
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("");
      expect(requests).toHaveLength(6);
    } finally {
      harness.unmount();
    }
  });

  it("keeps zero-match paging/retry reachable and preserves overlap, open rows and terminal accumulated counts", async () => {
    let page = 0;
    const held = deferred();
    const { harness, requests } = setup((request) => {
      if (request.url.pathname !== "/v1/custom-foods") return undefined;
      if (!request.url.searchParams.has("cursor"))
        return response({ data: [sourceFood], page: { nextCursor: "page-one" } });
      page += 1;
      return page === 1
        ? response({}, 503)
        : page === 2
          ? held.promise
          : response({ data: [], page: { nextCursor: null } });
    });
    try {
      await toggleSaved(harness);
      let tree = await type(harness, savedFoodFilterLabel, "archived");
      expect(savedFoodCards(tree)).toHaveLength(0);
      expect(text(tree)).toContain("More records may remain; load more to include them.");
      tree = await click(harness, "Load more custom foods");
      expect(text(tree)).toContain("More custom foods could not be loaded.");
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("archived");
      tree = await click(harness, "Load more custom foods");
      tree = await type(harness, savedFoodFilterLabel, "  ARCHIVED  ");
      held.resolve(
        response({ data: [sourceFood, archivedFood], page: { nextCursor: "page-two" } }),
      );
      tree = await harness.settle();
      expect(savedFoodCards(tree)).toHaveLength(1);
      expect(text(tree)).toContain("1 matching · 2 loaded custom foods.");
      tree = await click(harness, "Load more custom foods");
      expect(text(tree)).toContain("1 matching · 2 loaded custom foods.");
      expect(text(tree)).toContain("No more records remain in this listing.");
      expect(
        nodes(tree, (node) => node.type === "Pressable" && text(node) === "Load more custom foods"),
      ).toHaveLength(0);
      tree = await click(harness, clearSavedFoodFilterLabel);
      expect(savedFoodCards(tree).map((node) => node.props.accessibilityLabel)).toEqual([
        "Hide nutrients for Saved private food, version 1",
        "Show nutrients for Archived private food, version 1",
      ]);
      expect(savedDetails(tree)).toHaveLength(1);
      expect(requests).toHaveLength(9);
      expect(writes(requests)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });

  for (const cursor of [null, "first-empty-page"])
    it(`distinguishes a verified empty first page with cursor ${cursor}`, async () => {
      const { harness } = setup((request) =>
        request.url.pathname === "/v1/custom-foods"
          ? response({ data: [], page: { nextCursor: cursor } })
          : undefined,
      );
      try {
        const tree = await harness.settle();
        expect(text(tree)).toContain("0 matching · 0 loaded custom foods.");
        expect(text(tree)).toContain(
          cursor ? "No custom foods loaded yet." : "No custom foods were found in this listing.",
        );
        expect(text(tree)).toContain(
          cursor ? "More records may remain" : "No more records remain in this listing.",
        );
        if (cursor) expect(button(tree, "Load more custom foods").props.disabled).toBe(false);
      } finally {
        harness.unmount();
      }
    });

  it("does not verify a failed initial list from a manual save, and recovers verification only from Refresh", async () => {
    const held = deferred();
    let first = true;
    const { harness } = setup((request) =>
      first && request.method === "GET" && request.url.pathname === "/v1/custom-foods"
        ? held.promise
        : undefined,
    );
    try {
      let tree = await harness.settle();
      expect(text(tree)).toContain("Loading the saved custom-food list…");
      tree = await type(harness, savedFoodFilterLabel, "Owner");
      held.resolve(response({}, 503));
      tree = await harness.settle();
      expect(text(tree)).toContain("The saved custom-food list has not been verified.");
      expect(text(tree)).not.toContain("No more records remain in this listing.");
      await fillManual(harness);
      tree = await click(harness, "Create private food");
      expect(text(tree)).toContain("1 matching · 1 loaded custom foods.");
      expect(text(tree)).toContain("The saved custom-food list has not been verified.");
      expect(text(tree)).not.toContain("No custom foods were found in this listing.");
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("Owner");
      first = false;
      tree = await click(harness, "Refresh private data");
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("Owner");
      expect(text(tree)).toContain("0 matching · 1 loaded custom foods.");
      expect(text(tree)).toContain("No more records remain in this listing.");
    } finally {
      harness.unmount();
    }
  });

  for (const outcome of ["success", "failure"])
    it(`retains the query and allows filtering through same-scope refresh ${outcome}`, async () => {
      const held = deferred();
      let refresh = false;
      const { harness } = setup((request) =>
        refresh && request.url.pathname === "/v1/custom-foods" ? held.promise : undefined,
      );
      try {
        await toggleSaved(harness);
        await fillManual(harness, "9.0001");
        await type(harness, savedFoodFilterLabel, "saved");
        refresh = true;
        await click(harness, "Refresh private data");
        let tree = await type(harness, savedFoodFilterLabel, "PRIVATE");
        expect(savedDetails(tree)).toHaveLength(0);
        expect(canonical(tree)).toBe("208=9.0001");
        held.resolve(
          outcome === "failure"
            ? response({}, 503)
            : response({ data: [sourceFood], page: { nextCursor: null } }),
        );
        tree = await harness.settle();
        expect(input(tree, savedFoodFilterLabel).props.value).toBe("PRIVATE");
        expect(savedFoodCards(tree)).toHaveLength(1);
        expect(disclosure(tree).props.disabled).toBe(outcome === "failure");
        expect(text(tree)).toContain(
          outcome === "failure"
            ? "The saved custom-food list has not been verified."
            : "No more records remain in this listing.",
        );
      } finally {
        harness.unmount();
      }
    });

  for (const draft of ["create", "revise"])
    it(`preserves ${draft} composer/log/trend fields and open details when hiding the saved card`, async () => {
      const { harness, requests, props } = setupTrends();
      props.quickAddOutboxController.enqueueOperation.mockResolvedValue({
        operationId: "filtered-log",
      });
      try {
        await setTrendDates(harness);
        await click(harness, "Load local-day trends");
        if (draft === "revise") {
          const cards = nodes(
            await harness.settle(),
            (node) =>
              node.type === "View" &&
              React.Children.toArray(node.props.children).some(
                (child) => child.type === "Text" && text(child) === sourceFood.currentVersion.name,
              ),
          );
          expect(cards).toHaveLength(1);
          button(cards[0], "Revise").props.onPress();
          await harness.settle();
        } else await fillManual(harness, "4.00100");
        await type(harness, "Notes", "Unsaved note");
        await click(harness, "Log exact version");
        await type(harness, "Quantity", "1.000001");
        input(logEditor(await harness.settle()), "Local date").props.onChangeText("2026-09-08");
        input(logEditor(await harness.settle()), "Local time").props.onChangeText("12:34");
        await type(harness, "Find an available nutrient by name", "sod");
        await click(harness, "Sodium (mg)");
        await click(harness, "Unknown");
        await click(harness, "Withheld");
        let tree = await toggleSaved(harness);
        const add = button(tree, "Add nutrient row to draft").props.onPress;
        const log = button(tree, "Secure & log pinned version").props.onPress;
        const before = nonFilterSnapshot(tree);
        const count = requests.length;
        tree = await type(harness, savedFoodFilterLabel, "no saved match");
        expect(savedFoodCards(tree)).toHaveLength(0);
        expect(savedDetails(tree)).toHaveLength(0);
        expect(nonFilterSnapshot(tree)).toEqual(before);
        tree = await click(harness, clearSavedFoodFilterLabel);
        expect(savedDetails(tree)).toHaveLength(1);
        expect(nonFilterSnapshot(tree)).toEqual(before);
        expect(requests).toHaveLength(count);
        add();
        tree = await harness.settle();
        expect(canonical(tree)).toContain("307=unknown:withheld");
        log();
        await harness.settle();
        expect(props.quickAddOutboxController.enqueueOperation).toHaveBeenCalledExactlyOnceWith({
          operationKind: "custom_food",
          customFoodName: sourceFood.currentVersion.name,
          customFoodId: foodId,
          customFoodVersionId: "123",
          customFoodVersionNumber: 1,
          portion: { kind: "serving", servingId: "456", amount: "1.000001", servingLabel: "scoop" },
          mealSlot: "breakfast",
          localDate: "2026-09-08",
          occurredAt: "2026-09-08T17:34:00.000Z",
        });
        expect(writes(requests)).toHaveLength(0);
      } finally {
        harness.unmount();
      }
    });

  it("preserves pending custom-save ownership, exact ambiguous retry and accepted cleanup while filtering", async () => {
    const held = deferred();
    let count = 0;
    const { harness, requests } = setup((request) =>
      request.method === "POST" && ++count === 1 ? held.promise : undefined,
    );
    try {
      await fillManual(harness, "1.00000100");
      await toggleSaved(harness);
      await click(harness, "Create private food");
      let tree = await harness.settle();
      const pending = nonFilterSnapshot(tree);
      tree = await type(harness, savedFoodFilterLabel, "Owner");
      expect(nonFilterSnapshot(tree)).toEqual(pending);
      held.resolve(response({ data: { malformed: true } }));
      tree = await harness.settle();
      const failed = nonFilterSnapshot(tree);
      const retry = button(tree, "Create private food").props.onPress;
      tree = await click(harness, clearSavedFoodFilterLabel);
      expect(nonFilterSnapshot(tree)).toEqual(failed);
      await type(harness, savedFoodFilterLabel, "Owner");
      retry();
      tree = await harness.settle();
      const sent = writes(requests);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toBe(sent[0].body);
      expect(sent[1].headers["idempotency-key"]).toBe(sent[0].headers["idempotency-key"]);
      expect(input(tree, "Name").props.value).toBe("");
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("Owner");
      expect(savedFoodCards(tree)).toHaveLength(1);
      expect(text(tree)).toContain("1 matching · 2 loaded custom foods.");
      tree = await click(harness, clearSavedFoodFilterLabel);
      expect(savedDetails(tree)).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  it("does not invalidate a current pending trend read while filtering saved foods", async () => {
    const held = deferred();
    let captured;
    const { harness, requests } = setupTrends((request) => {
      if (request.url.pathname === "/v1/trends/nutrients") {
        captured = request;
        return held.promise;
      }
      return undefined;
    });
    try {
      await setTrendDates(harness);
      await click(harness, "Load local-day trends");
      const count = requests.length;
      await type(harness, savedFoodFilterLabel, "no match");
      await click(harness, clearSavedFoodFilterLabel);
      expect(requests).toHaveLength(count);
      expect(captured.signal.aborted).toBe(false);
      held.resolve(response(nutrientTrendResponse(captured)));
      const tree = await harness.settle();
      expect(trendHeaders(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  for (const boundary of ["owner", "session", "token", "API", "zone", "groups"])
    it(`hides old query/cards before ${boundary} replacement effects and rejects retained filter controls`, async () => {
      const { harness } = setup();
      try {
        let tree = await type(harness, savedFoodFilterLabel, "Saved");
        const oldField = input(tree, savedFoodFilterLabel).props.onChangeText;
        const oldClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
        harness.updateProps(
          boundary === "owner"
            ? { ownerUserId: otherOwner }
            : boundary === "session"
              ? { sessionEpoch: 2 }
              : boundary === "token"
                ? { accessToken: "replacement" }
                : boundary === "API"
                  ? { apiBase: new URL("http://127.0.0.1:4001") }
                  : boundary === "zone"
                    ? { profileTimeZone: "UTC" }
                    : {
                        diaryGroups: [
                          { mealSlot: "breakfast", label: "Changed meal", sortOrder: 0 },
                        ],
                      },
        );
        tree = harness.renderWithoutEffects();
        expect(input(tree, savedFoodFilterLabel).props.value).toBe("");
        expect(savedFoodCards(tree)).toHaveLength(0);
        oldField("old");
        oldClear();
        input(tree, savedFoodFilterLabel).props.onChangeText("before installation");
        harness.flushEffects();
        tree = await harness.settle();
        expect(input(tree, savedFoodFilterLabel).props.value).toBe("");
        await type(harness, savedFoodFilterLabel, "new query");
        oldField("obsolete");
        oldClear();
        tree = await harness.settle();
        expect(input(tree, savedFoodFilterLabel).props.value).toBe("new query");
      } finally {
        harness.unmount();
      }
    });

  it("retains the query when equivalent same-private props are installed", async () => {
    const { harness } = setup();
    try {
      await type(harness, savedFoodFilterLabel, "Saved");
      harness.updateProps({ apiBase: new URL("http://127.0.0.1:4000"), diaryGroups: [] });
      const tree = await harness.settle();
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("Saved");
      expect(savedFoodCards(tree)).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  for (const boundary of ["background", "inactive", "unknown", null, "replay"])
    it(`hides/invalidate controls across ${boundary} and restores the query in the same foreground scope`, async () => {
      const { harness } = setup();
      try {
        let tree = await type(harness, savedFoodFilterLabel, "Saved");
        const oldField = input(tree, savedFoodFilterLabel).props.onChangeText;
        const oldClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
        if (boundary === "replay") harness.replayEffects();
        else state(boundary);
        tree = await harness.settle();
        if (boundary !== "replay") {
          expect(input(tree, savedFoodFilterLabel).props.value).toBe("");
          expect(savedFoodCards(tree)).toHaveLength(0);
          expect(input(tree, savedFoodFilterLabel).props.editable).toBe(false);
        }
        oldField("background");
        oldClear();
        if (boundary !== "replay") state("active");
        tree = await harness.settle();
        oldField("obsolete after return");
        oldClear();
        tree = await harness.settle();
        expect(input(tree, savedFoodFilterLabel).props.value).toBe("Saved");
        expect(savedFoodCards(tree)).toHaveLength(1);
      } finally {
        harness.unmount();
      }
    });

  it("resets and hides the query after current closure and rejects old callbacks across replay", async () => {
    let closed = false;
    const { harness, props } = setup((request) =>
      closed && request.url.pathname === "/v1/custom-foods" ? response({}, 401) : undefined,
    );
    try {
      let tree = await type(harness, savedFoodFilterLabel, "private name");
      const oldField = input(tree, savedFoodFilterLabel).props.onChangeText;
      const oldClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
      closed = true;
      await click(harness, "Refresh private data");
      oldField("old");
      oldClear();
      harness.replayEffects();
      tree = await harness.settle();
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("");
      expect(input(tree, savedFoodFilterLabel).props.editable).toBe(false);
      expect(savedFoodCards(tree)).toHaveLength(0);
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      harness.unmount();
    }
  });

  it("rejects retained filter and Clear after unmount without requests or state writes", async () => {
    const { harness, requests } = setup();
    const tree = await type(harness, savedFoodFilterLabel, "Saved");
    const oldField = input(tree, savedFoodFilterLabel).props.onChangeText;
    const oldClear = button(tree, clearSavedFoodFilterLabel).props.onPress;
    const count = requests.length;
    harness.unmount();
    oldField("unmounted");
    oldClear();
    expect(requests).toHaveLength(count);
    expect(harness.writesAfterUnmount).toBe(0);
  });
});

function customCopyButton(tree, food = sourceFood) {
  const label = `Copy saved ${food.currentVersion.name}, version ${food.currentVersion.versionNumber}, to a new draft`;
  const matches = nodes(
    tree,
    (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}
async function copyCustom(harness, food = sourceFood) {
  const target = customCopyButton(await harness.settle(), food);
  expect(target.props.disabled).toBe(false);
  target.props.onPress();
  return harness.settle();
}
const discardCustomCopy = "Discard draft and copy saved version";
function customCopyChoices(tree) {
  return nodes(
    tree,
    (node) => node.type === "Text" && text(node) === "Replace unsaved custom-food work?",
  );
}
function rawCustomFields(tree) {
  return Object.fromEntries(
    [
      "Name",
      "Brand (optional)",
      "Serving label (optional)",
      "Serving grams",
      "Canonical nutrients per 100 g",
      "Notes",
    ].map((label) => [label, input(tree, label).props.value]),
  );
}

describe("native saved custom-food copy to new draft", () => {
  for (const status of ["active", "archived"])
    it(`copies all exact saved fields and 256 nutrient states from an ${status} source with no write until Create`, async () => {
      const exact = `0.${"1234567890".repeat(19)}12345678`;
      const rows = Array.from({ length: 256 }, (_, index) => ({
        nutrient: {
          id: String(index + 1000),
          code: `saved_${index}`,
          name: `Saved nutrient ${index}`,
          unit: "mg",
        },
        state: "quantified",
        amountPer100Grams: index === 0 ? "0" : exact,
      }));
      rows[0].nutrient = { id: "208", code: "energy", name: "Energy", unit: "kcal" };
      rows[1] = { nutrient: rows[1].nutrient, state: "trace", amountPer100Grams: null };
      ["not_reported", "not_analyzed", "not_applicable", "withheld"].forEach((reason, index) => {
        rows[index + 2] = {
          nutrient: rows[index + 2].nutrient,
          state: "unknown",
          amountPer100Grams: null,
          reason,
        };
      });
      const food = {
        ...sourceFood,
        status,
        currentVersion: {
          ...sourceFood.currentVersion,
          nutrients: rows,
          name: `Source food ${"n".repeat(190)}`,
          brandName: status === "active" ? "Exact brand" : null,
          notes: status === "active" ? "Saved notes\nSecond line" : null,
          serving: status === "active" ? sourceFood.currentVersion.serving : null,
        },
      };
      const original = JSON.stringify(food);
      const { harness, requests } = setup((request) =>
        request.method === "GET" && request.url.pathname === "/v1/custom-foods"
          ? response({ data: [food], page: { nextCursor: null } })
          : undefined,
      );
      try {
        let tree = await copyCustom(harness, food);
        expect(customCopyChoices(tree)).toHaveLength(0);
        expect(input(tree, "Name").props.value).toBe(food.currentVersion.name);
        expect(input(tree, "Brand (optional)").props.value).toBe(
          food.currentVersion.brandName ?? "",
        );
        expect(input(tree, "Notes").props.value).toBe(food.currentVersion.notes ?? "");
        expect(input(tree, "Serving grams").props.value).toBe(
          food.currentVersion.serving?.grams ?? "",
        );
        expect(canonical(tree).split("\n")).toHaveLength(256);
        expect(canonical(tree)).toContain(`1255=${exact}`);
        expect(canonical(tree)).toContain("208=0\n1001=trace\n1002=unknown:not_reported");
        expect(requests).toHaveLength(6);
        tree = await click(harness, "Create private food");
        const sent = writes(requests);
        expect(sent).toHaveLength(1);
        expect(sent[0].url.pathname).toBe("/v1/custom-foods");
        expect(sent[0].headers["if-match"]).toBeUndefined();
        const body = JSON.parse(sent[0].body);
        expect(body).toEqual({
          name: food.currentVersion.name,
          brandName: food.currentVersion.brandName,
          notes: food.currentVersion.notes,
          serving: food.currentVersion.serving
            ? { label: food.currentVersion.serving.label, grams: food.currentVersion.serving.grams }
            : null,
          nutrients: rows.map(({ nutrient, ...row }) => ({ nutrientId: nutrient.id, ...row })),
        });
        expect(JSON.stringify(food)).toBe(original);
        expect(savedFoodCards(tree)).toHaveLength(2);
        expect(input(tree, "Name").props.value).toBe("");
        expect(text(tree)).not.toContain("Copied saved");
      } finally {
        harness.unmount();
      }
    });

  it("copies an unchanged saved revision directly but treats an unchanged copied draft as unsaved", async () => {
    const { harness, requests } = setup();
    try {
      await click(harness, "Revise");
      let tree = await copyCustom(harness);
      expect(customCopyChoices(tree)).toHaveLength(0);
      expect(button(tree, "Create private food").props.disabled).toBe(false);
      tree = await copyCustom(harness);
      expect(customCopyChoices(tree)).toHaveLength(1);
      expect(text(tree)).toContain("any nutrient inputs not yet added to it");
      const before = rawCustomFields(tree);
      tree = await click(harness, "Keep editing");
      expect(rawCustomFields(tree)).toEqual(before);
      expect(customCopyChoices(tree)).toHaveLength(0);
      expect(requests).toHaveLength(6);
    } finally {
      harness.unmount();
    }
  });

  for (const field of ["Name", "Canonical nutrients per 100 g"])
    it(`requires an explicit discard for raw ${field} whitespace that request normalization would hide`, async () => {
      const { harness, requests } = setup();
      try {
        let tree = await click(harness, "Revise");
        const value = input(tree, field).props.value;
        await type(harness, field, `${value} `);
        tree = await copyCustom(harness);
        expect(customCopyChoices(tree)).toHaveLength(1);
        const before = editorSnapshot(tree);
        tree = await click(harness, "Keep editing");
        expect(editorSnapshot(tree)).toEqual(before);
        await copyCustom(harness);
        tree = await click(harness, discardCustomCopy);
        expect(input(tree, field).props.value).toBe(value);
        expect(requests).toHaveLength(6);
      } finally {
        harness.unmount();
      }
    });

  for (const scratch of ["query", "choice", "amount", "trace", "reason"])
    it(`includes unappended composer ${scratch} in the discard choice and preserves it on Keep editing`, async () => {
      const { harness } = setup();
      try {
        await harness.settle();
        if (scratch === "query") await type(harness, "Find an available nutrient by name", "sod");
        if (scratch === "choice") await click(harness, "Sodium (mg)");
        if (scratch === "amount") await type(harness, "Exact amount per 100 g", "0.00100");
        if (scratch === "trace") await click(harness, "Trace");
        if (scratch === "reason") {
          await click(harness, "Unknown");
          await click(harness, "Withheld");
        }
        let tree = await copyCustom(harness);
        const before = editorSnapshot(tree);
        expect(customCopyChoices(tree)).toHaveLength(1);
        tree = await click(harness, "Keep editing");
        expect(editorSnapshot(tree)).toEqual(before);
        await copyCustom(harness);
        tree = await click(harness, discardCustomCopy);
        expect(input(tree, "Find an available nutrient by name").props.value).toBe("");
        expect(input(tree, "Exact amount per 100 g").props.value).toBe("");
        expect(button(tree, "Quantified").props.accessibilityState.selected).toBe(true);
        expect(canonical(tree)).toBe("208=125.5000");
      } finally {
        harness.unmount();
      }
    });

  it("keeps filter/disclosures/pinned log and loaded trends independent, including a filtered-out confirmation source", async () => {
    const { harness, requests, props } = setupTrends();
    props.quickAddOutboxController.enqueueOperation.mockResolvedValue({ operationId: "copy-log" });
    try {
      await setTrendDates(harness);
      await click(harness, "Load local-day trends");
      await fillManual(harness, "4.00100");
      await toggleSaved(harness);
      await click(harness, "Log exact version");
      await type(harness, "Quantity", "1.000001");
      input(logEditor(await harness.settle()), "Local date").props.onChangeText("2026-09-08");
      input(logEditor(await harness.settle()), "Local time").props.onChangeText("12:34");
      let tree = await copyCustom(harness);
      const confirm = button(tree, discardCustomCopy).props.onPress;
      const log = button(tree, "Secure & log pinned version").props.onPress;
      const beforeLog = text(logEditor(tree));
      const beforeTrends = trendHeaders(tree);
      const beforeCount = requests.length;
      await type(harness, savedFoodFilterLabel, "hidden source");
      tree = await harness.settle();
      expect(savedFoodCards(tree)).toHaveLength(0);
      expect(customCopyChoices(tree)).toHaveLength(1);
      expect(text(tree)).toMatch(/then copy saved Saved private food\s*, version 1\s*\./u);
      confirm();
      tree = await harness.settle();
      expect(input(tree, savedFoodFilterLabel).props.value).toBe("hidden source");
      expect(text(logEditor(tree))).toBe(beforeLog);
      expect(trendHeaders(tree)).toEqual(beforeTrends);
      expect(requests).toHaveLength(beforeCount);
      tree = await click(harness, clearSavedFoodFilterLabel);
      expect(savedDetails(tree)).toHaveLength(1);
      log();
      await harness.settle();
      expect(props.quickAddOutboxController.enqueueOperation).toHaveBeenCalledExactlyOnceWith({
        operationKind: "custom_food",
        customFoodName: sourceFood.currentVersion.name,
        customFoodId: foodId,
        customFoodVersionId: "123",
        customFoodVersionNumber: 1,
        portion: { kind: "serving", servingId: "456", amount: "1.000001", servingLabel: "scoop" },
        mealSlot: "breakfast",
        localDate: "2026-09-08",
        occurredAt: "2026-09-08T17:34:00.000Z",
      });
    } finally {
      harness.unmount();
    }
  });

  it("does not let an old choice keep or confirm a newer source, and fences prior draft/composer/save callbacks after Copy", async () => {
    const { harness, requests } = setup((request) =>
      request.method === "GET" && request.url.pathname === "/v1/custom-foods"
        ? response({ data: [sourceFood, archivedFood], page: { nextCursor: null } })
        : undefined,
    );
    try {
      await fillManual(harness, "1.00");
      await click(harness, "Protein (g)");
      await type(harness, "Protein amount (g per 100 g)", "2.000");
      let tree = await copyCustom(harness);
      const oldKeep = button(tree, "Keep editing").props.onPress;
      const oldConfirm = button(tree, discardCustomCopy).props.onPress;
      const oldField = input(tree, "Name").props.onChangeText;
      const oldComposer = input(tree, "Protein amount (g per 100 g)").props.onChangeText;
      const oldAdd = button(tree, "Add nutrient row to draft").props.onPress;
      const oldSave = button(tree, "Create private food").props.onPress;
      tree = await copyCustom(harness, archivedFood);
      oldKeep();
      oldConfirm();
      tree = await harness.settle();
      expect(customCopyChoices(tree)).toHaveLength(1);
      expect(text(tree)).toMatch(/then copy saved Archived private food\s*, version 1\s*\./u);
      await click(harness, discardCustomCopy);
      oldField("obsolete");
      oldComposer("99");
      oldAdd();
      oldSave();
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe(archivedFood.currentVersion.name);
      expect(canonical(tree)).toBe("208=125.5000");
      expect(input(tree, "Exact amount per 100 g").props.value).toBe("");
      expect(writes(requests)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });

  for (const action of ["edit/restore", "composer", "Revise", "Cancel edit", "save", "refresh"])
    it(`invalidates a pending copy choice after ${action}`, async () => {
      const { harness, requests } = setup((request) =>
        request.method === "POST" ? response({}, 503) : undefined,
      );
      try {
        await click(harness, "Revise");
        await type(harness, "Notes", "Changed draft");
        let tree = await copyCustom(harness);
        const confirm = button(tree, discardCustomCopy).props.onPress;
        const keep = button(tree, "Keep editing").props.onPress;
        if (action === "edit/restore") {
          await type(harness, "Notes", "Later");
          await type(harness, "Notes", "Changed draft");
        } else if (action === "composer") await type(harness, "Exact amount per 100 g", "0.01");
        else if (action === "save") await click(harness, "Save new version");
        else if (action === "refresh") await click(harness, "Refresh private data");
        else await click(harness, action);
        tree = await harness.settle();
        const before = rawCustomFields(tree);
        const count = requests.length;
        confirm();
        keep();
        tree = await harness.settle();
        expect(rawCustomFields(tree)).toEqual(before);
        expect(customCopyChoices(tree)).toHaveLength(0);
        expect(requests).toHaveLength(count);
      } finally {
        harness.unmount();
      }
    });

  it("leaves same-value draft/composer changes harmless and keeps the current copy confirmation usable", async () => {
    const { harness } = setup();
    try {
      await fillManual(harness);
      let tree = await copyCustom(harness);
      const confirm = button(tree, discardCustomCopy).props.onPress;
      input(tree, "Name").props.onChangeText("Owner food");
      input(tree, "Exact amount per 100 g").props.onChangeText("");
      confirm();
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe(sourceFood.currentVersion.name);
      expect(customCopyChoices(tree)).toHaveLength(0);
    } finally {
      harness.unmount();
    }
  });

  it("gives accepted copies distinct creation intent and preserves exact A-to-B-to-A and lifecycle retries inside each intent", async () => {
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? response({ data: { malformed: true } }) : undefined,
    );
    try {
      await type(harness, "Name", sourceFood.currentVersion.name);
      await type(harness, "Brand (optional)", sourceFood.currentVersion.brandName);
      await type(harness, "Notes", sourceFood.currentVersion.notes);
      await type(harness, "Serving label (optional)", sourceFood.currentVersion.serving.label);
      await type(harness, "Serving grams", sourceFood.currentVersion.serving.grams);
      await type(harness, "Canonical nutrients per 100 g", "208=125.5000");
      await click(harness, "Create private food");
      await copyCustom(harness);
      await click(harness, "Keep editing");
      await click(harness, "Create private food");
      await copyCustom(harness);
      await click(harness, discardCustomCopy);
      await click(harness, "Create private food");
      await type(harness, "Name", "Body B");
      await click(harness, "Create private food");
      await type(harness, "Name", sourceFood.currentVersion.name);
      await click(harness, "Create private food");
      await type(harness, savedFoodFilterLabel, "Saved");
      state("background");
      await harness.settle();
      state("active");
      await harness.settle();
      await click(harness, "Refresh private data");
      await click(harness, "Create private food");
      await copyCustom(harness);
      await click(harness, discardCustomCopy);
      await click(harness, "Create private food");
      const sent = writes(requests);
      expect(sent).toHaveLength(7);
      expect(sent[1].headers["idempotency-key"]).toBe(sent[0].headers["idempotency-key"]);
      expect(sent[2].body).toBe(sent[0].body);
      expect(sent[2].headers["idempotency-key"]).not.toBe(sent[0].headers["idempotency-key"]);
      expect(sent[3].headers["idempotency-key"]).not.toBe(sent[2].headers["idempotency-key"]);
      for (const index of [4, 5]) {
        expect(sent[index].body).toBe(sent[2].body);
        expect(sent[index].headers["idempotency-key"]).toBe(sent[2].headers["idempotency-key"]);
      }
      expect(sent[6].body).toBe(sent[2].body);
      expect(sent[6].headers["idempotency-key"]).not.toBe(sent[2].headers["idempotency-key"]);
    } finally {
      harness.unmount();
    }
  });

  it("blocks Copy and duplicate custom saves through the own write even after shared busy is cleared", async () => {
    const held = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST"
        ? request.url.pathname === "/v1/custom-foods"
          ? held.promise
          : response({}, 503)
        : undefined,
    );
    try {
      let tree = await copyCustom(harness);
      const oldCopy = customCopyButton(tree).props.onPress;
      const oldSave = button(tree, "Create private food").props.onPress;
      await click(harness, "Create private food");
      await click(harness, "Create definition");
      tree = await harness.settle();
      expect(customCopyButton(tree).props.disabled).toBe(true);
      expect(button(tree, "Create private food").props.disabled).toBe(true);
      oldCopy();
      oldSave();
      expect(
        writes(requests).filter((request) => request.url.pathname === "/v1/custom-foods"),
      ).toHaveLength(1);
      held.resolve(receipt(writes(requests)[0]));
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
      expect(text(tree)).toContain("Saved owner-entered private food version 1.");
    } finally {
      harness.unmount();
    }
  });

  it("preserves an accepted copied-food save when an independent full list refresh finishes first", async () => {
    const held = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    try {
      await copyCustom(harness);
      await click(harness, "Create private food");
      await click(harness, "Refresh private data");
      held.resolve(receipt(writes(requests)[0]));
      const tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
      expect(text(tree)).toContain("Saved owner-entered private food version 1.");
      expect(savedFoodCards(tree)).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  for (const outcome of ["success", "failure"])
    it(`retains a copied-food acceptance that precedes an older pending full-list ${outcome}`, async () => {
      const read = deferred();
      const write = deferred();
      let refresh = false;
      const { harness, requests } = setup((request) => {
        if (request.method === "POST") return write.promise;
        if (refresh && request.url.pathname === "/v1/custom-foods") return read.promise;
        return undefined;
      });
      try {
        await copyCustom(harness);
        await click(harness, "Create private food");
        refresh = true;
        await click(harness, "Refresh private data");
        write.resolve(receipt(writes(requests)[0]));
        let tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("");
        expect(savedFoodCards(tree)).toHaveLength(2);
        read.resolve(
          outcome === "success"
            ? response({ data: [sourceFood], page: { nextCursor: null } })
            : response({}, 503),
        );
        tree = await harness.settle();
        expect(savedFoodCards(tree)).toHaveLength(2);
        expect(input(tree, "Name").props.value).toBe("");
        expect(writes(requests)).toHaveLength(1);
        expect(text(tree)).toContain(
          outcome === "success"
            ? "No more records remain in this listing."
            : "The saved custom-food list has not been verified.",
        );
      } finally {
        harness.unmount();
      }
    });

  for (const listedRevision of ["1", "3"])
    it(`keeps the newest saved revision when accepted revision2 precedes pending list revision${listedRevision}`, async () => {
      const read = deferred();
      const write = deferred();
      let refresh = false;
      const accepted = {
        ...sourceFood,
        revision: "2",
        currentVersion: {
          ...sourceFood.currentVersion,
          id: "998",
          versionNumber: 2,
          name: "Accepted revision",
        },
      };
      const listed =
        listedRevision === "1"
          ? sourceFood
          : {
              ...accepted,
              revision: "3",
              currentVersion: {
                ...accepted.currentVersion,
                id: "999",
                versionNumber: 3,
                name: "Newer listed revision",
              },
            };
      const { harness } = setup((request) => {
        if (request.method === "POST") return write.promise;
        if (refresh && request.url.pathname === "/v1/custom-foods") return read.promise;
        return undefined;
      });
      try {
        await click(harness, "Revise");
        await type(harness, "Name", accepted.currentVersion.name);
        await click(harness, "Save new version");
        refresh = true;
        await click(harness, "Refresh private data");
        write.resolve(response({ data: { replayed: false, customFood: accepted } }));
        let tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("");
        read.resolve(response({ data: [listed], page: { nextCursor: null } }));
        tree = await harness.settle();
        const expected = listedRevision === "1" ? accepted : listed;
        expect(savedFoodCards(tree).map((node) => node.props.accessibilityLabel)).toEqual([
          `Show nutrients for ${expected.currentVersion.name}, version ${expected.currentVersion.versionNumber}`,
        ]);
        expect(input(tree, "Name").props.value).toBe("");
      } finally {
        harness.unmount();
      }
    });

  it("keeps a newer full-list revision when an older valid receipt arrives later and still cleans the accepted draft", async () => {
    const write = deferred();
    let refresh = false;
    const accepted = {
      ...sourceFood,
      revision: "2",
      currentVersion: {
        ...sourceFood.currentVersion,
        id: "998",
        versionNumber: 2,
        name: "Accepted revision",
      },
    };
    const newer = {
      ...accepted,
      revision: "3",
      currentVersion: {
        ...accepted.currentVersion,
        id: "999",
        versionNumber: 3,
        name: "Newer listed revision",
      },
    };
    const { harness, requests } = setup((request) => {
      if (request.method === "POST") return write.promise;
      if (refresh && request.url.pathname === "/v1/custom-foods")
        return response({ data: [newer], page: { nextCursor: null } });
      return undefined;
    });
    try {
      await click(harness, "Revise");
      await type(harness, "Name", accepted.currentVersion.name);
      await click(harness, "Save new version");
      refresh = true;
      await click(harness, "Refresh private data");
      write.resolve(response({ data: { replayed: false, customFood: accepted } }));
      const tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("");
      expect(text(tree)).toContain("Saved owner-entered private food version 2.");
      expect(savedFoodCards(tree).map((node) => node.props.accessibilityLabel)).toEqual([
        "Show nutrients for Newer listed revision, version 3",
      ]);
      expect(writes(requests)).toHaveLength(1);
    } finally {
      harness.unmount();
    }
  });

  it("rejects a late earlier JSON receipt after background and a later accepted Copy without clearing its new draft", async () => {
    const held = deferred();
    let slow = true;
    const { harness, requests } = setup((request) =>
      slow && request.method === "POST"
        ? { status: 200, ok: true, json: () => held.promise }
        : undefined,
    );
    try {
      await fillManual(harness, "2.00");
      await click(harness, "Create private food");
      state("background");
      await harness.settle();
      state("active");
      await harness.settle();
      await copyCustom(harness);
      let tree = await click(harness, discardCustomCopy);
      const before = rawCustomFields(tree);
      slow = false;
      held.resolve(await receipt(writes(requests)[0]).json());
      tree = await harness.settle();
      expect(rawCustomFields(tree)).toEqual(before);
      expect(text(tree)).toContain("Copied saved Saved private food, version 1");
      expect(text(tree)).not.toContain("Saved owner-entered private food version");
    } finally {
      harness.unmount();
    }
  });

  for (const boundary of ["owner", "session", "token", "API", "zone", "groups"])
    it(`rejects Copy and confirmation before ${boundary} replacement effects`, async () => {
      const { harness } = setup();
      try {
        await fillManual(harness);
        let tree = await copyCustom(harness);
        const copy = customCopyButton(tree).props.onPress;
        const confirm = button(tree, discardCustomCopy).props.onPress;
        const keep = button(tree, "Keep editing").props.onPress;
        harness.updateProps(
          boundary === "owner"
            ? { ownerUserId: otherOwner }
            : boundary === "session"
              ? { sessionEpoch: 2 }
              : boundary === "token"
                ? { accessToken: "replacement" }
                : boundary === "API"
                  ? { apiBase: new URL("http://127.0.0.1:4001") }
                  : boundary === "zone"
                    ? { profileTimeZone: "UTC" }
                    : {
                        diaryGroups: [{ mealSlot: "breakfast", label: "New label", sortOrder: 0 }],
                      },
        );
        tree = harness.renderWithoutEffects();
        expect(customCopyChoices(tree)).toHaveLength(0);
        copy();
        confirm();
        keep();
        harness.flushEffects();
        await harness.settle();
        tree = await type(harness, "Name", "Replacement draft");
        copy();
        confirm();
        keep();
        tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("Replacement draft");
        expect(customCopyChoices(tree)).toHaveLength(0);
      } finally {
        harness.unmount();
      }
    });

  for (const boundary of ["background", "inactive", "unknown", null, "replay"])
    it(`invalidates the choice and retained Copy across ${boundary}`, async () => {
      const { harness } = setup();
      try {
        await fillManual(harness);
        let tree = await copyCustom(harness);
        const copy = customCopyButton(tree).props.onPress;
        const confirm = button(tree, discardCustomCopy).props.onPress;
        if (boundary === "replay") harness.replayEffects();
        else state(boundary);
        await harness.settle();
        copy();
        confirm();
        if (boundary !== "replay") state("active");
        await harness.settle();
        copy();
        confirm();
        tree = await harness.settle();
        expect(input(tree, "Name").props.value).toBe("Owner food");
        expect(customCopyChoices(tree)).toHaveLength(0);
      } finally {
        harness.unmount();
      }
    });

  it("cannot confirm or copy a replaced saved object after a full refresh", async () => {
    let replacement = false;
    const newer = {
      ...sourceFood,
      revision: "2",
      currentVersion: {
        ...sourceFood.currentVersion,
        id: "999",
        versionNumber: 2,
        name: "Replacement saved source",
      },
    };
    const { harness } = setup((request) =>
      replacement && request.url.pathname === "/v1/custom-foods"
        ? response({ data: [newer], page: { nextCursor: null } })
        : undefined,
    );
    try {
      await fillManual(harness);
      let tree = await copyCustom(harness);
      const copy = customCopyButton(tree).props.onPress;
      const confirm = button(tree, discardCustomCopy).props.onPress;
      replacement = true;
      await click(harness, "Refresh private data");
      copy();
      confirm();
      tree = await harness.settle();
      expect(input(tree, "Name").props.value).toBe("Owner food");
      expect(customCopyChoices(tree)).toHaveLength(0);
      await copyCustom(harness, newer);
      tree = await click(harness, discardCustomCopy);
      expect(input(tree, "Name").props.value).toBe(newer.currentVersion.name);
    } finally {
      harness.unmount();
    }
  });

  it("closes private Copy state after401 and rejects retained copy/choice controls after unmount", async () => {
    let closed = false;
    const { harness, requests, props } = setup((request) =>
      closed && request.url.pathname === "/v1/custom-foods" ? response({}, 401) : undefined,
    );
    await fillManual(harness);
    let tree = await copyCustom(harness);
    const copy = customCopyButton(tree).props.onPress;
    const confirm = button(tree, discardCustomCopy).props.onPress;
    closed = true;
    await click(harness, "Refresh private data");
    copy();
    confirm();
    tree = await harness.settle();
    expect(customCopyChoices(tree)).toHaveLength(0);
    expect(text(tree)).not.toContain("Copied saved");
    expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
    const count = requests.length;
    harness.unmount();
    copy();
    confirm();
    expect(requests).toHaveLength(count);
    expect(harness.writesAfterUnmount).toBe(0);
  });
});

const readingEvent = {
  id: "2bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "9",
  definitionId: trendDefinition.id,
  measuredAt: "2026-09-09T12:00:05.123Z",
  localDate: "2026-09-09",
  timeZone: "America/Chicago",
  value: "70.00000100",
  source: { kind: "manual", deviceId: null, externalId: null, externalRevision: null },
  createdAt: timestamp,
  updatedAt: timestamp,
};
function setupReadings(handler = () => undefined, { metrics, entries = [readingEvent] } = {}) {
  return setupTrends(
    (request, requests) => {
      const result = handler(request, requests);
      if (result !== undefined) return result;
      if (request.url.pathname === "/v1/biometrics/events" && request.method === "GET")
        return response({ data: entries, page: { nextCursor: null } });
      return undefined;
    },
    { metrics },
  );
}
function biometricSection(tree) {
  const found = nodes(
    tree,
    (node) =>
      node.type === "View" &&
      React.Children.toArray(node.props.children).some(
        (child) => child.type === "Text" && text(child) === "Biometrics",
      ),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
function biometricCard(tree, id) {
  const found = nodes(biometricSection(tree), (node) => node.type === "View" && node.key === id);
  expect(found).toHaveLength(1);
  return found[0];
}
async function pressBiometric(harness, label, cardId) {
  const tree = await harness.settle();
  const scope = cardId ? biometricCard(tree, cardId) : biometricSection(tree);
  const target = button(scope, label);
  expect(target.props.disabled).not.toBe(true);
  target.props.onPress();
  return harness.settle();
}
const readingValueLabel = (definition = trendDefinition) =>
  `${definition.name} exact value (${definition.canonicalUnit})`;

// Bounded presentation/selection evidence; transport, persistence and native host rendering
// remain the existing implementation and are not replaced by these synthetic hooks.
describe("native biometric reading units and immutable edit identity", () => {
  it("distinguishes same-name metrics by exact ID/unit without changing value/date/time or requesting data", async () => {
    const kg = { ...trendDefinition, name: "Weight" };
    const lb = { ...otherTrendDefinition, name: "Weight", canonicalUnit: "lb" };
    const { harness, requests } = setupReadings(undefined, { metrics: [kg, lb] });
    let tree = await harness.settle();
    expect(text(biometricSection(tree))).toContain("Metric: Weight (kg).");
    await type(harness, readingValueLabel(kg), "-12.3400");
    await type(harness, "Local date", "2026-09-08");
    await type(harness, "Local time", "09:41");
    tree = await pressBiometric(harness, "Weight (lb)");
    expect(input(tree, readingValueLabel(lb)).props.value).toBe("-12.3400");
    expect(button(biometricSection(tree), "Weight (lb)").props.accessibilityState.selected).toBe(
      true,
    );
    expect(text(biometricCard(tree, readingEvent.id))).toContain("70.00000100 kg");
    tree = await pressBiometric(harness, "Weight (kg)");
    expect(input(tree, readingValueLabel(kg)).props.value).toBe("-12.3400");
    expect(input(tree, "Local date").props.value).toBe("2026-09-08");
    expect(input(tree, "Local time").props.value).toBe("09:41");
    expect(requests).toHaveLength(6);
    expect(writes(requests)).toHaveLength(0);
  });

  for (const value of ["0", "-12.3400", `-0.${"1234567890".repeat(15)}1234567`])
    it(`renders the exact signed reading string of length ${value.length} with its unit`, async () => {
      const { harness } = setupReadings(undefined, { entries: [{ ...readingEvent, value }] });
      const tree = await harness.settle();
      expect(value.length).toBeLessThanOrEqual(160);
      expect(rawText(biometricCard(tree, readingEvent.id))).toContain(value);
      expect(text(biometricCard(tree, readingEvent.id))).toContain(`${value} kg`);
      expect(text(biometricCard(tree, readingEvent.id))).toContain("2026-09-09");
      expect(text(biometricCard(tree, readingEvent.id))).toContain("07:00");
    });

  it("uses retained archived metadata, preserves imported rows, and does not borrow a selected unit for missing metadata", async () => {
    const archived = { ...trendDefinition, status: "archived" };
    const missing = {
      ...readingEvent,
      id: "3bcfa2bf-4950-43f7-9f24-b983ac803013",
      definitionId: "9bcfa2bf-4950-43f7-9f24-b983ac803012",
      value: "-5.000",
    };
    const imported = {
      ...readingEvent,
      id: "4bcfa2bf-4950-43f7-9f24-b983ac803013",
      source: {
        kind: "apple_healthkit",
        deviceId: "5bcfa2bf-4950-43f7-9f24-b983ac803013",
        externalId: "synthetic-reading",
        externalRevision: "1",
      },
    };
    const { harness, requests } = setupReadings(undefined, {
      metrics: [archived, otherTrendDefinition],
      entries: [readingEvent, missing, imported],
    });
    let tree = await pressBiometric(harness, `${otherTrendDefinition.name} (kg)`);
    expect(text(biometricCard(tree, readingEvent.id))).toContain("70.00000100 kg");
    expect(text(biometricCard(tree, missing.id))).toContain("Metric unavailable");
    expect(text(biometricCard(tree, missing.id))).toContain("-5.000");
    expect(text(biometricCard(tree, missing.id))).toContain("unit unavailable");
    expect(text(biometricCard(tree, missing.id))).not.toContain("kg");
    expect(text(biometricCard(tree, imported.id))).toContain("70.00000100 kg");
    expect(text(biometricCard(tree, imported.id))).toContain("apple_healthkit");
    expect(
      nodes(biometricCard(tree, imported.id), (node) => node.type === "Pressable"),
    ).toHaveLength(0);
    tree = await pressBiometric(harness, "Edit", readingEvent.id);
    const chip = button(biometricSection(tree), `${archived.name} (kg)`);
    expect(chip.props.disabled).toBe(true);
    expect(chip.props.accessibilityState.selected).toBe(true);
    expect(input(tree, readingValueLabel(archived)).props.value).toBe(readingEvent.value);
    expect(requests).toHaveLength(6);
  });

  it("uses refreshed current names and complete long labels while preserving units and exact reading values", async () => {
    let metric = trendDefinition;
    const { harness, requests } = setupReadings((request) =>
      request.url.pathname === "/v1/biometrics/definitions"
        ? response({ data: [metric] })
        : undefined,
    );
    await harness.settle();
    metric = { ...trendDefinition, revision: "2", name: "Renamed metric" };
    let tree = await click(harness, "Refresh private data");
    expect(text(biometricCard(tree, readingEvent.id))).toContain("Renamed metric");
    expect(text(biometricCard(tree, readingEvent.id))).toContain(`${readingEvent.value} kg`);
    const long = { ...otherTrendDefinition, name: "M".repeat(120), canonicalUnit: "U".repeat(32) };
    metric = long;
    tree = await click(harness, "Refresh private data");
    const choice = button(biometricSection(tree), `${long.name} (${long.canonicalUnit})`);
    expect(choice.props.style).toContainEqual(expect.objectContaining({ maxWidth: "100%" }));
    choice.props.onPress();
    tree = await harness.settle();
    expect(input(tree, readingValueLabel(long)).props.maxLength).toBe(160);
    expect(text(biometricSection(tree))).toContain(`Metric: ${long.name} (${long.canonicalUnit}).`);
    expect(requests).toHaveLength(18);
  });

  it("rejects retained pre-Edit selection and Use retargeting, while current Use still chooses its trend", async () => {
    const { harness, requests } = setupReadings();
    let tree = await harness.settle();
    const oldChoice = button(biometricSection(tree), `${otherTrendDefinition.name} (kg)`).props
      .onPress;
    const oldUse = button(biometricCard(tree, otherTrendDefinition.id), "Use").props.onPress;
    button(biometricCard(tree, readingEvent.id), "Edit").props.onPress();
    oldChoice();
    oldUse();
    tree = await harness.settle();
    expect(input(tree, readingValueLabel()).props.value).toBe(readingEvent.value);
    expect(text(biometricSection(tree))).toContain("Editing preserves this reading’s metric.");
    const otherChoice = button(biometricSection(tree), `${otherTrendDefinition.name} (kg)`);
    expect(otherChoice.props.disabled).toBe(true);
    expect(otherChoice.props.accessibilityState.disabled).toBe(true);
    otherChoice.props.onPress();
    tree = await pressBiometric(harness, "Use", otherTrendDefinition.id);
    expect(input(tree, readingValueLabel()).props.value).toBe(readingEvent.value);
    expect(
      button(trendSection(tree), otherTrendDefinition.name).props.accessibilityState.selected,
    ).toBe(true);
    tree = await pressBiometric(harness, "Cancel");
    expect(button(biometricSection(tree), `${otherTrendDefinition.name} (kg)`).props.disabled).toBe(
      false,
    );
    tree = await pressBiometric(harness, `${otherTrendDefinition.name} (kg)`);
    expect(input(tree, readingValueLabel(otherTrendDefinition)).props.value).toBe("");
    expect(requests).toHaveLength(6);
  });

  it("keeps same-value selection usable and ignores an old choice after another draft field changes", async () => {
    const { harness, requests } = setupReadings();
    let tree = await pressBiometric(harness, `${trendDefinition.name} (kg)`);
    const choice = button(biometricSection(tree), `${trendDefinition.name} (kg)`).props.onPress;
    const staleOther = button(biometricSection(tree), `${otherTrendDefinition.name} (kg)`).props
      .onPress;
    choice();
    choice();
    tree = await type(harness, readingValueLabel(), "1.2500");
    staleOther();
    tree = await harness.settle();
    expect(input(tree, readingValueLabel()).props.value).toBe("1.2500");
    expect(requests).toHaveLength(6);
  });

  it("creates an explicit reading with unchanged exact body and key on ambiguous retry", async () => {
    let attempts = 0;
    const { harness, requests } = setupReadings((request) => {
      if (request.method !== "POST" || request.url.pathname !== "/v1/biometrics/events")
        return undefined;
      attempts += 1;
      if (attempts === 1) throw new Error("Synthetic missing create confirmation");
      const body = JSON.parse(request.body);
      return response({ data: { replayed: true, event: { ...readingEvent, ...body } } });
    });
    await pressBiometric(harness, `${otherTrendDefinition.name} (kg)`);
    await type(harness, readingValueLabel(otherTrendDefinition), "-0.00000100");
    await type(harness, "Local date", "2026-09-09");
    await type(harness, "Local time", "07:04");
    let tree = await pressBiometric(harness, "Log reading");
    expect(writes(requests)).toHaveLength(1);
    const first = writes(requests)[0];
    expect(JSON.parse(first.body)).toEqual({
      definitionId: otherTrendDefinition.id,
      measuredAt: "2026-09-09T12:04:00.000Z",
      value: "-0.00000100",
    });
    expect(first.headers["if-match"]).toBeUndefined();
    expect(input(tree, readingValueLabel(otherTrendDefinition)).props.value).toBe("-0.00000100");
    await pressBiometric(harness, `${otherTrendDefinition.name} (kg)`);
    tree = await pressBiometric(harness, "Log reading");
    const second = writes(requests)[1];
    expect(second.body).toBe(first.body);
    expect(second.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(input(tree, readingValueLabel(otherTrendDefinition)).props.value).toBe("");
    expect(text(biometricCard(tree, readingEvent.id))).toContain("-0.00000100 kg");
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(6);
  });

  for (const metadata of ["loaded", "missing"])
    it(`edits ${metadata} metric metadata without retargeting, rounding or rewriting the original timestamp and retry identity`, async () => {
      let attempts = 0;
      const { harness, requests } = setupReadings(
        (request) => {
          if (
            request.method !== "PATCH" ||
            !request.url.pathname.startsWith("/v1/biometrics/events/")
          )
            return undefined;
          attempts += 1;
          if (attempts === 1) throw new Error("Synthetic missing edit confirmation");
          return response({
            data: {
              replayed: true,
              event: { ...readingEvent, ...JSON.parse(request.body), revision: "10" },
            },
          });
        },
        { metrics: metadata === "missing" ? [otherTrendDefinition] : undefined },
      );
      let tree = await pressBiometric(harness, "Edit", readingEvent.id);
      const label = metadata === "missing" ? "Exact value (unit unavailable)" : readingValueLabel();
      expect(input(tree, label).props.value).toBe(readingEvent.value);
      if (metadata === "missing")
        expect(text(biometricSection(tree))).toContain("Metric unavailable · unit unavailable.");
      await type(harness, label, "-6.000000100");
      await pressBiometric(harness, "Use", otherTrendDefinition.id);
      tree = await pressBiometric(harness, "Save reading");
      const first = writes(requests)[0];
      expect(first.url.pathname).toBe(`/v1/biometrics/events/${readingEvent.id}`);
      expect(first.headers["if-match"]).toBe(`"${readingEvent.revision}"`);
      expect(JSON.parse(first.body)).toEqual({ value: "-6.000000100" });
      expect(input(tree, label).props.value).toBe("-6.000000100");
      tree = await pressBiometric(harness, "Save reading");
      const second = writes(requests)[1];
      expect(second.body).toBe(first.body);
      expect(second.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
      expect(second.headers["if-match"]).toBe(`"${readingEvent.revision}"`);
      tree = await pressBiometric(harness, "Edit", readingEvent.id);
      expect(input(tree, "Local date").props.value).toBe(readingEvent.localDate);
      expect(input(tree, "Local time").props.value).toBe("07:00");
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(6);
    });

  it("keeps an explicit edited time as the only additional PATCH field", async () => {
    const { harness, requests } = setupReadings((request) =>
      request.method === "PATCH"
        ? response({
            data: {
              replayed: false,
              event: { ...readingEvent, ...JSON.parse(request.body), revision: "10" },
            },
          })
        : undefined,
    );
    await pressBiometric(harness, "Edit", readingEvent.id);
    await type(harness, "Local time", "07:01");
    await pressBiometric(harness, "Save reading");
    expect(JSON.parse(writes(requests)[0].body)).toEqual({
      value: readingEvent.value,
      measuredAt: "2026-09-09T12:01:00.000Z",
    });
  });
});
