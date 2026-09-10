import * as React from "react";
import { AppState } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuickAddEnqueueAmbiguousError } from "../src/diary/quick-add-outbox";
import { RecipesScreen } from "../src/recipes/RecipesScreen";

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
vi.mock("../src/recipes/PastedIngredientReview", () => ({
  PastedIngredientReview: "PastedIngredientReview",
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
          tree = RecipesScreen(props);
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
      tree = RecipesScreen(props);
      return tree;
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
const recipeId = "ce126b7f-dfe5-4ee4-a75c-6b0f50c1963e";
const versionId = "db2ed69e-29d1-4330-a210-0a804f9ff2b3";
const timestamp = "2026-09-09T12:00:00.000Z";
const food = {
  foodId: "101",
  foodVersionId: "202",
  kind: "generic",
  name: "Rolled oats",
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
    label: "scoop",
    quantity: "1",
    unit: "scoop",
    gramWeight: "40.125",
    milliliterVolume: null,
  },
};
function ingredient(key = crypto.randomUUID()) {
  return {
    kind: "food",
    clientKey: key,
    foodVersionId: food.foodVersionId,
    name: food.name,
    brandName: null,
    portion: { kind: "grams", grams: "125.000001" },
    source: food.source,
    foodProvenance: { kind: "public", source: food.source },
    note: null,
  };
}
function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function session(id = owner) {
  return response({
    data: {
      user: { id, email: "owner@example.test", emailVerified: true },
      profile: {
        displayName: "Owner",
        birthDate: null,
        sexAtBirth: "not_specified",
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone: "America/Chicago",
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "4",
      },
    },
  });
}
function recipeWire(name = "Saved recipe") {
  const source = { ...food.source, releaseId: "eb8a4152-001f-4722-8bf1-8728ef8c14f8" };
  return {
    id: recipeId,
    status: "active",
    revision: "1",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentVersion: {
      id: versionId,
      versionNumber: 1,
      name,
      description: null,
      instructions: "Simmer.",
      ingredients: [
        {
          kind: "food",
          position: 0,
          foodVersionId: food.foodVersionId,
          name: food.name,
          brandName: null,
          portion: { kind: "grams", grams: "120" },
          resolvedGrams: "120",
          note: null,
          source,
          foodProvenance: { kind: "public", source },
        },
      ],
      finalYield: { grams: "120", source: "measured", ratioToInputMass: "1" },
      inputMassGrams: "120",
      servingCount: null,
      servingLabel: null,
      nutrition: { totals: [], per100Grams: [], perServing: null },
      sources: [source],
      retentionPolicy: {
        code: "identity-retention-default",
        version: "1",
        assumption: "No named retention factor set is applied.",
      },
      calculationVersion: "recipe-calculation-v1",
      warnings: [],
      createdAt: timestamp,
    },
  };
}
function collection(includeRecipe = false) {
  const recipe = recipeWire();
  return response({
    data: includeRecipe
      ? [
          {
            ...recipe,
            currentVersion: {
              id: versionId,
              versionNumber: 1,
              name: "Saved recipe",
              description: null,
              finalYield: { grams: "120", source: "measured" },
              inputMassGrams: "120",
              servingCount: null,
              servingLabel: null,
              warnings: [],
              createdAt: timestamp,
            },
          },
        ]
      : [],
    page: { nextCursor: null },
  });
}
const detail = (name) => response({ data: { recipe: recipeWire(name) } });
const mutation = (name) => response({ data: { replayed: false, recipe: recipeWire(name) } });
const searchResponse = () => response({ data: [food], page: { nextCursor: null } });
function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function review(tree) {
  const matches = nodes(tree, (node) => node.type === "PastedIngredientReview");
  expect(matches).toHaveLength(1);
  return matches[0];
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
      if (request.url.pathname === "/v1/auth/me") return session(overrides.ownerUserId ?? owner);
      if (request.url.pathname === "/v1/foods/search") return searchResponse();
      if (request.method === "POST") return mutation();
      if (request.url.pathname === `/v1/recipes/${recipeId}`) return detail();
      if (request.url.pathname === "/v1/recipes") return collection();
      throw new Error(`Unexpected fixture path ${request.url.pathname}`);
    }),
  );
  const queue = { status: "ready", pendingCount: 0 };
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-session",
    ownerUserId: owner,
    profileTimeZone: "America/Chicago",
    diaryGroups: [],
    onUnauthorized: vi.fn(async () => {}),
    onLogged: vi.fn(),
    onGoals: vi.fn(),
    quickAddOutboxController: {
      getState: () => queue,
      enqueueOperation: vi.fn(),
      requestDrain: vi.fn(),
    },
    quickAddOutboxState: queue,
    subscribeQuickAddReceipts: vi.fn(() => () => {}),
    ...overrides,
  };
  return { harness: screenHarness(props), requests, props };
}
async function fill(harness, name = "Reviewed porridge") {
  let tree = await harness.settle();
  input(tree, "Recipe name").props.onChangeText(name);
  input(tree, "Final yield grams").props.onChangeText("300.000001");
  input(tree, "Instructions").props.onChangeText("Keep instructions.");
  expect(review(tree).props.onConfirm([ingredient()])).toBe(true);
  tree = await harness.settle();
  return tree;
}
async function click(harness, label) {
  const node = pressable(await harness.settle(), label);
  expect(node.props.disabled).not.toBe(true);
  node.props.onPress();
  return harness.settle();
}
const postRequests = (requests) => requests.filter((request) => request.method === "POST");
function background() {
  AppState.currentState = "background";
  for (const listener of hooks.appListeners) listener("background");
}
function foreground() {
  AppState.currentState = "active";
  for (const listener of hooks.appListeners) listener("active");
}

describe("mobile recipe review parent lifecycle", () => {
  it("uses the latest draft synchronously, preserves existing fields and appends once", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    const callback = review(tree).props.onConfirm;
    input(tree, "Recipe name").props.onChangeText("Latest name");
    input(tree, "Final yield grams").props.onChangeText("250.000001");
    input(tree, "Instructions").props.onChangeText("Original instructions");
    const item = ingredient();
    expect(callback([item])).toBe(true);
    expect(callback([item])).toBe(false);
    tree = await harness.settle();
    expect(input(tree, "Recipe name").props.value).toBe("Latest name");
    expect(input(tree, "Final yield grams").props.value).toBe("250.000001");
    expect(input(tree, "Instructions").props.value).toBe("Original instructions");
    expect(review(tree).props.remainingCapacity).toBe(49);
    const second = ingredient();
    expect(review(tree).props.onConfirm([second])).toBe(true);
    expect(review(await harness.settle()).props.remainingCapacity).toBe(48);
  });
  it("checks current combined capacity and rejects duplicate keys, notes, private food and invalid quantities", async () => {
    const { harness } = setup();
    let tree = await harness.settle();
    expect(review(tree).props.onConfirm(Array.from({ length: 49 }, () => ingredient()))).toBe(true);
    tree = await harness.settle();
    const callback = review(tree).props.onConfirm;
    expect(callback([ingredient(), ingredient()])).toBe(false);
    const duplicate = ingredient("same");
    expect(callback([duplicate, duplicate])).toBe(false);
    expect(callback([{ ...ingredient(), note: "raw paste" }])).toBe(false);
    expect(callback([{ ...ingredient(), foodProvenance: { kind: "private_custom" } }])).toBe(false);
    expect(callback([{ ...ingredient(), portion: { kind: "grams", grams: "0" } }])).toBe(false);
    expect(callback([])).toBe(false);
    expect(callback([ingredient()])).toBe(true);
    expect(review(await harness.settle()).props.remainingCapacity).toBe(0);
  });
  it("invalidates the old transfer after New and keeps the new draft", async () => {
    const { harness } = setup();
    const tree = await fill(harness);
    const old = review(tree).props.onConfirm;
    const newTree = await click(harness, "New recipe");
    input(newTree, "Recipe name").props.onChangeText("Newer draft");
    expect(old([ingredient()])).toBe(false);
    expect(input(await harness.settle(), "Recipe name").props.value).toBe("Newer draft");
  });
  for (const phase of ["fetch", "json"]) {
    it(`ignores old open ${phase} after New`, async () => {
      const delayed = deferred();
      const { harness } = setup((request) => {
        if (request.url.pathname === "/v1/recipes") return collection(true);
        if (request.url.pathname === `/v1/recipes/${recipeId}`)
          return phase === "fetch" ? delayed.promise : { ...detail(), json: () => delayed.promise };
      });
      let tree = await harness.settle();
      const old = review(tree).props.onConfirm;
      const card = nodes(
        tree,
        (node) => node.type === "Pressable" && screenText(node).startsWith("Saved recipe"),
      )[0];
      card.props.onPress();
      await harness.settle();
      tree = await click(harness, "New recipe");
      input(tree, "Recipe name").props.onChangeText("New draft");
      delayed.resolve(
        phase === "fetch" ? detail("Old response") : await detail("Old response").json(),
      );
      tree = await harness.settle();
      expect(input(tree, "Recipe name").props.value).toBe("New draft");
      expect(old([ingredient()])).toBe(false);
    });
  }
  it("hides the review for an opened existing recipe", async () => {
    const { harness } = setup((request) =>
      request.url.pathname === "/v1/recipes" ? collection(true) : undefined,
    );
    let tree = await harness.settle();
    const old = review(tree).props.onConfirm;
    nodes(
      tree,
      (node) => node.type === "Pressable" && screenText(node).startsWith("Saved recipe"),
    )[0].props.onPress();
    tree = await harness.settle();
    expect(nodes(tree, (node) => node.type === "PastedIngredientReview")).toHaveLength(0);
    expect(input(tree, "Recipe name").props.value).toBe("Saved recipe");
    expect(old([ingredient()])).toBe(false);
  });
  for (const phase of ["fetch", "json"]) {
    it(`ignores an old save ${phase} after New without claiming the old write failed`, async () => {
      const delayed = deferred();
      const { harness, requests } = setup((request) =>
        request.method === "POST"
          ? phase === "fetch"
            ? delayed.promise
            : { ...mutation(), json: () => delayed.promise }
          : undefined,
      );
      const tree = await fill(harness);
      const old = review(tree).props.onConfirm;
      await click(harness, "Create recipe");
      expect(postRequests(requests)).toHaveLength(1);
      const next = await click(harness, "New recipe");
      input(next, "Recipe name").props.onChangeText("New after save");
      delayed.resolve(phase === "fetch" ? mutation() : await mutation().json());
      const current = await harness.settle();
      expect(input(current, "Recipe name").props.value).toBe("New after save");
      expect(screenText(current)).not.toContain("published");
      expect(old([ingredient()])).toBe(false);
    });
  }
  for (const change of ["owner", "token", "destination"]) {
    it(`clears private draft and fences old callbacks and requests on ${change} change`, async () => {
      const delayed = deferred();
      let delay = false;
      let currentOwner = owner;
      const { harness, requests } = setup((request) => {
        if (request.url.pathname === "/v1/auth/me") return session(currentOwner);
        if (request.method === "POST" && delay) return delayed.promise;
      });
      const tree = await fill(harness);
      const old = review(tree).props.onConfirm;
      delay = true;
      await click(harness, "Create recipe");
      if (change === "owner") {
        currentOwner = "another-owner";
        harness.updateProps({ ownerUserId: currentOwner });
      }
      if (change === "token") harness.updateProps({ accessToken: "replacement-token" });
      if (change === "destination")
        harness.updateProps({ apiBase: new URL("http://127.0.0.1:4001") });
      await harness.settle();
      delayed.resolve(mutation("Old session save"));
      const current = await harness.settle();
      expect(input(current, "Recipe name").props.value).toBe("");
      expect(old([ingredient()])).toBe(false);
      expect(postRequests(requests)).toHaveLength(1);
    });
  }
  it("checks owner after deferred auth JSON and never installs an old private collection", async () => {
    const delayed = deferred();
    let authCalls = 0;
    const { harness, props } = setup((request) => {
      if (request.url.pathname === "/v1/recipes") return collection(true);
      if (request.url.pathname === "/v1/auth/me" && ++authCalls === 1)
        return { ...session(), json: () => delayed.promise };
    });
    await harness.settle();
    harness.updateProps({ accessToken: "new-token" });
    await harness.settle();
    delayed.resolve(await session("stale-other-owner").json());
    const tree = await harness.settle();
    expect(props.onUnauthorized).not.toHaveBeenCalled();
    expect(review(tree).props.disabled).toBe(false);
  });
  it("does not send a save during retryable pre-write owner verification failure", async () => {
    let fail = false;
    const { harness, requests } = setup((request) =>
      fail && request.url.pathname === "/v1/auth/me" ? response({}, 503) : undefined,
    );
    await fill(harness);
    fail = true;
    await click(harness, "Create recipe");
    expect(postRequests(requests)).toHaveLength(0);
    expect(input(await harness.settle(), "Recipe name").props.value).toBe("Reviewed porridge");
    fail = false;
    await click(harness, "Create recipe");
    expect(postRequests(requests)).toHaveLength(1);
  });
  for (const failure of ["network", "http", "malformed-receipt", "receipt-owner-503"]) {
    it(`preserves the exact body and idempotency key after ${failure}`, async () => {
      let fail = true;
      let wrote = false;
      const { harness, requests, props } = setup((request) => {
        if (request.method === "POST") {
          wrote = true;
          if (fail && failure === "network")
            return Promise.reject(new Error("Synthetic lost response"));
          if (fail && failure === "http") return response({}, 503);
          if (fail && failure === "malformed-receipt") return response({ data: {} });
          return mutation();
        }
        if (
          request.url.pathname === "/v1/auth/me" &&
          wrote &&
          fail &&
          failure === "receipt-owner-503"
        )
          return response({}, 503);
      });
      await fill(harness);
      const failed = await click(harness, "Create recipe");
      expect(input(failed, "Recipe name").props.value).toBe("Reviewed porridge");
      expect(props.onUnauthorized).not.toHaveBeenCalled();
      fail = false;
      await click(harness, "Create recipe");
      const posts = postRequests(requests);
      expect(posts).toHaveLength(2);
      expect(posts[1].headers["idempotency-key"]).toBe(posts[0].headers["idempotency-key"]);
      expect(posts[1].body).toBe(posts[0].body);
      const body = JSON.parse(posts[0].body);
      expect(body.name).toBe("Reviewed porridge");
      expect(body.finalYield.grams).toBe("300.000001");
      expect(body.ingredients[0]).toMatchObject({
        foodVersionId: "202",
        portion: { kind: "grams", grams: "125.000001" },
        note: null,
      });
      expect(body.ingredients[0]).not.toHaveProperty("originalText");
      expect(body.ingredients[0]).not.toHaveProperty("clientKey");
      expect(input(await harness.settle(), "Recipe name").props.value).toBe("Saved recipe");
    });
  }
  for (const failure of ["401", "owner-mismatch"]) {
    it(`clears private builder and rejects retained transfer on ${failure}`, async () => {
      let fail = false;
      const { harness, props, requests } = setup((request) =>
        fail && request.url.pathname === "/v1/auth/me"
          ? failure === "401"
            ? response({}, 401)
            : session("wrong-owner")
          : undefined,
      );
      const tree = await fill(harness);
      const old = review(tree).props.onConfirm;
      fail = true;
      await click(harness, "Create recipe");
      const current = await harness.settle();
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
      expect(nodes(current, (node) => node.type === "PastedIngredientReview")).toHaveLength(0);
      expect(
        nodes(
          current,
          (node) => node.type === "TextInput" && node.props.accessibilityLabel === "Recipe name",
        ),
      ).toHaveLength(0);
      expect(old([ingredient()])).toBe(false);
      expect(postRequests(requests)).toHaveLength(0);
    });
  }
  it("keeps an ambiguous save retry stable across background and foreground while invalidating review", async () => {
    const delayed = deferred();
    let firstPost = true;
    const { harness, requests } = setup((request) => {
      if (request.method === "POST" && firstPost) {
        firstPost = false;
        return delayed.promise;
      }
    });
    const tree = await fill(harness);
    const old = review(tree).props.onConfirm;
    await click(harness, "Create recipe");
    background();
    const paused = await harness.settle();
    expect(review(paused).props.disabled).toBe(true);
    expect(old([ingredient()])).toBe(false);
    delayed.resolve(mutation("Background receipt"));
    foreground();
    await harness.settle();
    expect(input(await harness.settle(), "Recipe name").props.value).toBe("Reviewed porridge");
    await click(harness, "Create recipe");
    const posts = postRequests(requests);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toBe(posts[0].body);
    expect(posts[1].headers["idempotency-key"]).toBe(posts[0].headers["idempotency-key"]);
  });
  it("does not update state or close a newer session after unmount and a late 401", async () => {
    const delayed = deferred();
    const { harness, props } = setup((request) =>
      request.method === "POST" ? delayed.promise : undefined,
    );
    const tree = await fill(harness);
    const old = review(tree).props.onConfirm;
    await click(harness, "Create recipe");
    harness.unmount();
    delayed.resolve(response({}, 401));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(old([ingredient()])).toBe(false);
    expect(harness.writesAfterUnmount).toBe(0);
    expect(props.onUnauthorized).not.toHaveBeenCalled();
  });
  it("invalidates retained review after effect cleanup/setup replay and becomes usable again", async () => {
    const { harness } = setup();
    const tree = await fill(harness);
    const old = review(tree).props.onConfirm;
    harness.replayEffects();
    const current = await harness.settle();
    expect(old([ingredient()])).toBe(false);
    expect(review(current).props.disabled).toBe(false);
    expect(input(current, "Recipe name").props.value).toBe("");
    expect(review(current).props.onConfirm([ingredient()])).toBe(true);
  });
  it("blocks duplicate Save callbacks and exposes disabled native builder fields while busy", async () => {
    const delayed = deferred();
    const { harness, requests } = setup((request) =>
      request.method === "POST" ? delayed.promise : undefined,
    );
    const tree = await fill(harness);
    const save = pressable(tree, "Create recipe");
    save.props.onPress();
    save.props.onPress();
    const busy = await harness.settle();
    expect(postRequests(requests)).toHaveLength(1);
    expect(input(busy, "Recipe name").props.editable).toBe(false);
    input(tree, "Recipe name").props.onChangeText("Should not replace saving draft");
    expect(input(await harness.settle(), "Recipe name").props.value).toBe("Reviewed porridge");
    delayed.resolve(mutation());
    await harness.settle();
  });
});

describe("mobile recipe review request boundaries", () => {
  it("does not let a retained child session-close callback close a replacement builder", async () => {
    const { harness, props } = setup();
    const old = review(await harness.settle()).props.onSessionClosed;
    const fresh = await click(harness, "New recipe");
    input(fresh, "Recipe name").props.onChangeText("Fresh draft");
    old();
    expect(props.onUnauthorized).not.toHaveBeenCalled();
    expect(input(await harness.settle(), "Recipe name").props.value).toBe("Fresh draft");
  });
  it("enforces latest capacity before a rerender when ordinary draft additions arrive first", async () => {
    const { harness } = setup((request) =>
      request.url.pathname === "/v1/recipes" ? collection(true) : undefined,
    );
    const tree = await harness.settle();
    const transfer = review(tree).props.onConfirm;
    const add = pressable(tree, "Pin 100 g nested revision").props.onPress;
    for (let count = 0; count < 49; count += 1) add();
    expect(transfer([ingredient(), ingredient()])).toBe(false);
    expect(transfer([ingredient()])).toBe(true);
    expect(review(await harness.settle()).props.remainingCapacity).toBe(0);
  });
  it("rejects duplicate keys within the transfer and against existing draft ingredients", async () => {
    const { harness } = setup();
    const same = ingredient("duplicate-key");
    const tree = await harness.settle();
    expect(review(tree).props.onConfirm([same, same])).toBe(false);
    expect(review(tree).props.onConfirm([same])).toBe(true);
    expect(review(await harness.settle()).props.onConfirm([same])).toBe(false);
  });
  for (const phase of ["fetch", "json"]) {
    it(`ignores stale food search ${phase} after New`, async () => {
      const delayed = deferred();
      const { harness } = setup((request) =>
        request.url.pathname === "/v1/foods/search"
          ? phase === "fetch"
            ? delayed.promise
            : { ...searchResponse(), json: () => delayed.promise }
          : undefined,
      );
      let tree = await harness.settle();
      input(tree, "Search foods").props.onChangeText("explicit oats query");
      await click(harness, "Search foods");
      await click(harness, "New recipe");
      delayed.resolve(phase === "fetch" ? searchResponse() : await searchResponse().json());
      tree = await harness.settle();
      expect(input(tree, "Search foods").props.value).toBe("");
      expect(
        nodes(tree, (node) => node.type === "Pressable" && screenText(node) === "Add 100 g"),
      ).toHaveLength(0);
    });
  }
  it("lets only the newest collection request install its page after deferred JSON", async () => {
    const delayed = deferred();
    let lists = 0;
    const { harness } = setup((request) =>
      request.url.pathname === "/v1/recipes" && ++lists === 1
        ? { ...collection(true), json: () => delayed.promise }
        : undefined,
    );
    const pending = await harness.settle();
    const oldTransfer = review(pending).props.onConfirm;
    expect(oldTransfer([ingredient()])).toBe(false);
    harness.updateProps({ accessToken: "new-session-token" });
    await harness.settle();
    delayed.resolve(await collection(true).json());
    const current = await harness.settle();
    expect(
      nodes(
        current,
        (node) => node.type === "Pressable" && screenText(node).startsWith("Saved recipe"),
      ),
    ).toHaveLength(0);
    expect(review(current).props.disabled).toBe(false);
  });
  for (const closure of ["post-401", "receipt-owner-401", "receipt-owner-mismatch"]) {
    it(`closes the private workspace after ${closure} without pretending the save did not write`, async () => {
      let wrote = false;
      const { harness, props, requests } = setup((request) => {
        if (request.method === "POST") {
          wrote = true;
          return closure === "post-401" ? response({}, 401) : mutation();
        }
        if (wrote && request.url.pathname === "/v1/auth/me")
          return closure === "receipt-owner-mismatch" ? session("wrong-owner") : response({}, 401);
      });
      const before = await fill(harness);
      const old = review(before).props.onConfirm;
      const current = await click(harness, "Create recipe");
      expect(postRequests(requests)).toHaveLength(1);
      expect(props.onUnauthorized).toHaveBeenCalledTimes(1);
      expect(nodes(current, (node) => node.type === "PastedIngredientReview")).toHaveLength(0);
      expect(old([ingredient()])).toBe(false);
      expect(screenText(current)).not.toContain("not saved");
    });
  }
  it("does not close the new session when an old POST resolves 401 after credential change", async () => {
    const delayed = deferred();
    const { harness, props } = setup((request) =>
      request.method === "POST" ? delayed.promise : undefined,
    );
    await fill(harness);
    await click(harness, "Create recipe");
    harness.updateProps({ accessToken: "fresh-token" });
    await harness.settle();
    delayed.resolve(response({}, 401));
    const tree = await harness.settle();
    expect(props.onUnauthorized).not.toHaveBeenCalled();
    expect(review(tree).props.disabled).toBe(false);
  });
});

describe("reviewed mobile recipe draft and outbox regressions", () => {
  it("rejects retained ordinary draft actions after New while accepting fresh actions", async () => {
    const { harness, requests } = setup();
    const old = await fill(harness);
    const staleName = input(old, "Recipe name").props.onChangeText;
    const staleQuantity = input(old, "Quantity in grams").props.onChangeText;
    const staleRemove = nodes(
      old,
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === "Remove Rolled oats",
    )[0].props.onPress;
    const staleSave = pressable(old, "Create recipe").props.onPress;
    const staleNew = pressable(old, "New recipe").props.onPress;
    await click(harness, "New recipe");
    await fill(harness, "Fresh owner draft");
    staleName("Old name");
    staleQuantity("999");
    staleRemove();
    staleSave();
    staleNew();
    const current = await harness.settle();
    expect(input(current, "Recipe name").props.value).toBe("Fresh owner draft");
    expect(input(current, "Quantity in grams").props.value).toBe("125.000001");
    expect(postRequests(requests)).toHaveLength(0);
  });
  it("uses ingredient identity so a removed row callback cannot edit another row at the old index", async () => {
    const { harness } = setup();
    const initial = await harness.settle();
    const first = ingredient("first"),
      second = { ...ingredient("second"), name: "Second ingredient" };
    expect(review(initial).props.onConfirm([first, second])).toBe(true);
    const before = await harness.settle();
    const quantities = nodes(
      before,
      (node) => node.type === "TextInput" && node.props.accessibilityLabel === "Quantity in grams",
    );
    const staleQuantity = quantities[0].props.onChangeText;
    const staleNote = input(before, "Rolled oats note (optional)").props.onChangeText;
    nodes(
      before,
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === "Remove Rolled oats",
    )[0].props.onPress();
    staleQuantity("999");
    staleNote("stale note");
    const current = await harness.settle();
    expect(input(current, "Quantity in grams").props.value).toBe("125.000001");
    expect(input(current, "Second ingredient note (optional)").props.value).toBe("");
  });
  for (const change of ["owner", "token", "destination"]) {
    it(`hides old private draft in the ${change}-change render before effects reset state`, async () => {
      const { harness } = setup();
      const old = await fill(harness, "Private retained name");
      const transfer = review(old).props.onConfirm;
      harness.updateProps(
        change === "owner"
          ? { ownerUserId: "new-owner" }
          : change === "token"
            ? { accessToken: "new-token" }
            : { apiBase: new URL("http://127.0.0.1:4001") },
      );
      const during = harness.renderWithoutEffects();
      expect(nodes(during, (node) => node.type === "TextInput")).toHaveLength(0);
      expect(nodes(during, (node) => node.type === "PastedIngredientReview")).toHaveLength(0);
      expect(screenText(during)).not.toContain("Private retained name");
      expect(transfer([ingredient()])).toBe(false);
      harness.unmount();
    });
  }
  for (const interruption of ["background", "unmount"])
    for (const outcome of ["success", "ambiguous"]) {
      it(`releases the captured outbox operation hold after ${outcome} enqueue and ${interruption}`, async () => {
        const delayed = deferred();
        const operationId = "8fa46f08-3035-4f73-8131-3d077ba51056";
        const holds = new Set([operationId]);
        const queue = { status: "ready", pendingCount: 0 };
        const controller = {
          getState: () => queue,
          enqueueOperation: vi.fn(async () => {
            await delayed.promise;
            if (outcome === "ambiguous")
              throw new QuickAddEnqueueAmbiguousError(
                operationId,
                new Error("Synthetic storage uncertainty"),
              );
            return { operationId };
          }),
          requestDrain: vi.fn((id) => holds.delete(id)),
        };
        let receive;
        const { harness, props } = setup(
          (request) => (request.url.pathname === "/v1/recipes" ? collection(true) : undefined),
          {
            quickAddOutboxController: controller,
            quickAddOutboxState: queue,
            subscribeQuickAddReceipts: (listener) => {
              receive = listener;
              return () => {};
            },
          },
        );
        let tree = await harness.settle();
        nodes(
          tree,
          (node) => node.type === "Pressable" && screenText(node).startsWith("Saved recipe"),
        )[0].props.onPress();
        tree = await harness.settle();
        await click(harness, "Secure & log recipe");
        expect(controller.enqueueOperation).toHaveBeenCalledTimes(1);
        if (interruption === "background") {
          background();
          await harness.settle();
        } else harness.unmount();
        delayed.resolve();
        for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
        expect(controller.requestDrain).toHaveBeenCalledExactlyOnceWith(operationId);
        expect(holds.size).toBe(0);
        expect(harness.writesAfterUnmount).toBe(0);
        if (interruption === "background") {
          const current = await harness.settle();
          expect(screenText(current)).not.toContain("is queued securely");
          foreground();
          await harness.settle();
          receive({
            operationId,
            mutation: {
              replayed: false,
              entry: {
                entryKind: "recipe",
                localDate: "2026-09-09",
                mealSlot: "breakfast",
              },
            },
          });
          expect(props.onLogged).toHaveBeenCalledExactlyOnceWith("2026-09-09");
        }
      });
    }
  it("reloads a conflicting existing revision through the new request context", async () => {
    let conflict = false;
    const { harness, requests } = setup((request) => {
      if (request.method === "POST") {
        conflict = true;
        return response({}, 412);
      }
      if (request.url.pathname === "/v1/recipes") return collection(true);
      if (request.url.pathname === `/v1/recipes/${recipeId}`)
        return detail(conflict ? "Fresh conflict version" : undefined);
    });
    const initial = await harness.settle();
    nodes(
      initial,
      (node) => node.type === "Pressable" && screenText(node).startsWith("Saved recipe"),
    )[0].props.onPress();
    const loaded = await harness.settle();
    input(loaded, "Recipe name").props.onChangeText("Changed locally");
    const current = await click(harness, "Publish revision");
    expect(input(current, "Recipe name").props.value).toBe("Fresh conflict version");
    expect(screenText(current)).toContain("Fresh values were loaded");
    expect(postRequests(requests)[0].headers["if-match"]).toBe('"1"');
  });
});
