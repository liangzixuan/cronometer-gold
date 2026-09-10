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

function nutritionRecipe({
  name = "Saved recipe",
  serving = true,
  id = recipeId,
  savedVersionId = versionId,
  versionNumber = 1,
} = {}) {
  const recipe = recipeWire(name);
  recipe.id = id;
  recipe.revision = String(versionNumber);
  const version = recipe.currentVersion;
  version.id = savedVersionId;
  version.versionNumber = versionNumber;
  version.servingCount = serving ? "2" : null;
  version.servingLabel = serving ? "bowl" : null;
  const nutrient = (name, knownAmount, completeness = "complete", traceCount = 0) => {
    const unknownCount = completeness === "unknown" ? 2 : completeness === "partial" ? 1 : 0;
    return {
      nutrientId: name,
      code: name,
      name,
      unit: "g",
      knownAmount,
      completeness,
      isExact: unknownCount === 0 && traceCount === 0,
      contributorCount: 2,
      quantifiedCount: 2 - unknownCount - traceCount,
      traceCount,
      unknownCount,
      unknownReasonCounts: {
        not_reported: unknownCount,
        not_analyzed: 0,
        not_applicable: 0,
        withheld: 0,
      },
    };
  };
  const vector = (amount) => [
    nutrient("Quantified nutrient", amount),
    nutrient("Measured zero", "0"),
    nutrient("Unknown nutrient", "0", "unknown"),
    nutrient("Partial nutrient", amount, "partial"),
    nutrient("Trace nutrient", "0", "complete", 1),
  ];
  version.nutrition = {
    totals: vector("12.0000012"),
    per100Grams: vector("10.000001"),
    perServing: serving ? vector("6.0000006") : null,
  };
  return recipe;
}
function nutritionCollection(recipes) {
  return response({
    data: recipes.map((recipe) => {
      const version = recipe.currentVersion;
      return {
        ...recipe,
        currentVersion: {
          id: version.id,
          versionNumber: version.versionNumber,
          name: version.name,
          description: version.description,
          finalYield: { grams: version.finalYield.grams, source: version.finalYield.source },
          inputMassGrams: version.inputMassGrams,
          servingCount: version.servingCount,
          servingLabel: version.servingLabel,
          warnings: version.warnings,
          createdAt: version.createdAt,
        },
      };
    }),
    page: { nextCursor: null },
  });
}
async function openNutritionRecipe(harness, name = "Saved recipe") {
  const tree = await harness.settle();
  const cards = nodes(
    tree,
    (node) =>
      node.type === "Pressable" &&
      node.props.accessibilityRole === "button" &&
      screenText(node).startsWith(`${name} v`),
  );
  expect(cards).toHaveLength(1);
  cards[0].props.onPress();
  return harness.settle();
}
function nutrientRow(tree, name) {
  const matches = nodes(
    tree,
    (node) =>
      node.type === "View" &&
      Array.isArray(node.props.children) &&
      screenText(node.props.children[0]) === name,
  );
  expect(matches).toHaveLength(1);
  return screenText(matches[0]);
}
function nutritionSetup(recipe = nutritionRecipe(), handler = () => undefined, props = {}) {
  return setup((request, requests) => {
    const result = handler(request, requests);
    if (result !== undefined) return result;
    if (request.url.pathname === "/v1/recipes") return nutritionCollection([recipe]);
    if (request.url.pathname === `/v1/recipes/${recipe.id}`) return response({ data: { recipe } });
  }, props);
}

describe("mobile saved recipe nutrition inspection", () => {
  it("defaults to the saved serving vector and preserves quantified, unknown, partial and trace values", async () => {
    const { harness, requests } = nutritionSetup();
    let tree = await openNutritionRecipe(harness);
    expect(screenText(tree)).toContain("Saved nutrition: Saved recipe · v 1");
    expect(screenText(tree)).toContain(
      "Unsaved edits and diary log quantity do not change these values.",
    );
    expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(false);
    expect(nutrientRow(tree, "Quantified nutrient")).toBe(
      "Quantified nutrient 6.0000006 g Complete coverage · quantified",
    );
    expect(nutrientRow(tree, "Measured zero")).toBe(
      "Measured zero 0 g Complete coverage · quantified",
    );
    expect(nutrientRow(tree, "Unknown nutrient")).toBe(
      "Unknown nutrient Unknown 0/2 contributions quantified",
    );
    expect(nutrientRow(tree, "Partial nutrient")).toBe(
      "Partial nutrient ≥ 6.0000006 g Partial · 1/2 quantified",
    );
    expect(nutrientRow(tree, "Trace nutrient")).toBe(
      "Trace nutrient ≥ 0 g Complete coverage · includes trace values",
    );
    const before = requests.length;
    tree = await click(harness, "Per 100 g");
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(true);
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("10.000001 g");
    expect(nutrientRow(tree, "Partial nutrient")).toContain("≥ 10.000001 g");
    tree = await click(harness, "Per serving (bowl)");
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("6.0000006 g");
    expect(requests).toHaveLength(before);
    expect(screenText(tree)).toContain("No named retention factor set is applied.");
    expect(screenText(tree)).toContain("Data source: USDA FoodData Central");
  });
  it("offers only per 100 g without a saved serving even if the draft defines one", async () => {
    const { harness, requests } = nutritionSetup(nutritionRecipe({ serving: false }));
    let tree = await openNutritionRecipe(harness);
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(true);
    expect(
      nodes(
        tree,
        (node) => node.type === "Pressable" && screenText(node).startsWith("Per serving"),
      ),
    ).toHaveLength(0);
    input(tree, "Serving count (optional)").props.onChangeText("4");
    input(tree, "Serving label").props.onChangeText("plate");
    const before = requests.length;
    tree = await click(harness, "Per 100 g");
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("10.000001 g");
    expect(
      nodes(
        tree,
        (node) => node.type === "Pressable" && screenText(node).startsWith("Per serving"),
      ),
    ).toHaveLength(0);
    expect(requests).toHaveLength(before);
  });
  it("keeps saved nutrition independent of draft fields and logs the exact saved serving", async () => {
    const { harness, props, requests } = nutritionSetup();
    props.quickAddOutboxController.enqueueOperation.mockResolvedValue({ operationId: "saved-log" });
    let tree = await openNutritionRecipe(harness);
    tree = await click(harness, "Per 100 g");
    input(tree, "Recipe name").props.onChangeText("Unsaved renamed recipe");
    input(tree, "Final yield grams").props.onChangeText("900");
    input(tree, "Quantity in grams").props.onChangeText("250");
    input(tree, "Serving count (optional)").props.onChangeText("5");
    input(tree, "Serving label").props.onChangeText("plate");
    input(tree, "Amount").props.onChangeText("2.5");
    tree = await harness.settle();
    expect(screenText(tree)).toContain("Saved nutrition: Saved recipe · v 1");
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("10.000001 g");
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(true);
    expect(pressable(tree, "Per serving (bowl)")).toBeDefined();
    tree = await click(harness, "Secure & log recipe");
    expect(props.quickAddOutboxController.enqueueOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationKind: "recipe",
        recipeId,
        recipeVersionId: versionId,
        recipeName: "Saved recipe",
        portion: { kind: "serving", amount: "2.5", servingLabel: "bowl" },
      }),
    );
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("10.000001 g");
    expect(postRequests(requests)).toHaveLength(0);
  });
  for (const basis of ["Per 100 g", "Per serving (bowl)"]) {
    it(`preserves the revision body with ${basis} selected and resets a newly saved version`, async () => {
      const next = nutritionRecipe({
        savedVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
        versionNumber: 2,
      });
      const { harness, requests } = nutritionSetup(undefined, (request) =>
        request.method === "POST"
          ? response({ data: { replayed: false, recipe: next } })
          : undefined,
      );
      let tree = await openNutritionRecipe(harness);
      tree = await click(harness, basis);
      const stale100g = pressable(tree, "Per 100 g").props.onPress;
      input(tree, "Final yield grams").props.onChangeText("300");
      input(tree, "Quantity in grams").props.onChangeText("240");
      tree = await click(harness, "Publish revision");
      expect(JSON.parse(postRequests(requests)[0].body)).toEqual({
        name: "Saved recipe",
        description: null,
        instructions: "Simmer.",
        ingredients: [
          {
            kind: "food",
            foodVersionId: food.foodVersionId,
            portion: { kind: "grams", grams: "240" },
            position: 0,
            note: null,
          },
        ],
        finalYield: { grams: "300", source: "measured" },
        servingCount: "2",
        servingLabel: "bowl",
      });
      expect(postRequests(requests)[0].headers["if-match"]).toBe('"1"');
      expect(screenText(tree)).toContain("Saved nutrition: Saved recipe · v 2");
      expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
      stale100g();
      tree = await harness.settle();
      expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    });
  }
  it("resets on another saved recipe and ignores its predecessor's retained basis controls", async () => {
    const first = nutritionRecipe();
    const second = nutritionRecipe({
      name: "Second recipe",
      id: "148bcfa6-22a6-4794-981a-091a7cfb5b2d",
      savedVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
    });
    const { harness, requests } = nutritionSetup(first, (request) => {
      if (request.url.pathname === "/v1/recipes") return nutritionCollection([first, second]);
      if (request.url.pathname === `/v1/recipes/${second.id}`)
        return response({ data: { recipe: second } });
    });
    let tree = await openNutritionRecipe(harness);
    const stale100g = pressable(tree, "Per 100 g").props.onPress;
    tree = await click(harness, "Per 100 g");
    tree = await openNutritionRecipe(harness, "Second recipe");
    expect(screenText(tree)).toContain("Saved nutrition: Second recipe · v 1");
    const before = requests.length;
    stale100g();
    tree = await harness.settle();
    expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    expect(requests).toHaveLength(before);
    const staleServing = pressable(tree, "Per serving (bowl)").props.onPress;
    tree = await click(harness, "New recipe");
    staleServing();
    tree = await harness.settle();
    expect(screenText(tree)).not.toContain("Saved nutrition:");
    tree = await openNutritionRecipe(harness, "Second recipe");
    tree = await click(harness, "Per 100 g");
    staleServing();
    tree = await harness.settle();
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(true);
  });
  for (const change of ["owner", "token", "destination"]) {
    it(`clears saved nutrition and ignores retained controls after ${change} changes`, async () => {
      let currentOwner = owner;
      const { harness } = nutritionSetup(undefined, (request) =>
        request.url.pathname === "/v1/auth/me" ? session(currentOwner) : undefined,
      );
      let tree = await openNutritionRecipe(harness);
      const stale100g = pressable(tree, "Per 100 g").props.onPress;
      currentOwner = change === "owner" ? "049eb964-1327-49a1-ab4f-5c7c41a6b68a" : owner;
      harness.updateProps(
        change === "owner"
          ? { ownerUserId: currentOwner }
          : change === "token"
            ? { accessToken: "new-synthetic-token" }
            : { apiBase: new URL("http://127.0.0.1:4001") },
      );
      tree = await harness.settle();
      expect(screenText(tree)).not.toContain("Saved nutrition:");
      tree = await openNutritionRecipe(harness);
      stale100g();
      tree = await harness.settle();
      expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    });
  }
  it("defaults to 100 g when a conflict reload removes the saved serving", async () => {
    const next = nutritionRecipe({
      serving: false,
      versionNumber: 2,
      savedVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
    });
    let conflict = false;
    const { harness } = nutritionSetup(undefined, (request) => {
      if (request.method === "POST") {
        conflict = true;
        return response({}, 412);
      }
      if (conflict && request.url.pathname === `/v1/recipes/${recipeId}`)
        return response({ data: { recipe: next } });
    });
    let tree = await openNutritionRecipe(harness);
    const staleServing = pressable(tree, "Per serving (bowl)").props.onPress;
    tree = await click(harness, "Publish revision");
    expect(screenText(tree)).toContain("Saved nutrition: Saved recipe · v 2");
    staleServing();
    tree = await harness.settle();
    expect(pressable(tree, "Per 100 g").props.accessibilityState.checked).toBe(true);
    expect(
      nodes(
        tree,
        (node) => node.type === "Pressable" && screenText(node).startsWith("Per serving"),
      ),
    ).toHaveLength(0);
    expect(nutrientRow(tree, "Quantified nutrient")).toContain("10.000001 g");
  });
  for (const change of ["owner", "token", "destination"]) {
    it(`hides saved nutrition in the ${change}-change render before effects`, async () => {
      const { harness } = nutritionSetup();
      const tree = await openNutritionRecipe(harness);
      const retained = pressable(tree, "Per 100 g").props.onPress;
      harness.updateProps(
        change === "owner"
          ? { ownerUserId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a" }
          : change === "token"
            ? { accessToken: "new-synthetic-token" }
            : { apiBase: new URL("http://127.0.0.1:4001") },
      );
      const during = harness.renderWithoutEffects();
      expect(screenText(during)).not.toContain("Saved nutrition:");
      expect(screenText(during)).not.toContain("Quantified nutrient");
      retained();
      harness.unmount();
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
  it("ignores retained basis controls after background and unmount", async () => {
    const { harness } = nutritionSetup();
    let tree = await openNutritionRecipe(harness);
    const stale100g = pressable(tree, "Per 100 g").props.onPress;
    background();
    stale100g();
    tree = await harness.settle();
    expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    expect(pressable(tree, "Per 100 g").props.disabled).toBe(true);
    foreground();
    tree = await harness.settle();
    stale100g();
    tree = await harness.settle();
    expect(pressable(tree, "Per serving (bowl)").props.accessibilityState.checked).toBe(true);
    const current100g = pressable(tree, "Per 100 g").props.onPress;
    harness.unmount();
    current100g();
    expect(harness.writesAfterUnmount).toBe(0);
  });
});

const discardCopyLabel = "Discard edits and copy saved version";
function draftInputs(tree) {
  return nodes(tree, (node) => node.type === "TextInput").map((node) => [
    node.props.accessibilityLabel,
    node.props.value,
  ]);
}
async function requestDirtyCopy(harness) {
  let tree = await openNutritionRecipe(harness);
  input(tree, "Recipe name").props.onChangeText("Unsaved variation");
  tree = await click(harness, "Copy to new draft");
  return tree;
}
function copyFixture() {
  const recipe = nutritionRecipe();
  const version = recipe.currentVersion;
  version.description = "Saved description";
  version.instructions = "Save these instructions exactly.";
  version.finalYield = { grams: "120.000001", source: "estimated", ratioToInputMass: "1" };
  version.servingCount = "2.000001";
  version.servingLabel = "small bowl";
  version.ingredients[0].portion = {
    kind: "serving",
    servingId: "303",
    amount: "1.250001",
    servingLabel: "scoop",
  };
  version.ingredients[0].resolvedGrams = "50.000040125";
  version.ingredients[0].note = "Toast gently";
  version.ingredients.push(
    {
      kind: "food",
      position: 1,
      foodVersionId: "404",
      name: "Private spice",
      brandName: "Owner blend",
      portion: { kind: "grams", grams: "0.123456" },
      resolvedGrams: "0.123456",
      note: "Keep private note",
      source: null,
      foodProvenance: {
        kind: "private_custom",
        customFoodId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a",
        customFoodVersionNumber: 7,
      },
    },
    {
      kind: "recipe",
      position: 2,
      recipeId: "148bcfa6-22a6-4794-981a-091a7cfb5b2d",
      recipeVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
      versionNumber: 3,
      name: "Pinned sauce",
      grams: "12.345678",
      resolvedGrams: "12.345678",
      note: "Keep nested note",
    },
  );
  return recipe;
}

describe("mobile copy saved recipe to new draft", () => {
  it("treats raw whitespace edits as dirty and invalidates the choice even when Save validation fails", async () => {
    const { harness, requests } = nutritionSetup();
    let tree = await openNutritionRecipe(harness);
    input(tree, "Recipe name").props.onChangeText(" Saved recipe ");
    tree = await click(harness, "Copy to new draft");
    expect(pressable(tree, discardCopyLabel)).toBeDefined();
    input(tree, "Final yield grams").props.onChangeText("");
    tree = await click(harness, "Copy to new draft");
    const staleConfirm = pressable(tree, discardCopyLabel).props.onPress;
    const before = requests.length;
    tree = await click(harness, "Publish revision");
    staleConfirm();
    tree = await harness.settle();
    expect(input(tree, "Final yield grams").props.value).toBe("");
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
    expect(requests).toHaveLength(before);
  });
  it("recognizes restored editable ingredients as clean despite regenerated client keys and search metadata", async () => {
    const { harness } = nutritionSetup();
    let tree = await openNutritionRecipe(harness);
    tree = await click(harness, "Remove");
    input(tree, "Search foods").props.onChangeText("oats");
    tree = await click(harness, "Search foods");
    tree = await click(harness, "Add 100 g");
    input(tree, "Quantity in grams").props.onChangeText("120");
    tree = await click(harness, "Copy to new draft");
    expect(pressable(tree, "Create recipe")).toBeDefined();
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
  });

  it("copies clean saved fields, exact public/private/nested pins and creates a distinct recipe without changing the original", async () => {
    const original = copyFixture();
    const originalBytes = JSON.stringify(original);
    const created = structuredClone(original);
    created.id = "35f4c0db-4621-460b-893e-f3ddf8d64d29";
    created.currentVersion.id = "c4053fd2-e902-40ce-b8fb-7c16ec3ad6bb";
    const { harness, requests } = nutritionSetup(original, (request) =>
      request.method === "POST"
        ? response({ data: { replayed: false, recipe: created } })
        : undefined,
    );
    let tree = await openNutritionRecipe(harness);
    const beforeInputs = draftInputs(tree).filter(
      ([label]) => !["Amount", "Local date"].includes(label),
    );
    const stalePublish = pressable(tree, "Publish revision").props.onPress;
    const staleLog = pressable(tree, "Secure & log recipe").props.onPress;
    input(tree, "Search foods").props.onChangeText("oats");
    tree = await click(harness, "Search foods");
    const staleAdd = pressable(tree, "Add 100 g").props.onPress;
    const before = requests.length;
    tree = await click(harness, "Copy to new draft");
    expect(draftInputs(tree)).toEqual(beforeInputs);
    expect(screenText(tree)).not.toContain("Saved nutrition:");
    expect(
      nodes(
        tree,
        (node) => node.type === "Pressable" && screenText(node) === "Secure & log recipe",
      ),
    ).toHaveLength(0);
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
    expect(review(tree).props.remainingCapacity).toBe(47);
    expect(screenText(tree)).toContain("Owner-entered private custom food, pinned version 7");
    expect(screenText(tree)).toContain("Pinned revision e5302e9d-9651-4784-baf4-a00e9f41c079");
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === "Add 100 g"),
    ).toHaveLength(0);
    stalePublish();
    staleLog();
    staleAdd();
    tree = await harness.settle();
    expect(requests).toHaveLength(before);
    expect(review(tree).props.remainingCapacity).toBe(47);
    await click(harness, "Create recipe");
    const posts = postRequests(requests);
    expect(posts).toHaveLength(1);
    expect(posts[0].url.pathname).toBe("/v1/recipes");
    expect(posts[0].headers).not.toHaveProperty("if-match");
    expect(JSON.parse(posts[0].body)).toEqual({
      name: "Saved recipe",
      description: "Saved description",
      instructions: "Save these instructions exactly.",
      finalYield: { grams: "120.000001", source: "estimated" },
      servingCount: "2.000001",
      servingLabel: "small bowl",
      ingredients: [
        {
          kind: "food",
          foodVersionId: "202",
          portion: { kind: "serving", servingId: "303", amount: "1.250001" },
          position: 0,
          note: "Toast gently",
        },
        {
          kind: "food",
          foodVersionId: "404",
          portion: { kind: "grams", grams: "0.123456" },
          position: 1,
          note: "Keep private note",
        },
        {
          kind: "recipe",
          recipeVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
          grams: "12.345678",
          position: 2,
          note: "Keep nested note",
        },
      ],
    });
    expect(JSON.stringify(original)).toBe(originalBytes);
  });
  it("preserves a maximum-length saved name without adding or truncating a prefix", async () => {
    const name = "N".repeat(200);
    const { harness } = nutritionSetup(nutritionRecipe({ name }));
    await openNutritionRecipe(harness, name);
    const tree = await click(harness, "Copy to new draft");
    expect(input(tree, "Recipe name").props.value).toBe(name);
    expect(pressable(tree, "Create recipe")).toBeDefined();
  });
  it("keeps every dirty field on cancellation and copies only saved values on discard", async () => {
    const { harness, requests } = nutritionSetup();
    let tree = await openNutritionRecipe(harness);
    input(tree, "Recipe name").props.onChangeText(" Saved recipe ");
    input(tree, "Description").props.onChangeText(" unsaved description ");
    input(tree, "Instructions").props.onChangeText(" unsaved instructions ");
    input(tree, "Final yield grams").props.onChangeText("345.000001");
    input(tree, "Serving count (optional)").props.onChangeText("4");
    input(tree, "Serving label").props.onChangeText("plate");
    input(tree, "Quantity in grams").props.onChangeText("222.000001");
    input(tree, "Rolled oats note (optional)").props.onChangeText(" unsaved note ");
    tree = await harness.settle();
    const dirty = draftInputs(tree);
    const before = requests.length;
    tree = await click(harness, "Copy to new draft");
    expect(screenText(tree)).toContain("You have unsaved edits.");
    tree = await click(harness, "Keep editing");
    expect(draftInputs(tree)).toEqual(dirty);
    tree = await click(harness, "Copy to new draft");
    tree = await click(harness, discardCopyLabel);
    expect(input(tree, "Recipe name").props.value).toBe("Saved recipe");
    expect(input(tree, "Final yield grams").props.value).toBe("120");
    expect(input(tree, "Quantity in grams").props.value).toBe("120");
    expect(input(tree, "Rolled oats note (optional)").props.value).toBe("");
    expect(input(tree, "Instructions").props.value).toBe("Simmer.");
    expect(requests).toHaveLength(before);
  });
  it("invalidates both retained choice controls after a synchronous edit and cannot dismiss a newer choice", async () => {
    const { harness } = nutritionSetup();
    let tree = await requestDirtyCopy(harness);
    const staleConfirm = pressable(tree, discardCopyLabel).props.onPress;
    const staleCancel = pressable(tree, "Keep editing").props.onPress;
    input(tree, "Recipe name").props.onChangeText("Even newer unsaved name");
    staleConfirm();
    staleCancel();
    tree = await harness.settle();
    expect(input(tree, "Recipe name").props.value).toBe("Even newer unsaved name");
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
    tree = await click(harness, "Copy to new draft");
    staleCancel();
    staleConfirm();
    tree = await harness.settle();
    expect(pressable(tree, discardCopyLabel)).toBeDefined();
    tree = await click(harness, discardCopyLabel);
    expect(input(tree, "Recipe name").props.value).toBe("Saved recipe");
  });
  for (const change of [
    "New",
    "selection",
    "save",
    "background",
    "unmount",
    "owner",
    "token",
    "destination",
  ]) {
    it(`invalidates retained discard confirmation after ${change}`, async () => {
      const { harness, requests } = nutritionSetup();
      let tree = await requestDirtyCopy(harness);
      const staleConfirm = pressable(tree, discardCopyLabel).props.onPress;
      const staleCancel = pressable(tree, "Keep editing").props.onPress;
      const staleCopy = pressable(tree, "Copy to new draft").props.onPress;
      if (change === "New") tree = await click(harness, "New recipe");
      else if (change === "selection") tree = await openNutritionRecipe(harness);
      else if (change === "save") tree = await click(harness, "Publish revision");
      else if (change === "background") {
        background();
        tree = await harness.settle();
      } else if (change === "unmount") harness.unmount();
      else {
        harness.updateProps(
          change === "owner"
            ? { ownerUserId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a" }
            : change === "token"
              ? { accessToken: "next-token" }
              : { apiBase: new URL("http://127.0.0.1:4001") },
        );
        tree = await harness.settle();
      }
      const before = requests.length;
      const beforeInputs = draftInputs(tree);
      staleConfirm();
      staleCancel();
      staleCopy();
      if (change !== "unmount") {
        tree = await harness.settle();
        expect(draftInputs(tree)).toEqual(beforeInputs);
        expect(
          nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
        ).toHaveLength(0);
      }
      expect(requests).toHaveLength(before);
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
  for (const action of ["save", "log"]) {
    it(`blocks copying while an original ${action} is active`, async () => {
      const delayed = deferred();
      const { harness, props } = nutritionSetup(undefined, (request) =>
        request.method === "POST" ? delayed.promise : undefined,
      );
      props.quickAddOutboxController.enqueueOperation.mockReturnValue(delayed.promise);
      let tree = await openNutritionRecipe(harness);
      const staleCopy = pressable(tree, "Copy to new draft").props.onPress;
      tree = await click(harness, action === "save" ? "Publish revision" : "Secure & log recipe");
      expect(pressable(tree, "Copy to new draft").props.disabled).toBe(true);
      staleCopy();
      tree = await harness.settle();
      expect(screenText(tree)).toContain("Saved nutrition:");
      expect(nodes(tree, (node) => node.type === "PastedIngredientReview")).toHaveLength(0);
      harness.unmount();
      delayed.resolve(action === "save" ? mutation() : { operationId: "original-log" });
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
  for (const boundary of ["copy", "New"]) {
    it(`uses a new creation identity after ${boundary} while retaining same-draft retry bytes and key`, async () => {
      const recipe = nutritionRecipe({ serving: false });
      const { harness, requests } = nutritionSetup(recipe, (request) =>
        request.method === "POST" ? response({}, 503) : undefined,
      );
      await openNutritionRecipe(harness);
      await click(harness, "Copy to new draft");
      await click(harness, "Create recipe");
      if (boundary === "copy") {
        await openNutritionRecipe(harness);
        await click(harness, "Copy to new draft");
      } else {
        let tree = await click(harness, "New recipe");
        input(tree, "Recipe name").props.onChangeText("Saved recipe");
        input(tree, "Final yield grams").props.onChangeText("120");
        input(tree, "Instructions").props.onChangeText("Simmer.");
        expect(
          review(tree).props.onConfirm([
            { ...ingredient(), portion: { kind: "grams", grams: "120" } },
          ]),
        ).toBe(true);
        tree = await harness.settle();
      }
      await click(harness, "Create recipe");
      await click(harness, "Create recipe");
      const posts = postRequests(requests);
      expect(posts).toHaveLength(3);
      expect(posts[0].body).toBe(posts[1].body);
      expect(posts[1].body).toBe(posts[2].body);
      expect(posts[0].headers["idempotency-key"]).not.toBe(posts[1].headers["idempotency-key"]);
      expect(posts[1].headers["idempotency-key"]).toBe(posts[2].headers["idempotency-key"]);
    });
  }
  it("leaves the copied draft intact when an original queued log is confirmed later", async () => {
    let receive;
    const { harness, props } = nutritionSetup(undefined, () => undefined, {
      subscribeQuickAddReceipts: (listener) => {
        receive = listener;
        return () => {};
      },
    });
    props.quickAddOutboxController.enqueueOperation.mockResolvedValue({
      operationId: "original-log",
    });
    let tree = await openNutritionRecipe(harness);
    const retainedAmount = input(tree, "Amount").props.onChangeText;
    await click(harness, "Secure & log recipe");
    tree = await click(harness, "Copy to new draft");
    input(tree, "Recipe name").props.onChangeText("Variation in progress");
    receive({
      operationId: "original-log",
      mutation: {
        replayed: false,
        entry: { entryKind: "recipe", localDate: "2026-09-09", mealSlot: "breakfast" },
      },
    });
    tree = await harness.settle();
    expect(input(tree, "Recipe name").props.value).toBe("Variation in progress");
    expect(props.onLogged).not.toHaveBeenCalled();
    expect(props.quickAddOutboxController.requestDrain).toHaveBeenCalledExactlyOnceWith(
      "original-log",
    );
    tree = await openNutritionRecipe(harness);
    retainedAmount("999");
    tree = await harness.settle();
    expect(input(tree, "Amount").props.value).toBe("1");
  });
});

function ingredientRows(tree) {
  return nodes(
    tree,
    (node) =>
      node.type === "View" &&
      Array.isArray(node.props.children) &&
      node.props.children[0]?.type === "Text" &&
      typeof node.props.children[0]?.props.accessibilityLabel === "string",
  );
}
function rowAction(tree, index, label) {
  const row = ingredientRows(tree)[index];
  expect(row).toBeDefined();
  const matches = nodes(row, (node) => node.type === "Pressable" && screenText(node) === label);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function rowFields(tree, index) {
  return nodes(ingredientRows(tree)[index], (node) => node.type === "TextInput");
}
function ingredientSnapshot(tree) {
  return ingredientRows(tree).map((row) => ({
    key: row.key,
    name: screenText(row.props.children[0]),
    attribution: screenText(row.props.children[1]),
    fields: nodes(row, (node) => node.type === "TextInput").map((node) => node.props.value),
  }));
}
async function moveRow(harness, index, direction) {
  const tree = await harness.settle();
  const button = rowAction(tree, index, direction === "up" ? "Move up" : "Move down");
  expect(button.props.disabled).toBe(false);
  button.props.onPress();
  return harness.settle();
}
function retainedRowActions(tree, index = 0) {
  return () => {
    rowAction(tree, index, "Move down").props.onPress();
    rowFields(tree, index)[0].props.onChangeText("999");
    rowFields(tree, index)[1].props.onChangeText("Stale note");
    rowAction(tree, index, "Remove").props.onPress();
  };
}

describe("mobile draft ingredient ordering", () => {
  it("handles empty and single-row drafts and rejects boundary callbacks without requests", async () => {
    const { harness, requests } = setup();
    let tree = await harness.settle();
    expect(ingredientRows(tree)).toHaveLength(0);
    expect(review(tree).props.onConfirm([ingredient()])).toBe(true);
    tree = await harness.settle();
    const before = ingredientSnapshot(tree);
    const beforeRequests = requests.length;
    for (const label of ["Move up", "Move down"]) {
      const button = rowAction(tree, 0, label);
      expect(button.props.disabled).toBe(true);
      expect(button.props.accessibilityState.disabled).toBe(true);
      expect(button.props.accessibilityLabel).toBe(
        `Move Rolled oats ${label === "Move up" ? "up" : "down"}, ingredient 1 of 1`,
      );
      button.props.onPress();
    }
    tree = await harness.settle();
    expect(ingredientSnapshot(tree)).toEqual(before);
    expect(requests).toHaveLength(beforeRequests);
    rowAction(tree, 0, "Remove").props.onPress();
    tree = await harness.settle();
    expect(ingredientRows(tree)).toHaveLength(0);
  });
  for (const mode of ["create", "revision"]) {
    it(`preserves exact mixed ingredient fields and sends contiguous reordered positions on ${mode}`, async () => {
      const original = copyFixture();
      const originalBytes = JSON.stringify(original);
      const { harness, requests } = nutritionSetup(original, (request) =>
        request.method === "POST" ? response({}, 503) : undefined,
      );
      let tree = await openNutritionRecipe(harness);
      if (mode === "create") tree = await click(harness, "Copy to new draft");
      const before = ingredientSnapshot(tree);
      const beforeRequests = requests.length;
      tree = await moveRow(harness, 2, "up");
      tree = await moveRow(harness, 1, "up");
      expect(ingredientSnapshot(tree)).toEqual([before[2], before[0], before[1]]);
      expect(rowAction(tree, 0, "Move up").props.disabled).toBe(true);
      expect(rowAction(tree, 2, "Move down").props.disabled).toBe(true);
      expect(rowAction(tree, 0, "Move down").props.accessibilityLabel).toBe(
        "Move Pinned sauce down, ingredient 1 of 3",
      );
      expect(requests).toHaveLength(beforeRequests);
      expect(JSON.stringify(original)).toBe(originalBytes);
      const recipeFields = [
        "Recipe name",
        "Description",
        "Instructions",
        "Final yield grams",
        "Serving count (optional)",
        "Serving label",
      ].map((label) => input(tree, label).props.value);
      expect(recipeFields).toEqual([
        "Saved recipe",
        "Saved description",
        "Save these instructions exactly.",
        "120.000001",
        "2.000001",
        "small bowl",
      ]);
      await click(harness, mode === "create" ? "Create recipe" : "Publish revision");
      const post = postRequests(requests)[0];
      expect(post.url.pathname).toBe(
        mode === "create" ? "/v1/recipes" : `/v1/recipes/${recipeId}/revisions`,
      );
      expect(post.headers["if-match"]).toBe(mode === "create" ? undefined : '"1"');
      expect(JSON.parse(post.body)).toEqual({
        name: "Saved recipe",
        description: "Saved description",
        instructions: "Save these instructions exactly.",
        finalYield: { grams: "120.000001", source: "estimated" },
        servingCount: "2.000001",
        servingLabel: "small bowl",
        ingredients: [
          {
            kind: "recipe",
            recipeVersionId: "e5302e9d-9651-4784-baf4-a00e9f41c079",
            grams: "12.345678",
            position: 0,
            note: "Keep nested note",
          },
          {
            kind: "food",
            foodVersionId: "202",
            portion: { kind: "serving", servingId: "303", amount: "1.250001" },
            position: 1,
            note: "Toast gently",
          },
          {
            kind: "food",
            foodVersionId: "404",
            portion: { kind: "grams", grams: "0.123456" },
            position: 2,
            note: "Keep private note",
          },
        ],
      });
    });
  }
  it("keeps repeated food versions distinct and edits the selected occurrence after moving", async () => {
    const recipe = nutritionRecipe();
    const first = recipe.currentVersion.ingredients[0];
    recipe.currentVersion.ingredients = ["First", "Second", "Third"].map((note, position) => ({
      ...first,
      position,
      note,
      portion: { kind: "grams", grams: `${position + 1}.000001` },
      resolvedGrams: `${position + 1}.000001`,
    }));
    const { harness, requests } = nutritionSetup(recipe, (request) =>
      request.method === "POST" ? response({}, 503) : undefined,
    );
    let tree = await openNutritionRecipe(harness);
    const before = ingredientSnapshot(tree);
    expect(new Set(before.map((row) => row.key)).size).toBe(3);
    tree = await moveRow(harness, 1, "up");
    expect(ingredientSnapshot(tree)).toEqual([before[1], before[0], before[2]]);
    rowFields(tree, 0)[0].props.onChangeText("4.000001");
    rowFields(tree, 0)[1].props.onChangeText("Updated second occurrence");
    await click(harness, "Publish revision");
    expect(
      JSON.parse(postRequests(requests)[0].body).ingredients.map((row) => ({
        grams: row.portion.grams,
        note: row.note,
        position: row.position,
      })),
    ).toEqual([
      { grams: "4.000001", note: "Updated second occurrence", position: 0 },
      { grams: "1.000001", note: "First", position: 1 },
      { grams: "3.000001", note: "Third", position: 2 },
    ]);
  });
  it("rejects retained move, quantity, note and remove callbacks after a move and move-back", async () => {
    const { harness, requests } = nutritionSetup(copyFixture());
    let tree = await openNutritionRecipe(harness);
    const original = ingredientSnapshot(tree);
    const stale = retainedRowActions(tree);
    tree = await moveRow(harness, 1, "up");
    const moved = ingredientSnapshot(tree);
    const before = requests.length;
    stale();
    tree = await harness.settle();
    expect(ingredientSnapshot(tree)).toEqual(moved);
    tree = await moveRow(harness, 0, "down");
    expect(ingredientSnapshot(tree)).toEqual(original);
    stale();
    tree = await harness.settle();
    expect(ingredientSnapshot(tree)).toEqual(original);
    rowFields(tree, 0)[0].props.onChangeText("2.000001");
    rowFields(tree, 0)[1].props.onChangeText("Current note");
    tree = await harness.settle();
    expect(ingredientSnapshot(tree)[0].fields).toEqual(["2.000001", "Current note"]);
    expect(requests).toHaveLength(before);
  });
  it("rechecks membership after removal and keeps retained row controls from changing the replacement row", async () => {
    const { harness } = nutritionSetup(copyFixture());
    let tree = await openNutritionRecipe(harness);
    const stale = retainedRowActions(tree);
    rowAction(tree, 0, "Remove").props.onPress();
    tree = await harness.settle();
    const after = ingredientSnapshot(tree);
    stale();
    tree = await harness.settle();
    expect(ingredientSnapshot(tree)).toEqual(after);
    expect(after.map((row) => row.name)).toEqual(["Private spice", "Pinned sauce"]);
  });
  it("marks moved order dirty, invalidates a copy choice and becomes clean when the saved order is restored", async () => {
    const { harness } = nutritionSetup(copyFixture());
    let tree = await openNutritionRecipe(harness);
    tree = await moveRow(harness, 2, "up");
    tree = await click(harness, "Copy to new draft");
    const staleDiscard = pressable(tree, discardCopyLabel).props.onPress;
    tree = await moveRow(harness, 1, "up");
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
    staleDiscard();
    tree = await harness.settle();
    expect(pressable(tree, "Publish revision")).toBeDefined();
    tree = await moveRow(harness, 0, "down");
    tree = await moveRow(harness, 1, "down");
    tree = await click(harness, "Copy to new draft");
    expect(pressable(tree, "Create recipe")).toBeDefined();
    expect(
      nodes(tree, (node) => node.type === "Pressable" && screenText(node) === discardCopyLabel),
    ).toHaveLength(0);
  });
  it("keeps saved nutrition and the exact diary version independent of unsaved ingredient order", async () => {
    const { harness, props, requests } = nutritionSetup(copyFixture());
    props.quickAddOutboxController.enqueueOperation.mockResolvedValue({
      operationId: "saved-version-log",
    });
    let tree = await openNutritionRecipe(harness);
    const before = nutrientRow(tree, "Quantified nutrient");
    const beforeRequests = requests.length;
    tree = await moveRow(harness, 0, "down");
    expect(nutrientRow(tree, "Quantified nutrient")).toBe(before);
    expect(requests).toHaveLength(beforeRequests);
    await click(harness, "Secure & log recipe");
    expect(props.quickAddOutboxController.enqueueOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        recipeId,
        recipeVersionId: versionId,
        portion: { kind: "serving", amount: "1", servingLabel: "small bowl" },
      }),
    );
    expect(postRequests(requests)).toHaveLength(0);
  });
  for (const boundary of [
    "New",
    "copy",
    "open",
    "save",
    "owner",
    "token",
    "destination",
    "background",
    "unmount",
  ]) {
    it(`fences retained row controls after ${boundary}`, async () => {
      const { harness, requests } = nutritionSetup(copyFixture());
      let tree = await openNutritionRecipe(harness);
      const stale = retainedRowActions(tree);
      if (boundary === "New") tree = await click(harness, "New recipe");
      else if (boundary === "copy") tree = await click(harness, "Copy to new draft");
      else if (boundary === "open") tree = await openNutritionRecipe(harness);
      else if (boundary === "save") tree = await click(harness, "Publish revision");
      else if (boundary === "background") {
        background();
        tree = await harness.settle();
      } else if (boundary === "unmount") harness.unmount();
      else {
        harness.updateProps(
          boundary === "owner"
            ? { ownerUserId: "049eb964-1327-49a1-ab4f-5c7c41a6b68a" }
            : boundary === "token"
              ? { accessToken: "next-order-token" }
              : { apiBase: new URL("http://127.0.0.1:4001") },
        );
        tree = await harness.settle();
      }
      const before = ingredientSnapshot(tree);
      const beforeRequests = requests.length;
      stale();
      if (boundary !== "unmount") {
        tree = await harness.settle();
        expect(ingredientSnapshot(tree)).toEqual(before);
      }
      expect(requests).toHaveLength(beforeRequests);
      expect(harness.writesAfterUnmount).toBe(0);
      if (boundary === "background") {
        foreground();
        tree = await harness.settle();
        stale();
        tree = await harness.settle();
        expect(ingredientSnapshot(tree)).toEqual(before);
      }
    });
  }
  for (const action of ["save", "search", "log"]) {
    it(`disables moves and rejects retained row edits during active ${action}`, async () => {
      const delayed = deferred();
      const { harness, props } = nutritionSetup(copyFixture(), (request) =>
        (action === "save" && request.method === "POST") ||
        (action === "search" && request.url.pathname === "/v1/foods/search")
          ? delayed.promise
          : undefined,
      );
      props.quickAddOutboxController.enqueueOperation.mockReturnValue(delayed.promise);
      let tree = await openNutritionRecipe(harness);
      const before = ingredientSnapshot(tree);
      const stale = retainedRowActions(tree);
      if (action === "search") {
        input(tree, "Search foods").props.onChangeText("oats");
        tree = await harness.settle();
      }
      tree = await click(
        harness,
        action === "save"
          ? "Publish revision"
          : action === "search"
            ? "Search foods"
            : "Secure & log recipe",
      );
      for (let index = 0; index < 3; index += 1) {
        expect(rowAction(tree, index, "Move up").props.disabled).toBe(true);
        expect(rowAction(tree, index, "Move down").props.disabled).toBe(true);
      }
      stale();
      tree = await harness.settle();
      expect(ingredientSnapshot(tree)).toEqual(before);
      harness.unmount();
      delayed.resolve(
        action === "save"
          ? mutation()
          : action === "search"
            ? searchResponse()
            : { operationId: "old-order-log" },
      );
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
      expect(harness.writesAfterUnmount).toBe(0);
    });
  }
  for (const mode of ["create", "revision"]) {
    it(`keeps retry identity stable within each ${mode} order and distinct between changed orders`, async () => {
      const { harness, requests } = nutritionSetup(copyFixture(), (request) =>
        request.method === "POST" ? response({}, 503) : undefined,
      );
      await openNutritionRecipe(harness);
      if (mode === "create") await click(harness, "Copy to new draft");
      const label = mode === "create" ? "Create recipe" : "Publish revision";
      await click(harness, label);
      await moveRow(harness, 0, "down");
      await click(harness, label);
      await click(harness, label);
      await moveRow(harness, 1, "up");
      await click(harness, label);
      const posts = postRequests(requests);
      expect(posts).toHaveLength(4);
      expect(posts[0].body).not.toBe(posts[1].body);
      expect(posts[0].headers["idempotency-key"]).not.toBe(posts[1].headers["idempotency-key"]);
      expect(posts[1].body).toBe(posts[2].body);
      expect(posts[1].headers["idempotency-key"]).toBe(posts[2].headers["idempotency-key"]);
      expect(posts[3].body).toBe(posts[0].body);
      expect(posts[3].headers["idempotency-key"]).toBe(posts[0].headers["idempotency-key"]);
    });
  }
});
