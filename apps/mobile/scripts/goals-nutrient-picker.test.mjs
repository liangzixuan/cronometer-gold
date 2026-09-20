import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalsScreen } from "../src/recipes/GoalsScreen";

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
          tree = GoalsScreen(props);
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
      tree = GoalsScreen(props);
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

const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const notice = "General wellness estimate; not medical advice.";
const timestamp = "2026-09-07T12:00:00.000Z";
const nutrient = {
  id: "203",
  code: "protein",
  name: "Protein",
  unit: "g",
  category: "macronutrient",
};
const sodium = { id: "307", code: "sodium", name: "Sodium", unit: "mg", category: "mineral" };
const registry = (size) =>
  Array.from({ length: size }, (_, index) => ({
    ...nutrient,
    id: String(index + 1),
    code: `code-${index + 1}`,
    name: `Nutrient ${index + 1}`,
  }));
function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function savedGoal(targets = [], overrides = {}) {
  return {
    id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
    status: "active",
    effectiveFrom: "2026-09-07",
    effectiveTo: null,
    revision: "3",
    currentVersion: {
      id: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
      versionNumber: 3,
      energy: {
        mode: "fixed",
        targetKcal: "2100.000001",
        source: { code: "user-fixed", version: "1" },
        rationale: " Owner energy reason ",
      },
      nutrientTargets: targets.map((definition) => ({
        definition,
        minimumAmount: "0",
        targetAmount: "12.000001",
        maximumAmount: null,
        source: { label: " Owner source ", version: "v1" },
        rationale: " Preserve rationale ",
      })),
      createdAt: timestamp,
    },
    notice,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
function setup({
  definitions = [nutrient, sodium],
  goal = null,
  handler = () => undefined,
  props: overrides = {},
} = {}) {
  const requests = [];
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      const request = { url: new URL(url), method: "GET", ...options };
      requests.push(request);
      const result = handler(request, requests);
      if (result !== undefined) return result;
      if (request.url.pathname === "/v1/nutrients/targetable")
        return response({ data: definitions });
      if (request.url.pathname === "/v1/goals/current") return response({ data: { goal } });
      if (request.url.pathname === "/v1/goals/progress")
        return response({
          data: {
            localDate: request.url.searchParams.get("date"),
            timeZone: "America/Chicago",
            diaryRevision: "0",
            goal: null,
            energy: null,
            nutrients: [],
            notice,
          },
        });
      if (request.url.pathname === "/v1/goals/reference-target-sets")
        return response({ title: "Not available" }, 404);
      throw new Error(`Unexpected synthetic request: ${request.method} ${request.url.pathname}`);
    }),
  );
  const props = {
    apiBase: new URL("http://127.0.0.1:4000"),
    accessToken: "synthetic-goal-session",
    profileTimeZone: "America/Chicago",
    profileRevision: "4",
    profileBirthDate: "1999-01-02",
    profileSexAtBirth: "male",
    expectedOwnerUserId: owner,
    sessionEpoch: 1,
    onProfileUpdated: vi.fn(),
    onUnauthorized: vi.fn(async () => {}),
    onRecipes: vi.fn(),
    onDiary: vi.fn(),
    ...overrides,
  };
  return { harness: screenHarness(props), requests, props };
}
const addLabel = (definition) => `Add ${definition.name} (${definition.unit}) target`;
const addChoices = (tree) =>
  nodes(
    tree,
    (node) =>
      node.type === "Pressable" &&
      node.props.accessibilityLabel?.startsWith("Add ") &&
      node.props.accessibilityLabel.endsWith(" target"),
  );
function addChoice(tree, definition) {
  const found = addChoices(tree).filter(
    (node) => node.props.accessibilityLabel === addLabel(definition),
  );
  expect(found).toHaveLength(1);
  return found[0];
}
async function add(harness, definition) {
  const target = addChoice(await harness.settle(), definition);
  expect(target.props.disabled).not.toBe(true);
  target.props.onPress();
  return harness.settle();
}
const writes = (requests) => requests.filter((request) => request.method !== "GET");
const fields = (tree) =>
  Object.fromEntries(
    nodes(
      tree,
      (node) => node.type === "TextInput" && node.props.accessibilityLabel !== "Find a nutrient",
    ).map((node) => [node.props.accessibilityLabel, node.props.value]),
  );
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  hooks.appListeners.clear();
});

// The source-verified candidate fixture below mirrors the existing reference-targets tests.
// It passes the real parser and policy checks; these source tests make no live-source claim.
const base =
  "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes";
const macros = `${base}/tables/reference-values-macronutrients.html`;
const elements = `${base}/tables/reference-values-elements.html`;
const vitamins = `${base}/tables/reference-values-vitamins.html`;

function referenceFixture() {
  const rows = [
    ["carbohydrate", "g", "130", null, "rda", null, "IOM-2005", macros, "Table 1"],
    ["protein", "g", "56", null, "rda", null, "IOM-2005", macros, "Table 1"],
    ["fiber", "g", "38", null, "ai", null, "IOM-2005", macros, "Table 1"],
    ["sodium", "mg", "1500", null, "ai", null, "NASEM-2019", elements, "Table 3"],
    ["potassium", "mg", "3400", null, "ai", null, "NASEM-2019", elements, "Table 3"],
    ["calcium", "mg", "1000", "2500", "rda", "ul", "IOM-2011", elements, "Table 1"],
    ["iron", "mg", "8", "45", "rda", "ul", "IOM-2001", elements, "Table 2"],
    ["vitamin-c", "mg", "90", "2000", "rda", "ul", "IOM-2000", vitamins, "Table 2"],
    ["vitamin-d", "ug", "15", "100", "rda", "ul", "IOM-2011", vitamins, "Table 1"],
    ["vitamin-b12", "ug", "2.4", null, "rda", null, "IOM-1998", vitamins, "Table 3"],
    ["folate-dfe", "ug_DFE", "400", null, "rda", null, "IOM-1998", vitamins, "Table 3"],
    ["vitamin-a-rae", "ug_RAE", "900", null, "rda", null, "IOM-2001", vitamins, "Table 1"],
  ];
  return {
    data: {
      date: "2026-09-07",
      profileRevision: "4",
      availability: { available: true, reasonCodes: [] },
      sets: [
        {
          templateCode: "us-ca-dri-adults-19-50",
          templateVersion: "1",
          groupCode: "male-19-50",
          title: "U.S.–Canada reference candidate: male adults 19–50",
          policyDigest: "a".repeat(64),
          eligibleThroughExclusive: "2050-01-02",
          targets: rows.map((row, index) => ({
            definition: {
              id: String(index + 1),
              code: row[0],
              name: `Nutrient ${index + 1}`,
              unit: row[1],
              category: index < 3 ? "macronutrient" : "vitamin",
            },
            minimumAmount: null,
            targetAmount: row[2],
            maximumAmount: row[3],
            basis: {
              timeBasis: "usual-average-daily-intake",
              referenceType: row[4],
              maximumReferenceType: row[5],
              sourceRows: ["Males 19–30 y", "Males 31–50 y"],
            },
            source: {
              label: "Health Canada Dietary Reference Intakes",
              version: `HC-2025-11-19/${row[6]}`,
              url: row[7],
              table: row[8],
            },
            rationale: `Source-verified U.S.–Canada adult 19–50 ${row[4].toUpperCase()} population reference.`,
          })),
        },
      ],
      acknowledgementPolicy: {
        code: "us-ca-dri-adults-19-50-eligibility-ack",
        version: "1",
        text: "I confirm this template’s age/sex group and nonpregnant, nonlactating scope apply to me. I understand it may not fit medical conditions, medications, clinician-directed diets, current smoking, vegetarian iron needs, or unusually high sweat loss, and I can edit or remove it.",
      },
      sources: {
        code: "health-canada-dri-tables",
        version: "2025-11-19",
        reviewedOn: "2026-09-07",
        overviewUrl: `${base}/tables.html`,
        macronutrientsUrl: macros,
        elementsUrl: elements,
        vitaminsUrl: vitamins,
        reportListUrl: `${base}/dietary-reference-intake-report-list.html`,
      },
      cautions: [{ code: "general", text: "Population reference; not individualized advice." }],
      applied: {
        goalId: "b71ae11b-750e-4124-940f-a4a7ef42f246",
        goalVersionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
        goalRevision: "3",
        templateCode: "us-ca-dri-adults-19-50",
        templateVersion: "1",
        groupCode: "male-19-50",
        appliedProfileRevision: "4",
        policyDigest: "a".repeat(64),
        eligibleThroughExclusive: "2050-01-02",
        acknowledgement: {
          accepted: true,
          acceptedAt: "2026-09-07T18:30:00.000Z",
          policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
          policyVersion: "1",
        },
        set: {
          templateCode: "us-ca-dri-adults-19-50",
          templateVersion: "1",
          groupCode: "male-19-50",
          title: "U.S.–Canada reference candidate: male adults 19–50",
          policyDigest: "a".repeat(64),
          eligibleThroughExclusive: "2050-01-02",
          targets: rows.map((row, index) => ({
            definition: {
              id: String(index + 1),
              code: row[0],
              name: `Nutrient ${index + 1}`,
              unit: row[1],
              category: index < 3 ? "macronutrient" : "vitamin",
            },
            minimumAmount: null,
            targetAmount: row[2],
            maximumAmount: row[3],
            basis: {
              timeBasis: "usual-average-daily-intake",
              referenceType: row[4],
              maximumReferenceType: row[5],
              sourceRows: ["Males 19–30 y", "Males 31–50 y"],
            },
            source: {
              label: "Health Canada Dietary Reference Intakes",
              version: `HC-2025-11-19/${row[6]}`,
              url: row[7],
              table: row[8],
            },
            rationale: `Source-verified U.S.–Canada adult 19–50 ${row[4].toUpperCase()} population reference.`,
          })),
        },
      },
      notice:
        "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status.",
    },
  };
}

describe("native Goals loaded nutrient picker", () => {
  for (const size of [31, 256])
    it(`shows all ${size} loaded matches in source order and adds the final exact ID only explicitly`, async () => {
      const definitions = registry(size);
      const { harness, requests } = setup({ definitions });
      let tree = await harness.settle();
      expect(addChoices(tree).map((node) => node.props.accessibilityLabel)).toEqual(
        definitions.map(addLabel),
      );
      expect(text(tree)).toContain(`${size} matching · ${size} available · ${size} loaded`);
      expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
      tree = await add(harness, definitions.at(-1));
      expect(input(tree, `${definitions.at(-1).name} target`).props.value).toBe("");
      expect(input(tree, `${definitions.at(-1).name} source (required)`).props.value).toBe("");
      expect(addChoices(tree)).toHaveLength(size - 1);
      expect(requests).toHaveLength(4);
      expect(writes(requests)).toHaveLength(0);
    });

  it("preserves combined name/code literal trimmed case-insensitive matching and excludes unit-only matches", async () => {
    const item = { ...nutrient, name: "Alpha [x]", code: "private_code", unit: "unit_only" };
    const { harness, requests } = setup({ definitions: [item, sodium] });
    for (const query of [" ALPHA ", "PRIVATE_CODE", "[x]", "[x] private", " "]) {
      const tree = await type(harness, "Find a nutrient", query);
      expect(addChoices(tree)).toHaveLength(query.trim() ? 1 : 2);
    }
    let tree = await type(harness, "Find a nutrient", "unit_only");
    expect(addChoices(tree)).toHaveLength(0);
    expect(text(tree)).toContain("0 matching · 2 available · 2 loaded");
    expect(text(tree)).toContain("No available nutrients match this search.");
    tree = await click(harness, "Clear nutrient search");
    expect(addChoices(tree)).toHaveLength(2);
    expect(requests).toHaveLength(4);
  });

  it("preserves distinct same-name IDs/units and full long labels", async () => {
    const first = { ...nutrient, name: "Same name" };
    const second = { ...sodium, name: "Same name" };
    const long = {
      ...nutrient,
      id: "9007199254740993",
      name: "N".repeat(200),
      unit: "U".repeat(32),
    };
    const { harness } = setup({ definitions: [first, second, long] });
    let tree = await harness.settle();
    expect(addChoice(tree, long).props.accessibilityLabel).toBe(addLabel(long));
    expect(text(addChoice(tree, long))).toContain(long.name);
    expect(text(addChoice(tree, long))).toContain(long.unit);
    tree = await add(harness, second);
    expect(addChoices(tree).map((node) => node.key)).toEqual([first.id, long.id]);
    expect(text(tree)).toContain("Same name ( mg )");
  });

  it("bounds query at100, makes same-value/Clear safe, and preserves raw draft fields and status", async () => {
    const { harness, requests } = setup({ goal: savedGoal([nutrient]) });
    let tree = await harness.settle();
    await type(harness, "Why this energy target?", "  untouched reason\n");
    await type(harness, "Protein source (required)", "  raw source  ");
    await type(harness, "Protein target", "12.000000100");
    tree = await harness.settle();
    const before = fields(tree);
    const status = nodes(
      tree,
      (node) => node.type === "Text" && node.props.accessibilityLiveRegion === "polite",
    ).map(text)[0];
    expect(input(tree, "Find a nutrient").props.maxLength).toBe(100);
    tree = await type(harness, "Find a nutrient", "x".repeat(120));
    expect(input(tree, "Find a nutrient").props.value).toBe("x".repeat(100));
    await type(harness, "Find a nutrient", "x".repeat(100));
    await click(harness, "Clear nutrient search");
    tree = await click(harness, "Clear nutrient search");
    expect(fields(tree)).toEqual(before);
    expect(
      nodes(
        tree,
        (node) => node.type === "Text" && node.props.accessibilityLiveRegion === "polite",
      ).map(text)[0],
    ).toBe(status);
    expect(requests).toHaveLength(4);
  });

  for (const failed of [false, true])
    it(`uses loaded-only empty wording after ${failed ? "failed" : "empty successful"} initial load`, async () => {
      const pending = deferred();
      const { harness, requests } = setup({
        definitions: [],
        handler: (request) =>
          request.url.pathname === "/v1/nutrients/targetable" ? pending.promise : undefined,
      });
      let tree = await harness.settle();
      expect(text(tree)).toContain("Loading nutrients…");
      expect(input(tree, "Find a nutrient").props.editable).toBe(false);
      expect(button(tree, "Clear nutrient search").props.disabled).toBe(true);
      pending.resolve(
        response(
          failed ? { title: "Synthetic registry failure" } : { data: [] },
          failed ? 503 : 200,
        ),
      );
      tree = await harness.settle();
      expect(text(tree)).toContain("0 matching · 0 available · 0 loaded");
      expect(text(tree)).toContain(
        "No nutrients are loaded. Refresh goals and progress to try again.",
      );
      expect(text(tree)).not.toContain("All loaded nutrients are already");
      expect(button(tree, "Refresh goals and progress")).toBeDefined();
      expect(requests).toHaveLength(4);
    });

  it("updates available counts after Add/remove and distinguishes all-added from no-match", async () => {
    const { harness } = setup({ definitions: [nutrient] });
    let tree = await add(harness, nutrient);
    expect(text(tree)).toContain("0 matching · 0 available · 1 loaded");
    expect(text(tree)).toContain("All loaded nutrients are already in this draft.");
    const remove = nodes(
      tree,
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === "Remove Protein target",
    )[0];
    remove.props.onPress();
    tree = await harness.settle();
    expect(addChoices(tree)).toHaveLength(1);
    expect(text(tree)).toContain("1 matching · 1 available · 1 loaded");
  });

  it("rejects double or replaced-draft Add without dropping synchronous field changes", async () => {
    const { harness } = setup({ goal: savedGoal() });
    let tree = await harness.settle();
    const old = addChoice(tree, nutrient).props.onPress;
    input(tree, "Why this energy target?").props.onChangeText("new raw rationale");
    old();
    tree = await harness.settle();
    expect(input(tree, "Why this energy target?").props.value).toBe("new raw rationale");
    expect(addChoices(tree)).toHaveLength(2);
    const current = addChoice(tree, nutrient).props.onPress;
    current();
    current();
    tree = await harness.settle();
    expect(
      nodes(
        tree,
        (node) => node.type === "TextInput" && node.props.accessibilityLabel === "Protein target",
      ),
    ).toHaveLength(1);
    const beforeNew = addChoice(tree, sodium).props.onPress;
    await type(harness, "Find a nutrient", "SODIUM");
    tree = await click(harness, "Start a new goal");
    tree = await click(harness, newDiscardLabel);
    beforeNew();
    tree = await harness.settle();
    expect(input(tree, "Find a nutrient").props.value).toBe("SODIUM");
    expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
  });

  it("rejects retained Add during a fresh load before paint and preserves query across refresh", async () => {
    let hold = false;
    const pending = deferred();
    const { harness } = setup({
      handler: (request) =>
        hold && request.url.pathname === "/v1/nutrients/targetable" ? pending.promise : undefined,
    });
    let tree = await type(harness, "Find a nutrient", "Protein");
    const old = addChoice(tree, nutrient).props.onPress;
    hold = true;
    button(tree, "Refresh goals and progress").props.onPress();
    old();
    tree = await harness.settle();
    expect(addChoice(tree, nutrient).props.disabled).toBe(true);
    expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
    pending.resolve(response({ data: [nutrient, sodium] }));
    tree = await harness.settle();
    old();
    tree = await harness.settle();
    expect(input(tree, "Find a nutrient").props.value).toBe("Protein");
    expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
    tree = await add(harness, nutrient);
    expect(input(tree, "Protein target").props.value).toBe("");
  });

  it("keeps historical goals and the256-target cap read-only to Add", async () => {
    const closed = setup({ goal: savedGoal([], { effectiveTo: "2026-09-08" }) });
    let tree = await closed.harness.settle();
    expect(addChoice(tree, nutrient).props.disabled).toBe(true);
    addChoice(tree, nutrient).props.onPress();
    tree = await closed.harness.settle();
    expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
    const extra = { ...nutrient, id: "999" };
    const full = setup({ definitions: [extra], goal: savedGoal(registry(256)) });
    tree = await full.harness.settle();
    expect(text(tree)).toContain("Nutrient thresholds ( 256 /256)");
    expect(addChoices(tree)).toHaveLength(1);
    const cappedChoice = addChoice(tree, extra);
    expect(cappedChoice.props.disabled).toBe(true);
    expect(cappedChoice.props.accessibilityState.disabled).toBe(true);
    cappedChoice.props.onPress();
    tree = await full.harness.settle();
    expect(text(tree)).toContain("Nutrient thresholds ( 256 /256)");
  });

  it("preserves source-verified locks and only re-enables Add after explicit Customize", async () => {
    let locked = false;
    const reference = referenceFixture();
    const refGoal = savedGoal();
    const { harness } = setup({
      handler: (request) => {
        if (!locked) return undefined;
        if (request.url.pathname === "/v1/goals/current")
          return response({ data: { goal: refGoal } });
        if (request.url.pathname === "/v1/goals/reference-target-sets")
          return response({
            data: { ...reference.data, date: request.url.searchParams.get("date") },
          });
        return undefined;
      },
    });
    let tree = await type(harness, "Find a nutrient", "sodium");
    const old = addChoice(tree, sodium).props.onPress;
    locked = true;
    tree = await click(harness, "Refresh goals and progress");
    expect(addChoices(tree)).toHaveLength(0);
    old();
    tree = await harness.settle();
    expect(text(tree)).toContain("These source-verified candidate rows are read-only.");
    tree = await click(harness, "Customize editable copy and clear verified provenance");
    expect(input(tree, "Find a nutrient").props.value).toBe("sodium");
    tree = await add(harness, sodium);
    expect(input(tree, "Sodium target").props.value).toBe("");
  });

  for (const revise of [false, true])
    it(`preserves exact ${revise ? "revision" : "create"} body/retry identity and blocks retained Add during Save`, async () => {
      const pending = deferred();
      let attempt = 0;
      const { harness, requests } = setup({
        goal: revise ? savedGoal([nutrient]) : null,
        handler: (request) => {
          if (request.method === "POST") {
            attempt += 1;
            return attempt === 1
              ? pending.promise
              : response({ title: "Synthetic ambiguous retry" }, 503);
          }
          return undefined;
        },
      });
      if (!revise) await add(harness, nutrient);
      await type(harness, "Your selected daily energy (kcal)", "2000.000001");
      await type(harness, "Why this energy target?", " Raw energy reason ");
      await type(harness, "Protein target", "12.000000100");
      await type(harness, "Protein source (required)", " Raw source ");
      let tree = await type(harness, "Find a nutrient", "sodium");
      const before = fields(tree);
      const staleAdd = addChoice(tree, sodium).props.onPress;
      button(tree, revise ? "Publish goal revision" : "Create goal").props.onPress();
      staleAdd();
      tree = await harness.settle();
      expect(input(tree, "Find a nutrient").props.editable).toBe(false);
      expect(button(tree, "Clear nutrient search").props.disabled).toBe(true);
      expect(writes(requests)).toHaveLength(1);
      const first = writes(requests)[0];
      const body = JSON.parse(first.body);
      expect(body.energy).toEqual({
        mode: "fixed",
        targetKcal: "2000.000001",
        rationale: " Raw energy reason ",
      });
      expect(body.nutrientTargets).toEqual([
        {
          nutrientId: nutrient.id,
          minimumAmount: revise ? "0" : null,
          targetAmount: "12.000000100",
          maximumAmount: null,
          source: { label: " Raw source ", version: revise ? "v1" : null },
          rationale: revise ? " Preserve rationale " : null,
        },
      ]);
      expect(body).not.toHaveProperty("query");
      expect(first.headers["if-match"]).toBe(revise ? '"3"' : undefined);
      expect(Object.hasOwn(body, "effectiveFrom")).toBe(!revise);
      pending.resolve(response({ title: "Synthetic ambiguous save" }, 503));
      tree = await harness.settle();
      await click(harness, "Clear nutrient search");
      await type(harness, "Find a nutrient", "different search");
      tree = await click(harness, revise ? "Publish goal revision" : "Create goal");
      expect(writes(requests)[1].body).toBe(first.body);
      expect(writes(requests)[1].headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
      expect(fields(tree)).toEqual(before);
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(4);
    });
});

const copyLabel = "Copy saved goal to new draft";
const discardLabel = "Discard edits and copy saved version";
const hasButton = (tree, label) =>
  nodes(tree, (node) => node.type === "Pressable" && text(node) === label).length > 0;
function setupCopy({
  goal = savedGoal([nutrient, sodium]),
  handler = () => undefined,
  ...options
} = {}) {
  return setup({
    ...options,
    goal,
    handler: (request, requests) => {
      const result = handler(request, requests);
      if (result !== undefined) return result;
      if (request.url.pathname === "/v1/goals/reference-target-sets") {
        const reference = referenceFixture();
        return response({
          data: { ...reference.data, date: request.url.searchParams.get("date"), applied: null },
        });
      }
      return undefined;
    },
  });
}
async function dirtyChoice(harness) {
  await type(harness, "Why this energy target?", " Unsaved energy reason ");
  return click(harness, copyLabel);
}

describe("native saved manual goal copy", () => {
  it("copies exact saved fields without requests or operations and requires a reviewed date", async () => {
    const source = savedGoal([sodium, nutrient]);
    source.currentVersion.nutrientTargets[0].minimumAmount = null;
    source.currentVersion.nutrientTargets[0].targetAmount = "999999999999999999.000000000001";
    source.currentVersion.nutrientTargets[0].maximumAmount = "999999999999999999.999999999999";
    source.currentVersion.nutrientTargets[0].source.version = null;
    source.currentVersion.nutrientTargets[0].rationale = null;
    const snapshot = JSON.stringify(source);
    const { harness, requests } = setupCopy({ goal: source });
    let tree = await type(harness, "Find a nutrient", "magnesium");
    await type(harness, "Birth date YYYY-MM-DD", "2000-02-03");
    const before = fields(await harness.settle());
    delete before["Birth date YYYY-MM-DD"];
    const count = requests.length;
    const operations = hooks.operation;
    tree = await click(harness, copyLabel);
    expect(hasButton(tree, discardLabel)).toBe(false);
    expect(fields(tree)).toEqual({ ...before, "Effective from YYYY-MM-DD": "" });
    expect(input(tree, "Find a nutrient").props.value).toBe("magnesium");
    expect(
      nodes(
        tree,
        (node) =>
          node.type === "TextInput" &&
          ["Sodium target", "Protein target"].includes(node.props.accessibilityLabel),
      ).map((node) => node.props.accessibilityLabel),
    ).toEqual(["Sodium target", "Protein target"]);
    expect(text(tree)).toContain("Sodium ( mg )");
    expect(text(tree)).toContain("Protein ( g )");
    expect(hasButton(tree, "Create goal")).toBe(true);
    expect(hasButton(tree, "Publish goal revision")).toBe(false);
    expect(requests).toHaveLength(count);
    expect(hooks.operation).toBe(operations);
    expect(JSON.stringify(source)).toBe(snapshot);
    tree = await click(harness, "Create goal");
    expect(text(tree)).toContain("Effective date must be a real YYYY-MM-DD local date.");
    expect(requests).toHaveLength(count);
    expect(hooks.operation).toBe(operations);
    tree = await type(harness, "Effective from YYYY-MM-DD", "2026-09-14");
    input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
    tree = await harness.settle();
    expect(input(tree, "Birth date YYYY-MM-DD").props.value).toBe("2000-02-03");
  });

  it("Keep preserves all raw edits and Discard copies the saved version only", async () => {
    const { harness, requests } = setupCopy();
    await type(harness, "Your selected daily energy (kcal)", "1900.000099");
    await type(harness, "Protein minimum", "0.000000001");
    await type(harness, "Protein target", "99.000000000001");
    await type(harness, "Protein maximum", "100.000000000001");
    await type(harness, "Protein source (required)", " changed source ");
    await type(harness, "Protein source version", " changed version ");
    await type(harness, "Protein rationale", " changed rationale ");
    let tree = await dirtyChoice(harness);
    const before = fields(tree);
    const count = requests.length;
    const operations = hooks.operation;
    tree = await click(harness, "Keep editing");
    expect(fields(tree)).toEqual(before);
    expect(hasButton(tree, discardLabel)).toBe(false);
    await click(harness, copyLabel);
    tree = await click(harness, discardLabel);
    expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("2100.000001");
    expect(input(tree, "Why this energy target?").props.value).toBe(" Owner energy reason ");
    expect(input(tree, "Protein minimum").props.value).toBe("0");
    expect(input(tree, "Protein target").props.value).toBe("12.000001");
    expect(input(tree, "Protein maximum").props.value).toBe("");
    expect(input(tree, "Protein source (required)").props.value).toBe(" Owner source ");
    expect(input(tree, "Protein source version").props.value).toBe("v1");
    expect(input(tree, "Protein rationale").props.value).toBe(" Preserve rationale ");
    expect(requests).toHaveLength(count);
    expect(hooks.operation).toBe(operations);
  });

  for (const field of [
    "Your selected daily energy (kcal)",
    "Why this energy target?",
    "Protein minimum",
    "Protein target",
    "Protein maximum",
    "Protein source (required)",
    "Protein source version",
    "Protein rationale",
  ])
    it(`rejects retained Copy/Discard after ${field} edits, including ABA before paint`, async () => {
      const { harness, requests } = setupCopy();
      let tree = await harness.settle();
      const copy = button(tree, copyLabel).props.onPress;
      const original = input(tree, field).props.value;
      input(tree, field).props.onChangeText("changed");
      input(tree, field).props.onChangeText(original);
      const before = harness.stateWrites;
      copy();
      expect(harness.stateWrites).toBe(before);
      tree = await dirtyChoice(harness);
      const discard = button(tree, discardLabel).props.onPress;
      const keep = button(tree, "Keep editing").props.onPress;
      const currentValue = input(tree, field).props.value;
      input(tree, field).props.onChangeText("different");
      input(tree, field).props.onChangeText(currentValue);
      const writesBefore = harness.stateWrites;
      discard();
      keep();
      expect(harness.stateWrites).toBe(writesBefore);
      tree = await harness.settle();
      expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe("2026-09-07");
      expect(hasButton(tree, discardLabel)).toBe(false);
      expect(writes(requests)).toHaveLength(0);
    });

  it("invalidates a choice on Add, New and effective-date edits while keeping functional Add safety", async () => {
    const extra = { ...nutrient, id: "300", code: "extra", name: "Extra" };
    const { harness } = setupCopy({ definitions: [nutrient, sodium, extra] });
    let tree = await dirtyChoice(harness);
    const oldDiscard = button(tree, discardLabel).props.onPress;
    addChoice(tree, extra).props.onPress();
    const writesBefore = harness.stateWrites;
    oldDiscard();
    expect(harness.stateWrites).toBe(writesBefore);
    tree = await harness.settle();
    expect(input(tree, "Extra target").props.value).toBe("");
    tree = await click(harness, copyLabel);
    const beforeNew = button(tree, discardLabel).props.onPress;
    button(tree, "Start a new goal").props.onPress();
    beforeNew();
    tree = await harness.settle();
    tree = await click(harness, newDiscardLabel);
    expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("");
    tree = await click(harness, copyLabel);
    const beforeDate = button(tree, discardLabel).props.onPress;
    input(tree, "Effective from YYYY-MM-DD").props.onChangeText("2026-09-14");
    beforeDate();
    tree = await harness.settle();
    expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe("2026-09-14");
    expect(hasButton(tree, discardLabel)).toBe(false);
  });

  it.each(["2026-09-09", "2026-09-10", "2026-09-11"])(
    "rejects progress-date ABA before blur, then recovers only from a complete fresh load (%s)",
    async (currentDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${currentDate}T12:00:00.000Z`));
      const { harness } = setupCopy();
      let tree = await dirtyChoice(harness);
      const discard = button(tree, discardLabel).props.onPress;
      const copy = button(tree, copyLabel).props.onPress;
      const date = input(tree, "Progress date YYYY-MM-DD");
      expect(date.props.value).toBe(currentDate);
      const changedDate = currentDate === "2026-09-10" ? "2026-09-11" : "2026-09-10";
      expect(changedDate).not.toBe(date.props.value);
      date.props.onChangeText(changedDate);
      date.props.onChangeText(date.props.value);
      const before = harness.stateWrites;
      discard();
      copy();
      expect(harness.stateWrites).toBe(before);
      tree = await harness.settle();
      expect(hasButton(tree, copyLabel)).toBe(false);
      tree = await click(harness, "Refresh goals and progress");
      expect(button(tree, copyLabel).props.disabled).toBe(false);
    },
  );

  for (const props of [
    { expectedOwnerUserId: "22222222-2222-4222-8222-222222222222" },
    { sessionEpoch: 2 },
    { profileRevision: "5" },
    { profileTimeZone: "UTC" },
    { accessToken: "replacement-synthetic-token" },
    { apiBase: new URL("http://127.0.0.1:4999") },
  ])
    it(`rejects private/route/profile replacement before effects: ${Object.keys(props)[0]}`, async () => {
      const { harness } = setupCopy();
      const tree = await dirtyChoice(harness);
      const copy = button(tree, copyLabel).props.onPress;
      const discard = button(tree, discardLabel).props.onPress;
      harness.updateProps(props);
      harness.renderWithoutEffects();
      const before = harness.stateWrites;
      copy();
      discard();
      expect(harness.stateWrites).toBe(before);
      harness.unmount();
    });

  it("rejects retained actions on unmount and effect replay", async () => {
    const { harness } = setupCopy();
    let tree = await dirtyChoice(harness);
    const stale = button(tree, discardLabel).props.onPress;
    harness.replayEffects();
    const before = harness.stateWrites;
    stale();
    expect(harness.stateWrites).toBe(before);
    tree = await harness.settle();
    const copy = button(tree, copyLabel).props.onPress;
    harness.unmount();
    copy();
    expect(harness.writesAfterUnmount).toBe(0);
  });

  for (const mode of [
    "404",
    "failed",
    "malformed",
    "wrong-profile",
    "wrong-date",
    "verified",
    "no-goal",
  ])
    it(`withholds copy for ${mode} source evidence`, async () => {
      const { harness } = setupCopy({
        goal: mode === "no-goal" ? null : savedGoal(),
        handler: (request) => {
          if (request.url.pathname !== "/v1/goals/reference-target-sets") return undefined;
          if (mode === "404") return response({}, 404);
          if (mode === "failed") return response({}, 503);
          if (mode === "malformed") return response({ data: {} });
          const reference = referenceFixture();
          return response({
            data: {
              ...reference.data,
              date: mode === "wrong-date" ? "2026-01-01" : request.url.searchParams.get("date"),
              profileRevision: mode === "wrong-profile" ? "99" : "4",
              applied: mode === "verified" ? reference.data.applied : null,
            },
          });
        },
      });
      let tree = await harness.settle();
      expect(hasButton(tree, copyLabel)).toBe(false);
      if (mode === "verified") {
        tree = await click(harness, "Customize editable copy and clear verified provenance");
        expect(hasButton(tree, copyLabel)).toBe(false);
      }
    });

  it("allows closed manual history to copy while keeping its saved source immutable", async () => {
    const source = savedGoal([nutrient], { status: "archived", effectiveTo: "2026-09-08" });
    const { harness, requests } = setupCopy({ goal: source });
    let tree = await harness.settle();
    expect(input(tree, "Your selected daily energy (kcal)").props.editable).toBe(false);
    tree = await click(harness, copyLabel);
    expect(input(tree, "Your selected daily energy (kcal)").props.editable).toBe(true);
    expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe("");
    expect(source.effectiveTo).toBe("2026-09-08");
    expect(writes(requests)).toHaveLength(0);
  });

  it("blocks active candidate requests and recovers independently from candidate UI provenance", async () => {
    const held = deferred();
    let hold = false;
    const { harness } = setupCopy({
      handler: (request) =>
        hold && request.url.pathname === "/v1/goals/reference-target-sets"
          ? held.promise
          : undefined,
    });
    let tree = await harness.settle();
    const copy = button(tree, copyLabel).props.onPress;
    hold = true;
    input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
    const before = harness.stateWrites;
    copy();
    expect(harness.stateWrites).toBe(before);
    held.resolve(response({}, 404));
    tree = await harness.settle();
    expect(button(tree, copyLabel).props.disabled).toBe(false);
    tree = await click(harness, copyLabel);
    expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe("");
  });

  it("withholds old source during failed reload and rejects delayed JSON after scope change", async () => {
    const held = deferred();
    let hold = false;
    const { harness } = setupCopy({
      handler: (request) =>
        hold && request.url.pathname === "/v1/goals/current"
          ? { status: 200, ok: true, json: () => held.promise }
          : undefined,
    });
    const tree = await harness.settle();
    const copy = button(tree, copyLabel).props.onPress;
    hold = true;
    button(tree, "Refresh goals and progress").props.onPress();
    const before = harness.stateWrites;
    copy();
    expect(harness.stateWrites).toBe(before);
    await harness.settle();
    harness.updateProps({ sessionEpoch: 2 });
    harness.renderWithoutEffects();
    held.resolve({ data: { goal: savedGoal() } });
    await harness.settle();
    expect(hasButton(await harness.settle(), copyLabel)).toBe(false);
    harness.unmount();
  });

  it("preserves ambiguous revision/create operations, distinguishes new dates and accepts replay receipts", async () => {
    const source = savedGoal([nutrient]);
    let current = source;
    let accept = false;
    const { harness, requests } = setupCopy({
      goal: source,
      handler: (request) => {
        if (request.url.pathname === "/v1/goals/current")
          return response({ data: { goal: current } });
        if (request.method !== "POST") return undefined;
        if (!accept) return response({ title: "Synthetic ambiguous write" }, 503);
        const body = JSON.parse(request.body);
        current = savedGoal([nutrient], {
          id: "33333333-3333-4333-8333-333333333333",
          revision: "1",
          effectiveFrom: body.effectiveFrom,
        });
        return response({ data: { goal: current, replayed: true } }, 201);
      },
    });
    await click(harness, "Publish goal revision");
    const revision = writes(requests)[0];
    await click(harness, copyLabel);
    await type(harness, "Effective from YYYY-MM-DD", "2026-09-14");
    await click(harness, "Create goal");
    const first = writes(requests)[1];
    expect(first.url.pathname).toBe("/v1/goals");
    expect(first.headers["if-match"]).toBeUndefined();
    expect(first.headers["idempotency-key"]).not.toBe(revision.headers["idempotency-key"]);
    expect(JSON.parse(first.body)).toEqual({
      effectiveFrom: "2026-09-14",
      expectedOwnerUserId: owner,
      energy: { mode: "fixed", targetKcal: "2100.000001", rationale: " Owner energy reason " },
      nutrientTargets: [
        {
          nutrientId: nutrient.id,
          minimumAmount: "0",
          targetAmount: "12.000001",
          maximumAmount: null,
          source: { label: " Owner source ", version: "v1" },
          rationale: " Preserve rationale ",
        },
      ],
    });
    const requestCount = requests.length;
    const operationCount = hooks.operation;
    await click(harness, copyLabel);
    await click(harness, "Keep editing");
    await click(harness, copyLabel);
    await click(harness, discardLabel);
    expect(requests).toHaveLength(requestCount);
    expect(hooks.operation).toBe(operationCount);
    await type(harness, "Effective from YYYY-MM-DD", "2026-09-14");
    await click(harness, "Create goal");
    expect(writes(requests)[2].body).toBe(first.body);
    expect(writes(requests)[2].headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    await type(harness, "Effective from YYYY-MM-DD", "2026-09-15");
    await click(harness, "Create goal");
    expect(writes(requests)[3].headers["idempotency-key"]).not.toBe(
      first.headers["idempotency-key"],
    );
    await type(harness, "Your selected daily energy (kcal)", "2101.000001");
    await click(harness, "Create goal");
    expect(writes(requests)[4].headers["idempotency-key"]).not.toBe(
      writes(requests)[3].headers["idempotency-key"],
    );
    await type(harness, "Your selected daily energy (kcal)", "2100.000001");
    await type(harness, "Effective from YYYY-MM-DD", "2026-09-14");
    accept = true;
    const tree = await click(harness, "Create goal");
    expect(writes(requests)[5].body).toBe(first.body);
    expect(writes(requests)[5].headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(text(tree)).toContain("The earlier goal save was confirmed safely.");
    expect(hasButton(tree, "Publish goal revision")).toBe(true);
    expect(source.effectiveFrom).toBe("2026-09-07");
  });
});

describe("native saved goal copy request boundaries", () => {
  it("excludes a valid derived saved source after an unsaved switch to fixed", async () => {
    const source = derivedSavedGoal();
    const { harness, requests } = setupCopy({ goal: source });
    let tree = await harness.settle();
    expect(text(tree)).toContain("Goal version 3 applies");
    expect(hasButton(tree, copyLabel)).toBe(false);
    tree = await click(harness, "Fixed target");
    expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("");
    expect(hasButton(tree, copyLabel)).toBe(false);
    expect(writes(requests)).toHaveLength(0);
  });

  it("invalidates Discard after Remove before paint", async () => {
    const { harness } = setupCopy();
    const tree = await dirtyChoice(harness);
    const discard = button(tree, discardLabel).props.onPress;
    nodes(
      tree,
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === "Remove Protein target",
    )[0].props.onPress();
    const before = harness.stateWrites;
    discard();
    expect(harness.stateWrites).toBe(before);
    expect(fields(await harness.settle())).not.toHaveProperty("Protein target");
  });

  for (const status of [503, 401])
    it(`blocks retained Copy/Discard during active save and handles ${status}`, async () => {
      const held = deferred();
      const { harness, props } = setupCopy({
        handler: (request) => (request.method === "POST" ? held.promise : undefined),
      });
      let tree = await dirtyChoice(harness);
      const copy = button(tree, copyLabel).props.onPress;
      const discard = button(tree, discardLabel).props.onPress;
      button(tree, "Publish goal revision").props.onPress();
      const before = harness.stateWrites;
      copy();
      discard();
      expect(harness.stateWrites).toBe(before);
      tree = await harness.settle();
      expect(button(tree, copyLabel).props.disabled).toBe(true);
      held.resolve(response({ title: "Synthetic save boundary" }, status));
      tree = await harness.settle();
      if (status === 401) {
        expect(props.onUnauthorized).toHaveBeenCalledOnce();
        expect(hasButton(tree, copyLabel)).toBe(false);
        const afterClosure = harness.stateWrites;
        copy();
        discard();
        expect(harness.stateWrites).toBe(afterClosure);
      } else {
        expect(button(tree, copyLabel).props.disabled).toBe(false);
        tree = await click(harness, discardLabel);
        expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe("");
      }
    });

  it("blocks Copy during profile writes and requires fresh source evidence after profile revision changes", async () => {
    const held = deferred();
    let revision = "4";
    const { harness, props } = setupCopy({
      handler: (request) => {
        if (request.url.pathname === "/v1/profile") return held.promise;
        if (request.url.pathname === "/v1/goals/reference-target-sets") {
          const ref = referenceFixture();
          return response({
            data: {
              ...ref.data,
              date: request.url.searchParams.get("date"),
              profileRevision: revision,
              applied: null,
            },
          });
        }
        return undefined;
      },
    });
    let tree = await harness.settle();
    const copy = button(tree, copyLabel).props.onPress;
    button(tree, "Save profile and check eligibility").props.onPress();
    const before = harness.stateWrites;
    copy();
    expect(harness.stateWrites).toBe(before);
    revision = "5";
    held.resolve(
      response({
        data: {
          profile: {
            displayName: null,
            locale: "en",
            timeZone: "America/Chicago",
            unitSystem: "metric",
            revision,
            birthDate: "1999-01-02",
            sexAtBirth: "male",
          },
        },
      }),
    );
    tree = await harness.settle();
    expect(props.onProfileUpdated).toHaveBeenCalledOnce();
    harness.updateProps({ profileRevision: revision });
    tree = await harness.settle();
    expect(hasButton(tree, copyLabel)).toBe(false);
    tree = await click(harness, "Refresh goals and progress");
    expect(button(tree, copyLabel).props.disabled).toBe(false);
  });

  it("removes old eligible source after a failed reload and restores it only on successful reload", async () => {
    let fail = false;
    const { harness } = setupCopy({
      handler: (request) =>
        fail && request.url.pathname === "/v1/nutrients/targetable" ? response({}, 503) : undefined,
    });
    let tree = await dirtyChoice(harness);
    const discard = button(tree, discardLabel).props.onPress;
    fail = true;
    tree = await click(harness, "Refresh goals and progress");
    expect(hasButton(tree, copyLabel)).toBe(false);
    const before = harness.stateWrites;
    discard();
    expect(harness.stateWrites).toBe(before);
    fail = false;
    tree = await click(harness, "Refresh goals and progress");
    expect(button(tree, copyLabel).props.disabled).toBe(false);
  });
});

function derivedSavedGoal() {
  const source = savedGoal([nutrient]);
  source.currentVersion.energy = {
    mode: "derived",
    targetKcal: "2100",
    bmrKcal: "1500",
    ageYears: 27,
    heightCm: "175",
    weightKg: "70",
    sexAtBirth: "male",
    profileRevision: "4",
    activityLevelCode: "sedentary_or_light",
    activityFactor: "1.4",
    adjustmentKcal: "0",
    source: {
      equation: {
        code: "mifflin-st-jeor-ree",
        version: "1990-original",
        url: "https://example.test/equation",
      },
      activityPolicy: {
        code: "fao-who-unu-pal-policy",
        version: "2004-reviewed-v1",
        sourceUrl: "https://example.test/activity",
      },
    },
    rationale: "Saved derived reason",
  };
  return source;
}

const newLabel = "Start a new goal";
const newDiscardLabel = "Discard edits and start a new goal";
function setupNew(kind = "manual", options = {}) {
  return setupCopy({
    goal: kind === "derived" ? derivedSavedGoal() : savedGoal([nutrient, sodium]),
    ...(kind === "reference"
      ? {
          handler: (request) => {
            if (request.url.pathname !== "/v1/goals/reference-target-sets") return undefined;
            const reference = referenceFixture();
            return response({
              data: { ...reference.data, date: request.url.searchParams.get("date") },
            });
          },
        }
      : {}),
    ...options,
  });
}
async function newChoice(harness) {
  await type(harness, "Why this energy target?", " Unsaved goal reason ");
  return click(harness, newLabel);
}

describe("native New goal draft protection", () => {
  for (const kind of ["manual", "derived", "reference"]) {
    it(`starts a pristine ${kind} goal directly without depending on Copy eligibility`, async () => {
      const { harness, requests } = setupNew(kind);
      let tree = await harness.settle();
      if (kind !== "manual") expect(hasButton(tree, copyLabel)).toBe(false);
      if (kind === "reference") {
        expect(text(tree)).toContain("Its source-verified candidate provenance was confirmed.");
        expect(input(tree, "Nutrient 1 target").props.editable).toBe(false);
      }
      const date = input(tree, "Progress date YYYY-MM-DD").props.value;
      const count = requests.length;
      const operations = hooks.operation;
      tree = await click(harness, newLabel);
      expect(hasButton(tree, newDiscardLabel)).toBe(false);
      expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("");
      expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe(date);
      expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
      expect(hasButton(tree, "Create goal")).toBe(true);
      expect(requests).toHaveLength(count);
      expect(hooks.operation).toBe(operations);
    });

    it(`protects dirty ${kind} edits and treats exact reversion as pristine`, async () => {
      const { harness, requests } = setupNew(kind);
      let tree = await harness.settle();
      const original = input(tree, "Why this energy target?").props.value;
      const count = requests.length;
      tree = await newChoice(harness);
      expect(input(tree, "Why this energy target?").props.value).toBe(" Unsaved goal reason ");
      expect(hasButton(tree, newDiscardLabel)).toBe(true);
      tree = await click(harness, "Keep editing");
      expect(input(tree, "Why this energy target?").props.value).toBe(" Unsaved goal reason ");
      await type(harness, "Why this energy target?", original);
      tree = await click(harness, newLabel);
      expect(hasButton(tree, newDiscardLabel)).toBe(false);
      expect(hasButton(tree, "Create goal")).toBe(true);
      expect(requests).toHaveLength(count);
    });
  }

  it("preserves every raw edit on Keep and resets only goal fields on explicit discard", async () => {
    const source = savedGoal([sodium, nutrient]);
    const snapshot = JSON.stringify(source);
    const { harness, requests } = setupNew("manual", { goal: source });
    await type(harness, "Find a nutrient", "  magnesium  ");
    await type(harness, "Birth date YYYY-MM-DD", "2000-02-03");
    for (const [label, value] of [
      ["Your selected daily energy (kcal)", "1900.000099"],
      ["Protein minimum", "0.000000001"],
      ["Protein target", "99.000000000001"],
      ["Protein maximum", "100.000000000001"],
      ["Protein source (required)", " changed source "],
      ["Protein source version", " changed version "],
      ["Protein rationale", " changed rationale "],
    ])
      await type(harness, label, value);
    let tree = await newChoice(harness);
    const before = fields(tree);
    const date = input(tree, "Progress date YYYY-MM-DD").props.value;
    const count = requests.length;
    const operations = hooks.operation;
    expect(button(tree, newDiscardLabel).props.accessibilityState).toEqual({ disabled: false });
    expect(button(tree, "Keep editing").props.accessibilityState).toEqual({ disabled: false });
    tree = await click(harness, "Keep editing");
    expect(fields(tree)).toEqual(before);
    await click(harness, newLabel);
    tree = await click(harness, newDiscardLabel);
    expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("");
    expect(input(tree, "Why this energy target?").props.value).toBe("");
    expect(input(tree, "Effective from YYYY-MM-DD").props.value).toBe(date);
    expect(text(tree)).toContain("Nutrient thresholds ( 0 /256)");
    expect(input(tree, "Find a nutrient").props.value).toBe("  magnesium  ");
    expect(input(tree, "Birth date YYYY-MM-DD").props.value).toBe("2000-02-03");
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(requests).toHaveLength(count);
    expect(hooks.operation).toBe(operations);
  });

  it("ignores search/profile drafts for dirtiness and protects customized reference targets", async () => {
    const plain = setupNew();
    await type(plain.harness, "Find a nutrient", "sodium");
    await type(plain.harness, "Birth date YYYY-MM-DD", "2000-02-03");
    let tree = await click(plain.harness, newLabel);
    expect(hasButton(tree, newDiscardLabel)).toBe(false);
    expect(input(tree, "Birth date YYYY-MM-DD").props.value).toBe("2000-02-03");
    const verified = setupNew("reference");
    await click(verified.harness, "Customize editable copy and clear verified provenance");
    tree = await click(verified.harness, newLabel);
    const before = fields(tree);
    expect(hasButton(tree, newDiscardLabel)).toBe(true);
    tree = await click(verified.harness, "Keep editing");
    expect(fields(tree)).toEqual(before);
    expect(input(tree, "Nutrient 1 source (required)").props.value).toContain(
      "User-customized copy",
    );
  });

  it("preserves ambiguous revision retries through Keep and creates only after confirmed New", async () => {
    const { harness, requests } = setupNew("manual", {
      handler: (request) => (request.method === "POST" ? response({}, 503) : undefined),
    });
    await type(harness, "Why this energy target?", " retry exact raw reason ");
    await click(harness, "Publish goal revision");
    const original = writes(requests)[0];
    const count = requests.length;
    const operations = hooks.operation;
    await click(harness, newLabel);
    await click(harness, "Keep editing");
    expect(requests).toHaveLength(count);
    expect(hooks.operation).toBe(operations);
    await click(harness, "Publish goal revision");
    expect(writes(requests)[1].body).toBe(original.body);
    expect(writes(requests)[1].headers).toEqual(original.headers);
    await click(harness, newLabel);
    await click(harness, newDiscardLabel);
    expect(writes(requests)).toHaveLength(2);
    await type(harness, "Your selected daily energy (kcal)", "1800.000001");
    await type(harness, "Why this energy target?", " New explicit goal ");
    await click(harness, "Create goal");
    const created = writes(requests)[2];
    expect(created.url.pathname).toBe("/v1/goals");
    expect(created.headers["if-match"]).toBeUndefined();
    expect(created.headers["idempotency-key"]).not.toBe(original.headers["idempotency-key"]);
    await click(harness, "Create goal");
    expect(writes(requests)[3].body).toBe(created.body);
    expect(writes(requests)[3].headers).toEqual(created.headers);
  });

  it("rejects retained New/Keep/Discard after synchronous edit ABA or target removal", async () => {
    const { harness } = setupNew();
    let tree = await newChoice(harness);
    const callbacks = [newLabel, "Keep editing", newDiscardLabel].map(
      (label) => button(tree, label).props.onPress,
    );
    const field = input(tree, "Protein target");
    field.props.onChangeText("123");
    field.props.onChangeText(field.props.value);
    let count = harness.stateWrites;
    callbacks.forEach((action) => {
      action();
    });
    expect(harness.stateWrites).toBe(count);
    tree = await click(harness, newLabel);
    const discard = button(tree, newDiscardLabel).props.onPress;
    nodes(
      tree,
      (node) => node.props?.accessibilityLabel === "Remove Protein target",
    )[0].props.onPress();
    count = harness.stateWrites;
    discard();
    expect(harness.stateWrites).toBe(count);
    expect(fields(await harness.settle())).not.toHaveProperty("Protein target");
  });

  it("allows only the latest New or Copy choice to replace a draft", async () => {
    const { harness } = setupNew();
    let tree = await newChoice(harness);
    const oldNew = button(tree, newDiscardLabel).props.onPress;
    const keepNew = button(tree, "Keep editing").props.onPress;
    tree = await click(harness, copyLabel);
    expect(hasButton(tree, newDiscardLabel)).toBe(false);
    let count = harness.stateWrites;
    oldNew();
    keepNew();
    expect(harness.stateWrites).toBe(count);
    const oldCopy = button(tree, discardLabel).props.onPress;
    tree = await click(harness, newLabel);
    expect(hasButton(tree, discardLabel)).toBe(false);
    count = harness.stateWrites;
    oldCopy();
    expect(harness.stateWrites).toBe(count);
    tree = await click(harness, newDiscardLabel);
    expect(input(tree, "Your selected daily energy (kcal)").props.value).toBe("");
  });

  for (const replacement of [
    { expectedOwnerUserId: "22222222-2222-4222-8222-222222222222" },
    { sessionEpoch: 2 },
    { profileRevision: "5" },
    { profileTimeZone: "UTC" },
    { accessToken: "replacement-synthetic-token" },
    { apiBase: new URL("http://127.0.0.1:4999") },
  ])
    it(`retires New confirmation across context ABA: ${Object.keys(replacement)[0]}`, async () => {
      const { harness, props } = setupNew();
      const tree = await newChoice(harness);
      const callbacks = [newLabel, "Keep editing", newDiscardLabel].map(
        (label) => button(tree, label).props.onPress,
      );
      harness.updateProps(replacement);
      harness.renderWithoutEffects();
      harness.updateProps(props);
      harness.renderWithoutEffects();
      const count = harness.stateWrites;
      callbacks.forEach((action) => {
        action();
      });
      expect(harness.stateWrites).toBe(count);
      harness.unmount();
    });

  it.each(["2026-09-19", "2026-09-20", "2026-09-21"])(
    "retires progress-date ABA and failed loads, recovering only from a fresh load (%s)",
    async (currentDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${currentDate}T12:00:00.000Z`));
      let fail = false;
      const { harness } = setupNew("manual", {
        handler: (request) =>
          fail && request.url.pathname === "/v1/nutrients/targetable"
            ? response({}, 503)
            : undefined,
      });
      let tree = await newChoice(harness);
      const old = [newLabel, newDiscardLabel].map((label) => button(tree, label).props.onPress);
      const date = input(tree, "Progress date YYYY-MM-DD");
      expect(date.props.value).toBe(currentDate);
      const changedDate = currentDate === "2026-09-20" ? "2026-09-21" : "2026-09-20";
      expect(changedDate).not.toBe(date.props.value);
      date.props.onChangeText(changedDate);
      date.props.onChangeText(date.props.value);
      let count = harness.stateWrites;
      old.forEach((action) => {
        action();
      });
      expect(harness.stateWrites).toBe(count);
      tree = await harness.settle();
      expect(button(tree, newLabel).props.accessibilityState).toEqual({ disabled: true });
      fail = true;
      tree = await click(harness, "Refresh goals and progress");
      expect(button(tree, newLabel).props.disabled).toBe(true);
      fail = false;
      tree = await click(harness, "Refresh goals and progress");
      expect(button(tree, newLabel).props.disabled).toBe(false);
      count = harness.stateWrites;
      old.forEach((action) => {
        action();
      });
      expect(harness.stateWrites).toBe(count);
    },
  );

  for (const work of ["goal", "profile", "candidate"])
    it(`retires retained New actions through ${work} requests, including completion`, async () => {
      const held = deferred();
      let hold = false;
      const { harness } = setupNew("manual", {
        handler: (request) =>
          hold &&
          ((work === "goal" && request.method === "POST") ||
            (work === "profile" && request.url.pathname === "/v1/profile") ||
            (work === "candidate" && request.url.pathname === "/v1/goals/reference-target-sets"))
            ? held.promise
            : undefined,
      });
      let tree = await newChoice(harness);
      const callbacks = [newLabel, "Keep editing", newDiscardLabel].map(
        (label) => button(tree, label).props.onPress,
      );
      hold = true;
      if (work === "candidate") input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
      else
        button(
          tree,
          work === "goal" ? "Publish goal revision" : "Save profile and check eligibility",
        ).props.onPress();
      let count = harness.stateWrites;
      callbacks.forEach((action) => {
        action();
      });
      expect(harness.stateWrites).toBe(count);
      tree = await harness.settle();
      expect(button(tree, newLabel).props.accessibilityState).toEqual({ disabled: true });
      held.resolve(response({}, work === "candidate" ? 404 : 503));
      tree = await harness.settle();
      count = harness.stateWrites;
      callbacks.forEach((action) => {
        action();
      });
      expect(harness.stateWrites).toBe(count);
      expect(hasButton(tree, newDiscardLabel)).toBe(false);
      tree = await click(harness, newLabel);
      expect(hasButton(tree, newDiscardLabel)).toBe(true);
    });

  it("rejects retained actions after unauthorized closure, unmount and effect replay", async () => {
    const { harness, props } = setupNew("manual", {
      handler: (request) => (request.method === "POST" ? response({}, 401) : undefined),
    });
    let tree = await newChoice(harness);
    const callbacks = [newLabel, "Keep editing", newDiscardLabel].map(
      (label) => button(tree, label).props.onPress,
    );
    await click(harness, "Publish goal revision");
    expect(props.onUnauthorized).toHaveBeenCalledOnce();
    let count = harness.stateWrites;
    callbacks.forEach((action) => {
      action();
    });
    expect(harness.stateWrites).toBe(count);
    harness.unmount();
    callbacks.forEach((action) => {
      action();
    });
    expect(harness.writesAfterUnmount).toBe(0);
    const replayed = setupNew();
    tree = await newChoice(replayed.harness);
    const oldNew = button(tree, newLabel).props.onPress;
    const oldDiscard = button(tree, newDiscardLabel).props.onPress;
    replayed.harness.replayEffects();
    await replayed.harness.settle();
    count = replayed.harness.stateWrites;
    oldNew();
    oldDiscard();
    expect(replayed.harness.stateWrites).toBe(count);
  });
});

const reloadConflictLabel = "Discard edits and reload saved goal";
const refreshGoalLabel = "Refresh goals and progress";
function conflictProfile() {
  return response({
    data: {
      profile: {
        displayName: null,
        locale: "en",
        timeZone: "America/Chicago",
        unitSystem: "metric",
        revision: "4",
        birthDate: "1999-01-02",
        sexAtBirth: "male",
      },
    },
  });
}
function setupConflict(kind = "manual", handler = () => undefined) {
  return setupNew(kind, {
    handler: (request, requests) => {
      const custom = handler(request, requests);
      if (custom !== undefined) return custom;
      if (request.method === "POST") return response({ code: "PRECONDITION_FAILED" }, 412);
      if (request.url.pathname === "/v1/profile") return conflictProfile();
      if (kind === "reference" && request.url.pathname === "/v1/goals/reference-target-sets") {
        const ref = referenceFixture();
        return response({ data: { ...ref.data, date: request.url.searchParams.get("date") } });
      }
      return undefined;
    },
  });
}
async function createConflict(harness) {
  await type(harness, "Why this energy target?", " Raw conflicting reason \r\nkept ");
  return click(harness, "Publish goal revision");
}

describe("native goal revision conflict draft preservation", () => {
  for (const kind of ["manual", "derived", "reference"])
    it(`preserves complete ${kind} draft and saved display on 412 without automatic reads`, async () => {
      const { harness, requests, props } = setupConflict(kind);
      let tree = await type(
        harness,
        "Why this energy target?",
        " Raw conflicting reason \r\nkept ",
      );
      await type(harness, "Birth date YYYY-MM-DD", "2000-02-03");
      if (kind === "manual") {
        await type(harness, "Your selected daily energy (kcal)", "1900.000099");
        await type(harness, "Protein target", "99.000000000001");
        await type(harness, "Protein source (required)", " raw changed source ");
      }
      tree = await harness.settle();
      const before = fields(tree);
      const gets = requests.filter((request) => request.method === "GET").length;
      tree = await click(harness, "Publish goal revision");
      expect(writes(requests)).toHaveLength(1);
      expect(fields(tree)).toEqual(before);
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(gets);
      expect(props.onProfileUpdated).not.toHaveBeenCalled();
      expect(text(tree)).toContain("Your edits are still here");
      expect(text(tree)).toContain("Saved goal and progress may be out of date");
      expect(hasButton(tree, refreshGoalLabel)).toBe(false);
      expect(button(tree, reloadConflictLabel).props.accessibilityState).toEqual({
        disabled: false,
      });
      if (kind === "reference") {
        expect(input(tree, "Nutrient 1 target").props.editable).toBe(false);
        expect(text(tree)).toContain("Verified on this goal");
        expect(JSON.parse(writes(requests)[0].body)).toHaveProperty("referenceTargetSet");
      }
    });

  it("retains edits and explicit recovery after a failed reload, then uses the freshly loaded revision", async () => {
    let conflict = false;
    let fail = false;
    const latest = savedGoal([nutrient, sodium], { revision: "4" });
    latest.currentVersion.versionNumber = 4;
    latest.currentVersion.energy.rationale = "New saved rationale";
    const { harness, requests } = setupConflict("manual", (request) => {
      if (request.method === "POST") conflict = true;
      if (conflict && request.url.pathname === "/v1/goals/current")
        return response({ data: { goal: latest } });
      if (fail && request.url.pathname === "/v1/nutrients/targetable") return response({}, 503);
    });
    let tree = await createConflict(harness);
    const before = fields(tree);
    const operations = hooks.operation;
    fail = true;
    tree = await click(harness, reloadConflictLabel);
    expect(fields(tree)).toEqual(before);
    expect(button(tree, reloadConflictLabel).props.disabled).toBe(false);
    expect(hooks.operation).toBe(operations);
    expect(writes(requests)).toHaveLength(1);
    fail = false;
    tree = await click(harness, reloadConflictLabel);
    expect(input(tree, "Why this energy target?").props.value).toBe("New saved rationale");
    expect(hasButton(tree, reloadConflictLabel)).toBe(false);
    expect(hasButton(tree, refreshGoalLabel)).toBe(true);
    expect(hooks.operation).toBe(operations);
    await click(harness, "Publish goal revision");
    expect(writes(requests)[1].headers["if-match"]).toBe('"4"');
  });

  it("retires definitive 412 keys but preserves exact 503 retries without rebasing", async () => {
    let status = 412;
    const { harness, requests } = setupConflict("manual", (request) =>
      request.method === "POST" ? response({}, status) : undefined,
    );
    await createConflict(harness);
    const first = writes(requests)[0];
    await click(harness, "Publish goal revision");
    const second = writes(requests)[1];
    expect(second.body).toBe(first.body);
    expect(second.headers["if-match"]).toBe('"3"');
    expect(second.headers["idempotency-key"]).not.toBe(first.headers["idempotency-key"]);
    status = 503;
    await click(harness, "Publish goal revision");
    const ambiguous = writes(requests)[2];
    expect(ambiguous.headers["idempotency-key"]).not.toBe(second.headers["idempotency-key"]);
    await click(harness, "Publish goal revision");
    expect(writes(requests)[3].body).toBe(ambiguous.body);
    expect(writes(requests)[3].headers).toEqual(ambiguous.headers);
    expect(ambiguous.body).toBe(first.body);
  });

  it("rejects the retained ambiguous Refresh before repaint once a conflict is received", async () => {
    const held = deferred();
    const { harness, requests } = setupConflict("manual", (request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    const tree = await type(harness, "Why this energy target?", " Unsaved reason ");
    const refresh = button(tree, refreshGoalLabel).props.onPress;
    const save = button(tree, "Publish goal revision").props.onPress();
    held.resolve(response({}, 412));
    await save;
    const count = requests.length;
    const state = harness.stateWrites;
    refresh();
    expect(requests).toHaveLength(count);
    expect(harness.stateWrites).toBe(state);
    expect(hasButton(await harness.settle(), reloadConflictLabel)).toBe(true);
  });

  it("keeps conflict intent through edits while rejecting old recovery after draft ABA", async () => {
    const { harness, requests } = setupConflict();
    let tree = await createConflict(harness);
    const old = button(tree, reloadConflictLabel).props.onPress;
    const field = input(tree, "Protein target");
    field.props.onChangeText("123");
    field.props.onChangeText(field.props.value);
    const count = requests.length;
    old();
    expect(requests).toHaveLength(count);
    tree = await harness.settle();
    expect(button(tree, reloadConflictLabel).props.disabled).toBe(false);
    await click(harness, reloadConflictLabel);
    expect(requests.length).toBeGreaterThan(count);
  });

  it.each(["2026-09-19", "2026-09-20", "2026-09-21"])(
    "retires recovery after progress-date ABA without disabling a current explicit reload (%s)",
    async (currentDate) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${currentDate}T12:00:00.000Z`));
      const { harness, requests } = setupConflict();
      let tree = await createConflict(harness);
      const old = button(tree, reloadConflictLabel).props.onPress;
      const date = input(tree, "Progress date YYYY-MM-DD");
      expect(date.props.value).toBe(currentDate);
      const changedDate = currentDate === "2026-09-20" ? "2026-09-21" : "2026-09-20";
      expect(changedDate).not.toBe(date.props.value);
      date.props.onChangeText(changedDate);
      date.props.onChangeText(date.props.value);
      const count = requests.length;
      old();
      expect(requests).toHaveLength(count);
      tree = await harness.settle();
      expect(button(tree, reloadConflictLabel).props.disabled).toBe(false);
      await click(harness, reloadConflictLabel);
      expect(hasButton(await harness.settle(), reloadConflictLabel)).toBe(false);
    },
  );

  for (const work of ["goal", "profile", "candidate"])
    it(`retires old recovery through ${work} work and failed completion`, async () => {
      let hold = false;
      const held = deferred();
      const { harness, requests } = setupConflict("manual", (request) =>
        hold &&
        ((work === "goal" && request.method === "POST") ||
          (work === "profile" && request.method === "PATCH") ||
          (work === "candidate" && request.url.pathname === "/v1/goals/reference-target-sets"))
          ? held.promise
          : undefined,
      );
      let tree = await createConflict(harness);
      const old = button(tree, reloadConflictLabel).props.onPress;
      hold = true;
      if (work === "candidate") input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
      else
        button(
          tree,
          work === "goal" ? "Publish goal revision" : "Save profile and check eligibility",
        ).props.onPress();
      let count = requests.length;
      old();
      expect(requests).toHaveLength(count);
      tree = await harness.settle();
      expect(button(tree, reloadConflictLabel).props.accessibilityState).toEqual({
        disabled: true,
      });
      held.resolve(response({}, work === "candidate" ? 404 : 503));
      tree = await harness.settle();
      count = requests.length;
      old();
      expect(requests).toHaveLength(count);
      expect(button(tree, reloadConflictLabel).props.disabled).toBe(false);
    });

  for (const replacement of [
    { sessionEpoch: 2 },
    { profileRevision: "5" },
    { apiBase: new URL("http://127.0.0.1:4999") },
  ])
    it(`rejects recovery after private/profile scope ABA: ${Object.keys(replacement)[0]}`, async () => {
      const { harness, requests, props } = setupConflict();
      const tree = await createConflict(harness);
      const old = button(tree, reloadConflictLabel).props.onPress;
      harness.updateProps(replacement);
      harness.renderWithoutEffects();
      harness.updateProps(props);
      harness.renderWithoutEffects();
      const count = requests.length;
      old();
      expect(requests).toHaveLength(count);
      harness.unmount();
      old();
      expect(harness.writesAfterUnmount).toBe(0);
    });

  it("rejects recovery on private closure and after effect replay", async () => {
    let status = 412;
    const { harness, requests, props } = setupConflict("manual", (request) =>
      request.method === "POST" ? response({}, status) : undefined,
    );
    const tree = await createConflict(harness);
    const old = button(tree, reloadConflictLabel).props.onPress;
    status = 401;
    await click(harness, "Publish goal revision");
    expect(props.onUnauthorized).toHaveBeenCalledOnce();
    let count = requests.length;
    old();
    expect(requests).toHaveLength(count);
    harness.replayEffects();
    await harness.settle();
    count = requests.length;
    old();
    expect(requests).toHaveLength(count);
  });

  for (const action of ["new", "copy"])
    it(`retires conflict only after confirmed ${action} replacement`, async () => {
      const { harness, requests } = setupConflict();
      let tree = await createConflict(harness);
      const old = button(tree, reloadConflictLabel).props.onPress;
      const target = action === "new" ? newLabel : copyLabel;
      await click(harness, target);
      tree = await click(harness, "Keep editing");
      expect(hasButton(tree, reloadConflictLabel)).toBe(true);
      await click(harness, target);
      tree = await click(harness, action === "new" ? newDiscardLabel : discardLabel);
      expect(hasButton(tree, reloadConflictLabel)).toBe(false);
      expect(hasButton(tree, refreshGoalLabel)).toBe(true);
      const count = requests.length;
      old();
      expect(requests).toHaveLength(count);
    });

  for (const code of ["GOAL_OWNER_CHANGED", "PROFILE_OWNER_CHANGED", "GOAL_PROFILE_CHANGED"])
    it(`preserves existing 409 ${code} behavior`, async () => {
      const { harness, requests, props } = setupConflict("manual", (request) =>
        request.method === "POST" ? response({ code }, 409) : undefined,
      );
      await createConflict(harness);
      if (code === "GOAL_PROFILE_CHANGED") {
        expect(props.onUnauthorized).not.toHaveBeenCalled();
        expect(props.onProfileUpdated).toHaveBeenCalledOnce();
        expect(
          requests.filter((request) => request.url.pathname === "/v1/goals/current"),
        ).toHaveLength(2);
      } else {
        expect(props.onUnauthorized).toHaveBeenCalledOnce();
        expect(requests.filter((request) => request.url.pathname === "/v1/profile")).toHaveLength(
          0,
        );
      }
    });
});

for (const replacement of [{ profileRevision: "5" }, { apiBase: new URL("http://127.0.0.1:4999") }])
  it(`does not install delayed 412 conflict metadata into changed ${Object.keys(replacement)[0]} context`, async () => {
    const held = deferred();
    const { harness, requests, props } = setupConflict("manual", (request) =>
      request.method === "POST" ? held.promise : undefined,
    );
    const tree = await type(harness, "Why this energy target?", " Retain raw draft ");
    const save = button(tree, "Publish goal revision").props.onPress();
    harness.updateProps(replacement);
    harness.renderWithoutEffects();
    const count = requests.length;
    held.resolve(response({}, 412));
    await save;
    const after = harness.renderWithoutEffects();
    expect(requests).toHaveLength(count);
    expect(input(after, "Why this energy target?").props.value).toBe(" Retain raw draft ");
    expect(hasButton(after, reloadConflictLabel)).toBe(false);
    expect(text(after)).not.toContain("Your edits are still here");
    expect(props.onProfileUpdated).not.toHaveBeenCalled();
    harness.unmount();
  });

for (const conflicted of [false, true])
  it(`reenables ${conflicted ? "conflict recovery" : "ordinary Refresh"} after repeated candidate 404 renders`, async () => {
    let held = null;
    const { harness, requests } = setupConflict("manual", (request) =>
      held && request.url.pathname === "/v1/goals/reference-target-sets" ? held.promise : undefined,
    );
    let tree = conflicted ? await createConflict(harness) : await harness.settle();
    const label = conflicted ? reloadConflictLabel : refreshGoalLabel;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      held = deferred();
      input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
      tree = await harness.settle();
      expect(button(tree, label).props.accessibilityState).toEqual({ disabled: true });
      const disabled = button(tree, label).props.onPress;
      held.resolve(response({}, 404));
      tree = await harness.settle();
      expect(button(tree, label).props.accessibilityState).toEqual({ disabled: false });
      const count = requests.length;
      disabled();
      expect(requests).toHaveLength(count);
    }
    held = deferred();
    input(tree, "Effective from YYYY-MM-DD").props.onEndEditing();
    await harness.settle();
    harness.unmount();
    held.resolve(response({}, 404));
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    expect(harness.writesAfterUnmount).toBe(0);
  });
