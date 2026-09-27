import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalProgressView } from "../../lib/recipes-goals";

// Runs the actual component and its effects with deterministic synchronous hooks.
// This observes request/state transitions; browser layout and concurrent React are
// separate acceptance evidence, not claims made by this harness.
const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    effect?: (() => undefined | (() => void)) | undefined;
  }
  let slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let closed = false;
  let afterClose = 0;
  let effects: Array<() => void> = [];
  let component: () => unknown;
  let tree: unknown;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((item, index) => Object.is(item, b[index]));
  const render = (runEffects = true) => {
    cursor = 0;
    dirty = false;
    tree = component();
    if (!runEffects) return;
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
  };
  return {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const slot = slots[index] as Slot;
      return [
        slot.value as T,
        (change: T | ((current: T) => T)) => {
          if (closed) afterClose += 1;
          const next =
            typeof change === "function" ? (change as (current: T) => T)(slot.value as T) : change;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return old.value as T;
      const value = factory();
      slots[index] = { value, deps };
      return value;
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index];
      if (old && same(old.deps, deps)) return;
      const slot: Slot = { ...(deps ? { deps } : {}), effect };
      slots[index] = slot;
      effects.push(() => {
        old?.cleanup?.();
        slot.cleanup = effect();
      });
    },
    replayEffects() {
      const mountedEffects = slots.filter((slot) => slot.effect);
      for (const slot of mountedEffects) slot.cleanup?.();
      for (const slot of mountedEffects) slot.cleanup = slot.effect?.();
    },
    mount(next: () => unknown) {
      slots = [];
      effects = [];
      closed = false;
      afterClose = 0;
      component = next;
      render();
    },
    render,
    renderWithoutEffects: () => render(false),
    async settle() {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty && !closed) render();
      }
    },
    tree: () => tree,
    afterClose: () => afterClose,
    unmount() {
      if (closed) return;
      closed = true;
      for (const slot of slots) slot.cleanup?.();
    },
  };
});

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const navigation = vi.hoisted(() => ({ query: "date=2026-09-11" }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T, deps: readonly unknown[]) => hooks.useMemo(() => callback, deps),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

import { GoalsClient } from "./GoalsClient";

interface ElementNode {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}
function elements(value: unknown = hooks.tree()): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item ?? null));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ElementNode;
  return [node, ...elements(node.props.children ?? null)];
}
function text(value: unknown = hooks.tree()): string {
  if (Array.isArray(value)) return value.map((item) => text(item ?? null)).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || !("props" in value)) return "";
  return text((value as ElementNode).props.children ?? null);
}
function button(label: string): ElementNode {
  const found = elements().find((node) => node.type === "button" && text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function field(label: string): ElementNode {
  const direct = elements().find((node) => node.props["aria-label"] === label);
  if (direct) return direct;
  const wrapper = elements().find(
    (node) =>
      node.type === "label" &&
      (text(node).trim().startsWith(label) ||
        elements(node.props.children).some(
          (child) => child.type === "span" && text(child) === label,
        )),
  );
  const found =
    wrapper &&
    (wrapper.props.htmlFor
      ? elements().find((node) => node.props.id === wrapper.props.htmlFor)
      : elements(wrapper.props.children).find((node) =>
          ["input", "select", "textarea"].includes(String(node.type)),
        ));
  if (!found) throw new Error(`Missing field: ${label}`);
  return found;
}
function invoke(node: ElementNode, action: string, ...args: unknown[]) {
  return (node.props[action] as (...values: unknown[]) => unknown)(...args);
}
async function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  void invoke(node, "onClick");
  await hooks.settle();
}
async function change(label: string, value: string) {
  invoke(field(label), "onChange", { target: { value } });
  await hooks.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture or observed call is missing.");
  return value;
}
const owner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
function session(id = owner) {
  return Response.json({
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

const day = "2026-09-11";
const notice = "General wellness estimate; not medical advice.";
const registry = [
  { id: "1087", name: "Calcium", code: "CALCIUM", unit: "mg", category: "mineral" },
  { id: "1090", name: "Magnesium", code: "MAGNESIUM", unit: "mg", category: "mineral" },
  { id: "1162", name: "Vitamin C", code: "VITAMIN_C", unit: "mg", category: "vitamin" },
];
function savedGoal(definitions = [required(registry[0])], revision = "3") {
  return {
    id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
    status: "active",
    effectiveFrom: day,
    effectiveTo: null as string | null,
    revision,
    createdAt: `${day}T12:00:00.000Z`,
    updatedAt: `${day}T12:00:00.000Z`,
    notice,
    currentVersion: {
      id: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
      versionNumber: Number(revision),
      createdAt: `${day}T12:00:00.000Z`,
      energy: {
        mode: "fixed",
        targetKcal: "2100.00",
        source: { code: "user-fixed", version: "1" },
        rationale: " Saved rationale. ",
      },
      nutrientTargets: definitions.map((definition) => ({
        definition,
        minimumAmount: "0.00",
        targetAmount: "100.0000",
        maximumAmount: null,
        source: { label: " Saved source ", version: " v1 " },
        rationale: " Saved target rationale ",
      })),
    },
  };
}
type GoalWire = ReturnType<typeof savedGoal>;
function progress(localDate = day) {
  return {
    data: {
      localDate,
      timeZone: "America/Chicago",
      diaryRevision: "0",
      goal: null,
      energy: null,
      nutrients: [],
      notice,
    },
  };
}
interface RequestCall {
  path: string;
  init: RequestInit | undefined;
}
type Intercept = (call: RequestCall) => Response | Promise<Response> | undefined;
async function workspace(
  options: { definitions?: typeof registry; goal?: GoalWire | null; intercept?: Intercept } = {},
) {
  const calls: RequestCall[] = [];
  let currentGoal = options.goal ?? null;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const call = { path, init };
    calls.push(call);
    const intercepted = options.intercept?.(call);
    if (intercepted !== undefined) return intercepted;
    if (path === "/api/auth/me") return session();
    if (path.startsWith("/api/goals/current?"))
      return Response.json({ data: { goal: currentGoal } });
    if (path.startsWith("/api/goals/progress?"))
      return Response.json(
        progress(new URL(path, "https://fixture.test").searchParams.get("date") ?? day),
      );
    if (path === "/api/nutrients/targetable")
      return Response.json({ data: options.definitions ?? registry });
    if (path.startsWith("/api/goals/reference-target-sets?"))
      return Response.json({ message: "Unavailable" }, { status: 404 });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  hooks.mount(GoalsClient);
  await hooks.settle();
  return {
    calls,
    fetcher,
    setGoal: (value: GoalWire | null) => {
      currentGoal = value;
    },
  };
}
function options() {
  return elements(field("Nutrient to add")).filter(
    (node) => node.type === "option" && node.props.value !== "",
  );
}
function targetRows() {
  return elements().filter((node) => node.props.className === "goalTargetRow");
}
function rawEditor() {
  return elements()
    .filter(
      (node) =>
        ["input", "textarea", "select"].includes(String(node.type)) &&
        node.props["aria-label"] !== "Nutrient to add" &&
        node !== field("Find a nutrient"),
    )
    .map((node) => [node.props["aria-label"], node.props.value, node.props.checked]);
}
function status() {
  return text(required(elements().find((node) => node.props.className === "workspaceStatus")));
}
function submit() {
  return invoke(required(elements().find((node) => node.type === "form")), "onSubmit", {
    preventDefault() {},
  });
}
function writes(calls: RequestCall[]) {
  return calls.filter((call) => call.init?.method === "POST");
}
function pickerControls() {
  return {
    query: field("Find a nutrient"),
    clear: button("Clear nutrient search"),
    select: field("Nutrient to add"),
    add: button("Add nutrient"),
  };
}
function invokeOldPicker(old: ReturnType<typeof pickerControls>) {
  invoke(old.query, "onChange", { target: { value: "old query" } });
  invoke(old.clear, "onClick");
  invoke(old.select, "onChange", { target: { value: "1162" } });
  invoke(old.add, "onClick");
}
beforeEach(() => {
  navigation.query = `date=${day}`;
  router.replace.mockClear();
  router.refresh.mockClear();
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function referenceFixture() {
  const macrosUrl =
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html";
  const elementsUrl =
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html";
  const vitaminsUrl =
    "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html";
  const rows = [
    ["carbohydrate", "g", "130", null, "rda", null, "IOM-2005", macrosUrl, "Table 1"],
    ["protein", "g", "56", null, "rda", null, "IOM-2005", macrosUrl, "Table 1"],
    ["fiber", "g", "38", null, "ai", null, "IOM-2005", macrosUrl, "Table 1"],
    ["sodium", "mg", "1500", null, "ai", null, "NASEM-2019", elementsUrl, "Table 3"],
    ["potassium", "mg", "3400", null, "ai", null, "NASEM-2019", elementsUrl, "Table 3"],
    ["calcium", "mg", "1000", "2500", "rda", "ul", "IOM-2011", elementsUrl, "Table 1"],
    ["iron", "mg", "8", "45", "rda", "ul", "IOM-2001", elementsUrl, "Table 2"],
    ["vitamin-c", "mg", "90", "2000", "rda", "ul", "IOM-2000", vitaminsUrl, "Table 2"],
    ["vitamin-d", "ug", "15", "100", "rda", "ul", "IOM-2011", vitaminsUrl, "Table 1"],
    ["vitamin-b12", "ug", "2.4", null, "rda", null, "IOM-1998", vitaminsUrl, "Table 3"],
    ["folate-dfe", "ug_DFE", "400", null, "rda", null, "IOM-1998", vitaminsUrl, "Table 3"],
    ["vitamin-a-rae", "ug_RAE", "900", null, "rda", null, "IOM-2001", vitaminsUrl, "Table 1"],
  ] as const;
  const targets = rows.map((row, index) => ({
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
  }));
  return {
    data: {
      date: day,
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
          targets,
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
        overviewUrl:
          "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables.html",
        macronutrientsUrl: macrosUrl,
        elementsUrl,
        vitaminsUrl,
        reportListUrl:
          "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/dietary-reference-intake-report-list.html",
      },
      cautions: [{ code: "general-wellness", text: "Not individualized medical advice." }],
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
          targets,
        },
      },
      notice:
        "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status.",
    },
  };
}

describe("web goal nutrient search", () => {
  it("shows every bounded loaded choice in source order with exact identity/name/unit", async () => {
    const definitions = Array.from({ length: 256 }, (_, index) => ({
      id: String(index + 1),
      name: index < 2 ? "Same name" : `Nutrient ${index} ${"x".repeat(100)}`,
      code: `CODE_${index}`,
      unit: index === 1 ? "ug" : "mg",
      category: "other",
    }));
    const { calls } = await workspace({ definitions });
    expect(options().map((node) => node.props.value)).toEqual(definitions.map((item) => item.id));
    expect(options().map(text)).toEqual(definitions.map((item) => `${item.name} (${item.unit})`));
    expect(text()).toContain("256 matching · 256 available · 256 loaded");
    const count = calls.length;
    await change("Find a nutrient", "  code_255  ");
    expect(options().map((node) => node.props.value)).toEqual(["256"]);
    await click("Add nutrient");
    expect(text(targetRows())).toContain(definitions[255]?.name);
    expect(calls).toHaveLength(count);
  });

  it("matches literal names/codes case-insensitively, trims only for matching, excludes units", async () => {
    const { calls } = await workspace();
    const count = calls.length;
    await change("Find a nutrient", "  vItAmIn_c  ");
    expect(field("Find a nutrient").props.value).toBe("  vItAmIn_c  ");
    expect(options().map((node) => node.props.value)).toEqual(["1162"]);
    for (const query of ["mg", ".*", "[", "absent"]) {
      await change("Find a nutrient", query);
      expect(options()).toEqual([]);
      expect(field("Nutrient to add").props.value).toBe("");
      expect(button("Add nutrient").props.disabled).toBe(true);
      expect(text()).toContain("No available nutrients match this search.");
    }
    await change("Find a nutrient", "x".repeat(120));
    expect(field("Find a nutrient").props.value).toBe("x".repeat(100));
    expect(field("Find a nutrient").props.maxLength).toBe(100);
    expect(calls).toHaveLength(count);
  });

  it("uses the visible fallback for Add and restores hidden preferred selection on Clear", async () => {
    await workspace();
    await change("Nutrient to add", "1162");
    await change("Find a nutrient", "calcium");
    expect(field("Nutrient to add").props.value).toBe("1087");
    await click("Add nutrient");
    expect(text(targetRows())).toContain("Calcium");
    expect(text(targetRows())).not.toContain("Vitamin C");
    await click("Clear nutrient search");
    expect(field("Nutrient to add").props.value).toBe("1162");
    expect(options().map((node) => node.props.value)).toEqual(["1090", "1162"]);
    await click("Remove");
    expect(options().map((node) => node.props.value)).toEqual(["1087", "1090", "1162"]);
  });

  it.each(["initial", "hidden preferred"])(
    "same-current %s selection/query/Clear keep current Add usable",
    async (mode) => {
      const { calls } = await workspace();
      if (mode === "hidden preferred") {
        await change("Nutrient to add", "1162");
        await change("Find a nutrient", "calcium");
      }
      const old = pickerControls();
      const count = calls.length;
      invoke(old.select, "onChange", { target: { value: "1087" } });
      invoke(old.query, "onChange", { target: { value: mode === "initial" ? "" : "calcium" } });
      if (mode === "initial") {
        invoke(old.clear, "onClick");
        invoke(old.clear, "onClick");
      }
      invoke(old.add, "onClick");
      await hooks.settle();
      expect(targetRows()).toHaveLength(1);
      expect(calls).toHaveLength(count);
      expect(button("Clear nutrient search").props.disabled).toBe(false);
    },
  );

  it.each(["query", "selection"])(
    "rejects retained picker controls across %s A-to-B-to-A",
    async (kind) => {
      await workspace();
      const old = pickerControls();
      if (kind === "query") {
        await change("Find a nutrient", "calcium");
        await click("Clear nutrient search");
      } else {
        await change("Nutrient to add", "1162");
        await change("Nutrient to add", "1087");
      }
      invokeOldPicker(old);
      await hooks.settle();
      expect(field("Find a nutrient").props.value).toBe("");
      expect(field("Nutrient to add").props.value).toBe("1087");
      expect(targetRows()).toEqual([]);
    },
  );

  it("rejects hidden Add before paint and raw-edit/replaced-builder Add without restoring fields", async () => {
    await workspace({ goal: savedGoal() });
    const hidden = button("Add nutrient");
    invoke(field("Find a nutrient"), "onChange", { target: { value: "absent" } });
    invoke(hidden, "onClick");
    await hooks.settle();
    expect(targetRows()).toHaveLength(1);
    await click("Clear nutrient search");
    const stale = button("Add nutrient");
    invoke(field("Why this energy target?"), "onChange", {
      target: { value: " Raw new rationale " },
    });
    invoke(stale, "onClick");
    await hooks.settle();
    expect(field("Why this energy target?").props.value).toBe(" Raw new rationale ");
    expect(targetRows()).toHaveLength(1);
    const beforeNew = button("Add nutrient");
    await click("New goal");
    invoke(button(discardNewGoalLabel), "onClick");
    invoke(beforeNew, "onClick");
    await hooks.settle();
    expect(targetRows()).toHaveLength(0);
  });

  it("prevents double Add in the same paint and maintains exact duplicate/cap semantics", async () => {
    await workspace();
    const add = button("Add nutrient");
    invoke(add, "onClick");
    invoke(add, "onClick");
    await hooks.settle();
    expect(targetRows()).toHaveLength(1);
    expect(options().map((node) => node.props.value)).toEqual(["1090", "1162"]);
    hooks.unmount();
    const definitions = Array.from({ length: 256 }, (_, i) => ({
      id: String(i + 1),
      name: `Item ${i}`,
      code: `C_${i}`,
      unit: "mg",
      category: "other",
    }));
    await workspace({ definitions: [required(registry[0])], goal: savedGoal(definitions) });
    expect(options()).toHaveLength(1);
    expect(button("Add nutrient").props.disabled).toBe(true);
    invoke(button("Add nutrient"), "onClick");
    await hooks.settle();
    expect(targetRows()).toHaveLength(256);
  });

  it("distinguishes empty registry and all-added from loading and errors", async () => {
    const delayed = deferred<Response>();
    await workspace({
      intercept: ({ path }) => (path === "/api/nutrients/targetable" ? delayed.promise : undefined),
    });
    expect(text()).toContain("Loading nutrients…");
    expect(text()).not.toContain("All loaded nutrients");
    expect(button("Clear nutrient search").props.disabled).toBe(true);
    delayed.resolve(Response.json({ message: "Fixture unavailable" }, { status: 503 }));
    await hooks.settle();
    expect(text()).toContain("No nutrients are loaded.");
    expect(status()).toBe("Targetable nutrients could not be loaded.");
    expect(button("Add nutrient").props.disabled).toBe(true);
    hooks.unmount();
    await workspace({ definitions: [] });
    expect(text()).toContain("0 matching · 0 available · 0 loaded");
    expect(text()).toContain("No nutrients are loaded.");
    hooks.unmount();
    await workspace({ goal: savedGoal(registry) });
    expect(text()).toContain("All loaded nutrients are already in this draft.");
    expect(text()).toContain("0 matching · 0 available · 3 loaded");
  });

  it("preserves all raw goal and target/source fields, message and requests while searching", async () => {
    const { calls } = await workspace({ goal: savedGoal() });
    await change("Calcium target source", " Raw source ");
    await change("Calcium source version", " draft version ");
    await change("Calcium rationale", " Raw rationale ");
    await change("Calcium target mg", "999.000000000001");
    await change("Why this energy target?", " Raw energy rationale ");
    const before = rawEditor(),
      message = status(),
      count = calls.length;
    await change("Find a nutrient", "VITAMIN");
    await change("Nutrient to add", "1162");
    await click("Clear nutrient search");
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    expect(calls).toHaveLength(count);
  });

  it("preserves query through New and same-private reload while a date change is only proposed", async () => {
    const { calls } = await workspace({ goal: savedGoal() });
    await change("Find a nutrient", "  vitamin ");
    await click("New goal");
    expect(field("Find a nutrient").props.value).toBe("  vitamin ");
    hooks.replayEffects();
    await hooks.settle();
    expect(field("Find a nutrient").props.value).toBe("  vitamin ");
    const count = calls.length,
      old = pickerControls();
    invoke(field("Progress date"), "onChange", { target: { value: "2026-09-12" } });
    invokeOldPicker(old);
    await hooks.settle();
    expect(field("Find a nutrient").props.value).toBe("  vitamin ");
    expect(button("Add nutrient").props.disabled).toBe(true);
    expect(calls).toHaveLength(count);
  });

  it("blocks retained and rendered picker controls on external route before effects and unmount", async () => {
    const { calls } = await workspace();
    await change("Find a nutrient", "calcium");
    const old = pickerControls(),
      count = calls.length;
    navigation.query = "date=2026-09-12";
    hooks.renderWithoutEffects();
    expect(button("Add nutrient").props.disabled).toBe(true);
    invokeOldPicker(old);
    invokeOldPicker(pickerControls());
    await hooks.settle();
    expect(targetRows()).toHaveLength(0);
    expect(calls).toHaveLength(count);
    hooks.unmount();
    const after = hooks.afterClose();
    invokeOldPicker(old);
    expect(hooks.afterClose()).toBe(after);
  });

  it.each(["owner", "profile", "expiry"])(
    "resets query and fences old callbacks on %s replacement",
    async (mode) => {
      let next = false;
      await workspace({
        intercept: ({ path }) => {
          if (path !== "/api/auth/me" || !next) return undefined;
          if (mode === "expiry") return Response.json({}, { status: 401 });
          return session(mode === "owner" ? "217e6c14-c82b-4451-a81e-2495863a3f64" : owner)
            .json()
            .then((body) => {
              if (mode === "profile") body.data.profile.revision = "5";
              return Response.json(body);
            });
        },
      });
      expect(button("Add nutrient").props.disabled).toBe(false);
      await change("Find a nutrient", "vitamin");
      expect(field("Find a nutrient").props.value).toBe("vitamin");
      const old = pickerControls();
      next = true;
      hooks.replayEffects();
      await hooks.settle();
      invokeOldPicker(old);
      await hooks.settle();
      expect(field("Find a nutrient").props.value).toBe("");
      expect(targetRows()).toHaveLength(0);
      if (mode === "expiry") {
        expect(router.replace).toHaveBeenCalledWith("/login");
        expect(button("Add nutrient").props.disabled).toBe(true);
      }
    },
  );

  it("keeps historical goals locked while New makes the retained search available", async () => {
    const goal = savedGoal();
    goal.effectiveTo = "2026-09-12";
    await workspace({ goal });
    expect(button("Add nutrient").props.disabled).toBe(true);
    invokeOldPicker(pickerControls());
    await hooks.settle();
    expect(targetRows()).toHaveLength(1);
    await click("New goal");
    expect(button("Add nutrient").props.disabled).toBe(false);
  });

  it.each(["create", "revision"])(
    "preserves exact %s body/key through filtering and A-to-B-to-A ambiguous retries",
    async (kind) => {
      const { calls } = await workspace({
        goal: kind === "revision" ? savedGoal() : null,
        intercept: ({ init }) =>
          init?.method === "POST"
            ? Response.json({ message: "Ambiguous fixture write" }, { status: 503 })
            : undefined,
      });
      if (kind === "create") {
        await change("Daily energy (kcal)", "2100.00");
        await change("Why this energy target?", " Saved rationale. ");
      }
      await submit();
      await hooks.settle();
      const message = status(),
        first = required(writes(calls)[0]);
      await change("Find a nutrient", "vitamin");
      await click("Clear nutrient search");
      expect(status()).toBe(message);
      await submit();
      await hooks.settle();
      await change("Why this energy target?", " Different body ");
      await submit();
      await hooks.settle();
      await change("Why this energy target?", " Saved rationale. ");
      await submit();
      await hooks.settle();
      const posts = writes(calls);
      expect(posts).toHaveLength(4);
      expect(posts[1]?.init?.body).toBe(first.init?.body);
      expect(posts[3]?.init?.body).toBe(first.init?.body);
      const key = (call: RequestCall) => new Headers(call.init?.headers).get("idempotency-key");
      expect(key(required(posts[1]))).toBe(key(first));
      expect(key(required(posts[3]))).toBe(key(first));
      expect(key(required(posts[2]))).not.toBe(key(first));
      expect(first.path).toBe(
        kind === "create" ? "/api/goals" : `/api/goals/${savedGoal().id}/revisions`,
      );
      expect(new Headers(first.init?.headers).get("if-match")).toBe(
        kind === "create" ? null : '"3"',
      );
      expect(JSON.parse(String(first.init?.body))).toMatchObject({
        energy: { targetKcal: "2100.00", rationale: " Saved rationale. " },
      });
    },
  );

  it("blocks picker immediately during writes and preserves accepted receipt/reload behavior", async () => {
    const pendingWrite = deferred<Response>();
    const result = await workspace({
      goal: savedGoal(),
      intercept: ({ init }) => (init?.method === "POST" ? pendingWrite.promise : undefined),
    });
    await change("Find a nutrient", "vitamin");
    const old = pickerControls();
    void submit();
    invokeOldPicker(old);
    await hooks.settle();
    expect(button("Clear nutrient search").props.disabled).toBe(true);
    expect(field("Find a nutrient").props.value).toBe("vitamin");
    expect(targetRows()).toHaveLength(1);
    const next = savedGoal(undefined, "4");
    result.setGoal(next);
    pendingWrite.resolve(Response.json({ data: { replayed: true, goal: next } }));
    await hooks.settle();
    expect(status()).toBe("The earlier goal save was confirmed safely.");
    expect(text()).toContain("GOAL REVISION 4");
    expect(field("Find a nutrient").props.value).toBe("vitamin");
    expect(writes(result.calls)).toHaveLength(1);
  });
});

describe("goal nutrient picker availability", () => {
  it.each(["2026-09-12", "invalid"])(
    "withholds current and old picker after raw progress date %s until accepted load",
    async (nextDate) => {
      const { calls } = await workspace();
      await change("Find a nutrient", "vitamin");
      const old = pickerControls(),
        count = calls.length;
      await change("Progress date", nextDate);
      expect(field("Find a nutrient").props.value).toBe("vitamin");
      expect(button("Clear nutrient search").props.disabled).toBe(true);
      invokeOldPicker(old);
      invokeOldPicker(pickerControls());
      await hooks.settle();
      expect(targetRows()).toHaveLength(0);
      expect(calls).toHaveLength(count);
      await change("Progress date", day);
      expect(button("Add nutrient").props.disabled).toBe(true);
      invoke(field("Progress date"), "onBlur");
      await hooks.settle();
      expect(button("Add nutrient").props.disabled).toBe(false);
      await click("Add nutrient");
      expect(targetRows()).toHaveLength(1);
    },
  );

  it.each(["auth", "load"])(
    "blocks old picker during same-scope %s read before paint and while pending",
    async (phase) => {
      let reading = false;
      const pending = deferred<Response>();
      const result = await workspace({
        intercept: ({ path }) =>
          reading && path === (phase === "auth" ? "/api/auth/me" : "/api/nutrients/targetable")
            ? pending.promise
            : undefined,
      });
      await change("Find a nutrient", "vitamin");
      const old = pickerControls();
      reading = true;
      if (phase === "auth") hooks.replayEffects();
      else invoke(field("Progress date"), "onBlur");
      invokeOldPicker(old);
      await hooks.settle();
      // Effect replay itself schedules no render while auth is deferred. Inspect
      // the newly rendered availability separately from the retained callbacks.
      hooks.render();
      expect(field("Find a nutrient").props.value).toBe("vitamin");
      expect(targetRows()).toHaveLength(0);
      expect(button("Add nutrient").props.disabled).toBe(true);
      const count = result.calls.length;
      invokeOldPicker(pickerControls());
      await hooks.settle();
      expect(result.calls).toHaveLength(count);
      pending.resolve(phase === "auth" ? session() : Response.json({ data: registry }));
      await hooks.settle();
      expect(button("Add nutrient").props.disabled).toBe(false);
      expect(field("Find a nutrient").props.value).toBe("vitamin");
    },
  );

  it("preserves loaded-only matches on failed refresh and permits existing Retry recovery", async () => {
    let fail = false;
    await workspace({
      intercept: ({ path }) =>
        fail && path === "/api/nutrients/targetable"
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await change("Find a nutrient", "vitamin");
    const old = pickerControls();
    fail = true;
    invoke(field("Progress date"), "onBlur");
    await hooks.settle();
    expect(status()).toBe("Targetable nutrients could not be loaded.");
    expect(text()).toContain(
      "1 matching · 3 available · 3 loaded. Search applies only to loaded nutrients.",
    );
    expect(field("Find a nutrient").props.value).toBe("vitamin");
    expect(button("Add nutrient").props.disabled).toBe(true);
    invokeOldPicker(old);
    await hooks.settle();
    expect(targetRows()).toHaveLength(0);
    fail = false;
    await click("Retry goals");
    expect(button("Add nutrient").props.disabled).toBe(false);
    expect(field("Find a nutrient").props.value).toBe("vitamin");
  });

  it("preserves reference selection/acknowledgement while searching, respects Apply and explicit Customize", async () => {
    const ref = referenceFixture();
    const { calls } = await workspace({
      intercept: ({ path }) =>
        path.startsWith("/api/goals/reference-target-sets?") ? Response.json(ref) : undefined,
    });
    expect(button("Add nutrient").props.disabled).toBe(false);
    const group = required(
      elements().find(
        (node) =>
          node.type === "input" &&
          node.props.type === "radio" &&
          node.props.name === "reference-target-group",
      ),
    );
    invoke(group, "onChange");
    await hooks.settle();
    const ack = required(
      elements().find((node) => node.type === "input" && node.props.type === "checkbox"),
    );
    invoke(ack, "onChange", { target: { checked: true } });
    await hooks.settle();
    const before = rawEditor(),
      message = status(),
      count = calls.length;
    await change("Find a nutrient", "vitamin");
    await click("Clear nutrient search");
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    expect(calls).toHaveLength(count);
    const add = button("Add nutrient");
    await click("Apply 12 values to unsaved draft");
    invoke(add, "onClick");
    await hooks.settle();
    expect(elements().some((node) => node.props["aria-label"] === "Nutrient to add")).toBe(false);
    expect(targetRows()).toHaveLength(12);
    await click("Customize as editable targets and clear verified provenance");
    expect(button("Add nutrient").props.disabled).toBe(false);
    expect(targetRows()).toHaveLength(12);
    expect(field("Nutrient 1 target source").props.value).toBe(
      "User-customized copy of Health Canada Dietary Reference Intakes",
    );
  });

  it("blocks picker through live profile write then resets at the installed profile boundary", async () => {
    const pending = deferred<Response>();
    const ref = referenceFixture();
    const { calls } = await workspace({
      intercept: ({ path, init }) => {
        if (path === "/api/profile" && init?.method === "PATCH") return pending.promise;
        if (path.startsWith("/api/goals/reference-target-sets?")) return Response.json(ref);
        return undefined;
      },
    });
    await change("Find a nutrient", "vitamin");
    await change("Birth date (YYYY-MM-DD)", "1990-01-01");
    await change("Sex at birth", "male");
    const old = pickerControls();
    const save = required(
      elements().find(
        (node) => node.type === "button" && text(node) === "Save profile and check eligibility",
      ),
    );
    invoke(save, "onClick");
    invokeOldPicker(old);
    await hooks.settle();
    expect(button("Clear nutrient search").props.disabled).toBe(true);
    expect(field("Find a nutrient").props.value).toBe("vitamin");
    expect(targetRows()).toHaveLength(0);
    const profile = (await session().json()).data.profile;
    profile.revision = "5";
    profile.birthDate = "1990-01-01";
    profile.sexAtBirth = "male";
    ref.data.profileRevision = "5";
    pending.resolve(Response.json({ data: { profile } }));
    await hooks.settle();
    expect(field("Find a nutrient").props.value).toBe("");
    expect(button("Add nutrient").props.disabled).toBe(false);
    invokeOldPicker(old);
    await hooks.settle();
    expect(field("Find a nutrient").props.value).toBe("");
    expect(calls.filter((call) => call.path === "/api/profile")).toHaveLength(1);
  });
});

it("fences retained Add when a current candidate receipt re-locks the same customized builder before paint", async () => {
  const ref = referenceFixture();
  const pending = deferred<Response>();
  let deferCandidate = false;
  await workspace({
    goal: savedGoal(),
    intercept: ({ path }) =>
      path.startsWith("/api/goals/reference-target-sets?")
        ? deferCandidate
          ? pending.promise
          : Response.json(ref)
        : undefined,
  });
  expect(text()).toContain("These source-verified candidate rows are read-only.");
  await click("Customize as editable targets and clear verified provenance");
  await change("Find a nutrient", "vitamin");
  const old = pickerControls(),
    before = rawEditor().filter(([label]) => typeof label === "string");
  expect(targetRows()).toHaveLength(12);
  deferCandidate = true;
  invoke(field("Effective from"), "onBlur");
  await hooks.settle();
  expect(button("Add nutrient").props.disabled).toBe(true);
  pending.resolve(Response.json(ref));
  await new Promise((resolve) => setTimeout(resolve, 0));
  invokeOldPicker(old);
  await hooks.settle();
  expect(targetRows()).toHaveLength(12);
  expect(status()).toBe(
    "Source-verified candidate loaded. Review it before applying anything to the draft.",
  );
  expect(elements().some((node) => node.props["aria-label"] === "Nutrient to add")).toBe(false);
  await click("Customize as editable targets and clear verified provenance");
  expect(field("Find a nutrient").props.value).toBe("vitamin");
  expect(rawEditor().filter(([label]) => typeof label === "string")).toEqual(before);
});

const copyLabel = "Copy saved goal to new draft";
const discardLabel = "Discard edits and copy saved version";
function manualReferences(localDate = day) {
  return { data: { ...referenceFixture().data, date: localDate, applied: null } };
}
async function copyWorkspace(settings: Parameters<typeof workspace>[0] = {}) {
  return workspace({
    ...settings,
    goal: settings.goal === undefined ? savedGoal() : settings.goal,
    intercept: (call) => {
      const intercepted = settings.intercept?.(call);
      if (intercepted !== undefined) return intercepted;
      if (call.path.startsWith("/api/goals/reference-target-sets?")) {
        const localDate = new URL(call.path, "https://fixture.test").searchParams.get("date");
        return Response.json(manualReferences(localDate ?? day));
      }
      return undefined;
    },
  });
}
function hasButton(label: string) {
  return elements().some((node) => node.type === "button" && text(node) === label);
}
function assertSavedRows() {
  expect(field("Daily energy (kcal)").props.value).toBe("2100.00");
  expect(field("Why this energy target?").props.value).toBe(" Saved rationale. ");
  expect(field("Calcium minimum mg").props.value).toBe("0.00");
  expect(field("Calcium target mg").props.value).toBe("100.0000");
  expect(field("Calcium maximum mg").props.value).toBe("");
  expect(field("Calcium target source").props.value).toBe(" Saved source ");
  expect(field("Calcium source version").props.value).toBe(" v1 ");
  expect(field("Calcium rationale").props.value).toBe(" Saved target rationale ");
}

describe("copy saved manual goal", () => {
  it("copies exact saved fields locally, preserves search/profile drafts, and requires a reviewed date", async () => {
    const allocation = vi.spyOn(globalThis.crypto, "randomUUID");
    const source = savedGoal();
    const saved = structuredClone(source);
    const { calls } = await copyWorkspace({ goal: source });
    await change("Find a nutrient", " vitamin ");
    await change("Birth date (YYYY-MM-DD)", "1990-01-01");
    await change("Sex at birth", "female");
    const count = calls.length;
    await click(copyLabel);
    expect(hasButton(discardLabel)).toBe(false);
    expect(text()).toContain("NEW GOAL");
    expect(text()).toContain(`Copy saved goal version 3, effective ${day}`);
    expect(field("Effective from").props.value).toBe("");
    expect(field("Effective from").props.readOnly).toBe(false);
    expect(field("Progress date").props.value).toBe(day);
    expect(field("Find a nutrient").props.value).toBe(" vitamin ");
    assertSavedRows();
    expect(source).toEqual(saved);
    expect(calls).toHaveLength(count);
    expect(allocation).not.toHaveBeenCalled();
    await submit();
    await hooks.settle();
    expect(status()).toBe("Effective date must be a real YYYY-MM-DD local date.");
    expect(calls).toHaveLength(count);
    expect(allocation).not.toHaveBeenCalled();
    // The existing profile section requires a loaded candidate list. Its draft
    // fields reappear unchanged after this separate explicit date read.
    await change("Effective from", "2026-09-13");
    invoke(field("Effective from"), "onBlur");
    await hooks.settle();
    expect(field("Birth date (YYYY-MM-DD)").props.value).toBe("1990-01-01");
    expect(field("Sex at birth").props.value).toBe("female");
    expect(allocation).not.toHaveBeenCalled();
  });

  it("preserves target order, metadata, nullable values and exact zero/long decimals through Create", async () => {
    const base = savedGoal();
    const row = required(base.currentVersion.nutrientTargets[0]);
    const source = {
      ...base,
      currentVersion: {
        ...base.currentVersion,
        nutrientTargets: [
          {
            ...row,
            definition: registry[1],
            minimumAmount: null,
            targetAmount: null,
            maximumAmount: "0",
            source: { label: " Max only ", version: null },
            rationale: null,
          },
          { ...row, targetAmount: "123.123456789012" },
        ],
      },
    };
    const { calls } = await copyWorkspace({
      intercept: ({ path, init }) => {
        if (path.startsWith("/api/goals/current?"))
          return Response.json({ data: { goal: source } });
        if (init?.method === "POST") return Response.json({}, { status: 503 });
        return undefined;
      },
    });
    await click(copyLabel);
    expect(
      targetRows().map((row) => text(elements(row).find((node) => node.type === "strong"))),
    ).toEqual(["Magnesium", "Calcium"]);
    expect(field("Magnesium minimum mg").props.value).toBe("");
    expect(field("Magnesium maximum mg").props.value).toBe("0");
    await change("Effective from", "2026-09-13");
    await submit();
    await hooks.settle();
    const call = required(writes(calls)[0]);
    expect(call.path).toBe("/api/goals");
    expect(new Headers(call.init?.headers).get("if-match")).toBeNull();
    expect(JSON.parse(String(call.init?.body))).toEqual({
      expectedOwnerUserId: owner,
      effectiveFrom: "2026-09-13",
      energy: { mode: "fixed", targetKcal: "2100.00", rationale: " Saved rationale. " },
      nutrientTargets: [
        {
          nutrientId: "1090",
          minimumAmount: null,
          targetAmount: null,
          maximumAmount: "0",
          source: { label: " Max only ", version: null },
          rationale: null,
        },
        {
          nutrientId: "1087",
          minimumAmount: "0.00",
          targetAmount: "123.123456789012",
          maximumAmount: null,
          source: { label: " Saved source ", version: " v1 " },
          rationale: " Saved target rationale ",
        },
      ],
    });
  });

  it("Keeps every dirty field and discards only to the saved source without requests or allocation", async () => {
    const allocation = vi.spyOn(globalThis.crypto, "randomUUID");
    const { calls } = await copyWorkspace();
    await change("Daily energy (kcal)", "2200.000001");
    await change("Why this energy target?", " Dirty rationale ");
    await change("Calcium minimum mg", "1");
    await change("Calcium target mg", "101");
    await change("Calcium maximum mg", "300");
    await change("Calcium target source", " Dirty source ");
    await change("Calcium source version", " Dirty version ");
    await change("Calcium rationale", " Dirty target rationale ");
    const before = rawEditor(),
      message = status(),
      count = calls.length;
    await click(copyLabel);
    expect(rawEditor()).toEqual(before);
    await click("Keep editing");
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    await click(copyLabel);
    await click(discardLabel);
    assertSavedRows();
    expect(field("Effective from").props.value).toBe("");
    expect(calls).toHaveLength(count);
    expect(allocation).not.toHaveBeenCalled();
  });

  it.each(["active", "archived"])(
    "copies %s saved history without unlocking its revision",
    async (savedStatus) => {
      await copyWorkspace({
        goal: { ...savedGoal(), status: savedStatus, effectiveTo: "2026-09-12" },
      });
      expect(button("Closed goal history is read-only").props.disabled).toBe(true);
      await click(copyLabel);
      expect(button("Create goal").props.disabled).toBe(false);
      expect(field("Effective from").props.readOnly).toBe(false);
      assertSavedRows();
    },
  );

  it.each([
    "none",
    "draft",
    "404",
    "failed",
    "wrong date",
    "wrong profile",
    "applied",
    "mismatched applied",
    "derived",
  ])("withholds copy for %s source/provenance even after manual customization", async (kind) => {
    const base = savedGoal();
    const derived = {
      ...base,
      currentVersion: {
        ...base.currentVersion,
        energy: {
          mode: "derived",
          targetKcal: "2100",
          bmrKcal: "1400",
          profileRevision: "4",
          ageYears: 35,
          heightCm: "170",
          weightKg: "70",
          sexAtBirth: "male",
          activityLevelCode: "sedentary_or_light",
          activityFactor: "1.5",
          adjustmentKcal: "0",
          rationale: " Saved derived rationale ",
          source: {
            equation: {
              code: "mifflin-st-jeor-ree",
              version: "1990-original",
              url: "https://example.test/equation",
            },
            activityPolicy: {
              code: "fao-who-unu-pal-policy",
              version: "2004-reviewed-v1",
              sourceUrl: "https://example.test/pal",
            },
          },
        },
      },
    };
    await copyWorkspace({
      goal: kind === "none" ? null : kind === "draft" ? { ...base, status: "draft" } : base,
      intercept: ({ path }) => {
        if (kind === "derived" && path.startsWith("/api/goals/current?"))
          return Response.json({ data: { goal: derived } });
        if (!path.startsWith("/api/goals/reference-target-sets?")) return undefined;
        if (kind === "404" || kind === "failed")
          return Response.json({}, { status: kind === "404" ? 404 : 503 });
        if (kind === "wrong date") return Response.json(manualReferences("2026-09-10"));
        if (kind === "wrong profile")
          return Response.json({ data: { ...manualReferences().data, profileRevision: "5" } });
        if (kind === "applied" || kind === "mismatched applied") {
          const reference = referenceFixture();
          if (kind === "mismatched applied") reference.data.applied.goalRevision = "4";
          return Response.json(reference);
        }
        return undefined;
      },
    });
    expect(hasButton(copyLabel)).toBe(false);
    if (kind === "applied")
      await click("Customize as editable targets and clear verified provenance");
    if (kind === "derived") {
      expect(text()).toContain("Explainable energy estimate");
      invoke(field("Fixed target"), "onChange");
      await hooks.settle();
    }
    expect(hasButton(copyLabel)).toBe(false);
  });

  it("requires source-effective-date provenance and retains eligibility across unrelated candidate changes", async () => {
    const source = { ...savedGoal(), effectiveFrom: "2026-09-07" };
    let laterCandidate = false;
    const { calls } = await copyWorkspace({
      goal: source,
      intercept: ({ path }) =>
        laterCandidate && path.startsWith("/api/goals/reference-target-sets?")
          ? Response.json(referenceFixture())
          : undefined,
    });
    expect(calls.some((call) => call.path.endsWith("reference-target-sets?date=2026-09-07"))).toBe(
      true,
    );
    await click("New goal");
    laterCandidate = true;
    invoke(field("Effective from"), "onBlur");
    await hooks.settle();
    expect(button(copyLabel).props.disabled).toBe(false);
    await click(copyLabel);
    await click(discardLabel);
    assertSavedRows();
    expect(field("Effective from").props.value).toBe("");
    expect(text()).not.toContain("These source-verified candidate rows are read-only.");
  });
});

describe("saved goal copy ownership", () => {
  it.each(["energy", "threshold", "source", "Add", "Remove", "New", "mode", "date"])(
    "rejects retained Copy and Discard after a raw %s replacement before paint",
    async (kind) => {
      const { calls } = await copyWorkspace();
      await change("Why this energy target?", " Dirty ");
      await click(copyLabel);
      const oldCopy = button(copyLabel),
        oldDiscard = button(discardLabel),
        oldKeep = button("Keep editing");
      const count = calls.length;
      if (kind === "energy")
        invoke(field("Daily energy (kcal)"), "onChange", { target: { value: "9999" } });
      if (kind === "threshold")
        invoke(field("Calcium target mg"), "onChange", { target: { value: "222" } });
      if (kind === "source")
        invoke(field("Calcium target source"), "onChange", { target: { value: " Changed " } });
      if (kind === "Add") invoke(button("Add nutrient"), "onClick");
      if (kind === "Remove") invoke(button("Remove"), "onClick");
      if (kind === "New") invoke(button("New goal"), "onClick");
      if (kind === "mode") invoke(field("Profile-derived estimate"), "onChange");
      if (kind === "date")
        invoke(field("Effective from"), "onChange", { target: { value: "2026-09-14" } });
      invoke(oldCopy, "onClick");
      invoke(oldDiscard, "onClick");
      invoke(oldKeep, "onClick");
      await hooks.settle();
      expect(hasButton(discardLabel)).toBe(false);
      expect(status()).not.toContain("Copied saved goal");
      expect(calls).toHaveLength(count);
      expect(field("Why this energy target?").props.value).toBe(" Dirty ");
      if (kind === "energy") expect(field("Daily energy (kcal)").props.value).toBe("9999");
      if (kind === "threshold") expect(field("Calcium target mg").props.value).toBe("222");
      if (kind === "source") expect(field("Calcium target source").props.value).toBe(" Changed ");
      if (kind === "Add") expect(targetRows()).toHaveLength(2);
      if (kind === "Remove") expect(targetRows()).toHaveLength(0);
      if (kind === "New") {
        expect(targetRows()).toHaveLength(1);
        expect(hasButton(discardNewGoalLabel)).toBe(true);
      }
      if (kind === "date") expect(field("Effective from").props.value).toBe("2026-09-14");
    },
  );

  it("rejects A-to-B-to-A edits and old Discard after Keep and a new confirmation", async () => {
    await copyWorkspace();
    await change("Why this energy target?", " Dirty ");
    await click(copyLabel);
    const stale = button(discardLabel);
    const input = field("Why this energy target?");
    invoke(input, "onChange", { target: { value: " Other " } });
    invoke(input, "onChange", { target: { value: " Dirty " } });
    invoke(stale, "onClick");
    await hooks.settle();
    expect(status()).not.toContain("Copied saved goal");
    await click(copyLabel);
    const firstDiscard = button(discardLabel);
    await click("Keep editing");
    await click(copyLabel);
    const before = rawEditor(),
      message = status();
    invoke(firstDiscard, "onClick");
    await hooks.settle();
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    expect(hasButton(discardLabel)).toBe(true);
    await click(discardLabel);
    assertSavedRows();
  });

  it.each(["2026-09-12", "invalid"])(
    "rejects actual progress date %s and A-to-B-to-A until a full load",
    async (nextDate) => {
      await copyWorkspace();
      await change("Why this energy target?", " Dirty ");
      await click(copyLabel);
      const copy = button(copyLabel),
        discard = button(discardLabel),
        dateInput = field("Progress date");
      invoke(dateInput, "onChange", { target: { value: nextDate } });
      invoke(copy, "onClick");
      invoke(discard, "onClick");
      await hooks.settle();
      await change("Progress date", day);
      invoke(copy, "onClick");
      invoke(discard, "onClick");
      await hooks.settle();
      expect(button(copyLabel).props.disabled).toBe(true);
      expect(field("Why this energy target?").props.value).toBe(" Dirty ");
      invoke(field("Progress date"), "onBlur");
      await hooks.settle();
      await click(discardReloadGoalLabel);
      expect(button(copyLabel).props.disabled).toBe(false);
      invoke(discard, "onClick");
      await hooks.settle();
      expect(field("Effective from").props.value).toBe(day);
    },
  );

  it("rejects retained controls across route-before-effect and unmount without metadata updates", async () => {
    const { calls } = await copyWorkspace();
    await change("Why this energy target?", " Dirty ");
    await click(copyLabel);
    const old = [button(copyLabel), button(discardLabel), button("Keep editing")];
    const before = rawEditor(),
      message = status(),
      count = calls.length;
    navigation.query = "date=2026-09-12";
    hooks.renderWithoutEffects();
    for (const node of old) invoke(node, "onClick");
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    expect(button(copyLabel).props.disabled).toBe(true);
    hooks.unmount();
    for (const node of old) invoke(node, "onClick");
    expect(hooks.afterClose()).toBe(0);
    expect(calls).toHaveLength(count);
  });

  it.each(["auth", "load", "write", "profile", "candidate"])(
    "blocks live %s work before paint and rejects obsolete controls after receipt",
    async (phase) => {
      const response = deferred<Response>();
      let active = false;
      const targetPath =
        phase === "auth"
          ? "/api/auth/me"
          : phase === "load"
            ? "/api/nutrients/targetable"
            : phase === "write"
              ? `/api/goals/${savedGoal().id}/revisions`
              : phase === "profile"
                ? "/api/profile"
                : `/api/goals/reference-target-sets?date=${day}`;
      const result = await copyWorkspace({
        intercept: ({ path }) => (active && path === targetPath ? response.promise : undefined),
      });
      await change("Why this energy target?", " Dirty ");
      await click(copyLabel);
      const old = [button(copyLabel), button(discardLabel)];
      active = true;
      if (phase === "auth") hooks.replayEffects();
      if (phase === "load") {
        await click("Reload saved goal");
        await click(discardReloadGoalLabel);
      }
      if (phase === "candidate") invoke(field("Effective from"), "onBlur");
      if (phase === "write") void submit();
      if (phase === "profile") invoke(button("Save profile and check eligibility"), "onClick");
      for (const node of old) invoke(node, "onClick");
      await hooks.settle();
      expect(field("Why this energy target?").props.value).toBe(" Dirty ");
      expect(status()).not.toContain("Copied saved goal");
      hooks.render();
      if (hasButton(copyLabel)) expect(button(copyLabel).props.disabled).toBe(true);
      active = false;
      if (phase === "auth") response.resolve(session("51f6bdfa-9cb4-4b8f-9f8f-fd2bc45b46cb"));
      if (phase === "load") response.resolve(Response.json({ data: registry }));
      if (phase === "candidate") response.resolve(Response.json(manualReferences()));
      if (phase === "write") {
        const accepted = savedGoal(undefined, "4");
        result.setGoal(accepted);
        response.resolve(Response.json({ data: { replayed: true, goal: accepted } }));
      }
      if (phase === "profile") {
        const profile = (await session().json()).data.profile;
        profile.revision = "5";
        response.resolve(Response.json({ data: { profile } }));
      }
      await hooks.settle();
      if (phase === "candidate") {
        expect(button(copyLabel).props.disabled).toBe(false);
        // A candidate read retires the earlier choice even when saved source values match.
        expect(hasButton("Keep editing")).toBe(false);
        const before = rawEditor();
        for (const node of old) invoke(node, "onClick");
        await hooks.settle();
        expect(rawEditor()).toEqual(before);
        await click(copyLabel);
        expect(hasButton(discardLabel)).toBe(true);
      } else {
        const editor = rawEditor(),
          message = status();
        for (const node of old) invoke(node, "onClick");
        await hooks.settle();
        expect(rawEditor()).toEqual(editor);
        expect(status()).toBe(message);
        if (phase === "auth") {
          expect(hasButton(copyLabel)).toBe(false);
          expect(router.replace).toHaveBeenCalledWith("/login");
        } else if (phase === "profile") expect(button(copyLabel).props.disabled).toBe(true);
        else expect(button(copyLabel).props.disabled).toBe(false);
      }
    },
  );

  it("withholds failed reload provenance, restores on Retry, and closes old controls on 401", async () => {
    let mode = "normal";
    await copyWorkspace({
      intercept: ({ path }) =>
        path.startsWith("/api/goals/current?") && mode !== "normal"
          ? Response.json({}, { status: mode === "expired" ? 401 : 503 })
          : undefined,
    });
    const old = button(copyLabel);
    mode = "failed";
    invoke(field("Progress date"), "onBlur");
    await hooks.settle();
    expect(hasButton(copyLabel)).toBe(false);
    invoke(old, "onClick");
    expect(field("Effective from").props.value).toBe(day);
    mode = "normal";
    await click("Retry goals");
    expect(button(copyLabel).props.disabled).toBe(false);
    const current = button(copyLabel);
    mode = "expired";
    invoke(field("Progress date"), "onBlur");
    await hooks.settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
    const before = rawEditor(),
      message = status();
    invoke(old, "onClick");
    invoke(current, "onClick");
    await hooks.settle();
    expect(rawEditor()).toEqual(before);
    expect(status()).toBe(message);
    expect(hasButton(copyLabel)).toBe(false);
  });
});

describe("copied goal mutation ownership", () => {
  it("preserves pending revision and exact ambiguous Create body/date identity across repeated copies", async () => {
    const { calls } = await copyWorkspace({
      intercept: ({ init }) =>
        init?.method === "POST" ? Response.json({}, { status: 503 }) : undefined,
    });
    await submit();
    await hooks.settle();
    const revision = required(writes(calls)[0]);
    await click(copyLabel);
    await change("Effective from", "2026-09-13");
    await submit();
    await hooks.settle();
    const first = required(writes(calls)[1]);
    const firstKey = new Headers(first.init?.headers).get("idempotency-key");
    const count = calls.length;
    await click(copyLabel);
    await click(discardLabel);
    expect(calls).toHaveLength(count);
    await change("Effective from", "2026-09-13");
    await submit();
    await hooks.settle();
    const same = required(writes(calls)[2]);
    expect(same.init?.body).toBe(first.init?.body);
    expect(new Headers(same.init?.headers).get("idempotency-key")).toBe(firstKey);
    expect(new Headers(same.init?.headers).get("if-match")).toBeNull();
    expect(new Headers(revision.init?.headers).get("if-match")).toBe('"3"');
    expect(new Headers(revision.init?.headers).get("idempotency-key")).not.toBe(firstKey);
    await change("Effective from", "2026-09-14");
    await submit();
    await hooks.settle();
    const otherDate = required(writes(calls)[3]);
    expect(new Headers(otherDate.init?.headers).get("idempotency-key")).not.toBe(firstKey);
    await change("Effective from", "2026-09-13");
    await change("Why this energy target?", " Other body ");
    await submit();
    await hooks.settle();
    const otherBody = required(writes(calls)[4]);
    expect(new Headers(otherBody.init?.headers).get("idempotency-key")).not.toBe(firstKey);
    await click("Reload saved goal");
    await click(discardReloadGoalLabel);
    await submit();
    await hooks.settle();
    const replayRevision = required(writes(calls)[5]);
    expect(replayRevision.init?.body).toBe(revision.init?.body);
    expect(new Headers(replayRevision.init?.headers).get("idempotency-key")).toBe(
      new Headers(revision.init?.headers).get("idempotency-key"),
    );
  });

  it("accepts the explicit Create receipt and keeps earlier saved values intact on readback", async () => {
    const accepted = {
      ...savedGoal(undefined, "1"),
      id: "19b38885-4de5-4bfc-9cdc-3b0a1a8eb445",
      effectiveFrom: "2026-09-13",
    };
    const { calls } = await copyWorkspace({
      intercept: ({ init }) =>
        init?.method === "POST"
          ? Response.json({ data: { replayed: true, goal: accepted } }, { status: 201 })
          : undefined,
    });
    await click(copyLabel);
    await change("Effective from", "2026-09-13");
    await submit();
    await hooks.settle();
    expect(status()).toBe("The earlier goal save was confirmed safely.");
    expect(text()).toContain("GOAL REVISION 3");
    expect(field("Progress date").props.value).toBe(day);
    assertSavedRows();
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.path).toBe("/api/goals");
    expect(button(copyLabel).props.disabled).toBe(false);
  });
});

const discardNewGoalLabel = "Discard edits and start new goal";
const discardReloadGoalLabel = "Discard edits and reload saved goal";
async function editGoalDraft() {
  await change("Daily energy (kcal)", "2200.000001");
  await change("Why this energy target?", "  Raw energy rationale\nkeep spacing  ");
  await change("Calcium minimum mg", "0.000000000001");
  await change("Calcium target mg", "999.000000000001");
  await change("Calcium maximum mg", "1000.000000000001");
  await change("Calcium target source", "  Draft source  ");
  await change("Calcium source version", " draft-v2 ");
  await change("Calcium rationale", "  Raw target rationale  ");
}

describe("goal draft replacement regressions", () => {
  it("preserves every dirty field through New and Keep editing until explicit discard", async () => {
    const { calls } = await copyWorkspace();
    await editGoalDraft();
    const before = rawEditor(),
      count = calls.length;
    const allocation = vi.spyOn(globalThis.crypto, "randomUUID");
    await click("New goal");
    expect(rawEditor()).toEqual(before);
    expect(hasButton(discardNewGoalLabel)).toBe(true);
    await click("Keep editing");
    expect(rawEditor()).toEqual(before);
    expect(calls).toHaveLength(count);
    expect(allocation).not.toHaveBeenCalled();
    await click("New goal");
    await click(discardNewGoalLabel);
    expect(text()).toContain("NEW GOAL");
    expect(field("Effective from").props.value).toBe(day);
    expect(targetRows()).toHaveLength(0);
    expect(calls).toHaveLength(count);
    expect(allocation).not.toHaveBeenCalled();
  });

  it("preserves a rejected 412 draft and original revision without implicit reads", async () => {
    const { calls, setGoal } = await copyWorkspace({
      intercept: ({ init }) =>
        init?.method === "POST"
          ? Response.json({ message: "Revision changed" }, { status: 412 })
          : undefined,
    });
    await editGoalDraft();
    const before = rawEditor(),
      count = calls.length;
    setGoal(savedGoal(undefined, "4"));
    await submit();
    await hooks.settle();
    expect(rawEditor()).toEqual(before);
    expect(calls.slice(count).map((call) => call.init?.method)).toEqual(["POST"]);
    expect(hasButton(discardReloadGoalLabel)).toBe(true);
    expect(status().toLowerCase()).toContain("edits");
    await submit();
    await hooks.settle();
    const posts = writes(calls);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.init?.body).toBe(posts[0]?.init?.body);
    expect(new Headers(posts[1]?.init?.headers).get("idempotency-key")).not.toBe(
      new Headers(posts[0]?.init?.headers).get("idempotency-key"),
    );
    expect(posts.map((call) => new Headers(call.init?.headers).get("if-match"))).toEqual([
      '"3"',
      '"3"',
    ]);
    expect(rawEditor()).toEqual(before);
  });

  it("keeps the rejected draft and revision when an explicit reload fails", async () => {
    let failReads = false;
    const { calls } = await copyWorkspace({
      intercept: ({ path, init }) => {
        if (init?.method === "POST") return Response.json({}, { status: 412 });
        if (failReads && path.startsWith("/api/goals/current?"))
          return Response.json(
            { message: "Saved goal is temporarily unavailable" },
            { status: 503 },
          );
        return undefined;
      },
    });
    await editGoalDraft();
    const before = rawEditor();
    await submit();
    await hooks.settle();
    failReads = true;
    await click(discardReloadGoalLabel);
    expect(rawEditor()).toEqual(before);
    expect(writes(calls)).toHaveLength(1);
    expect(new Headers(writes(calls)[0]?.init?.headers).get("if-match")).toBe('"3"');
    expect(status()).toBe("The current goal could not be loaded.");
  });
});

const reloadGoalLabel = "Reload saved goal";
const discardGoalDateLabel = "Discard edits and change progress date";
function goalDraftValues() {
  return [
    "Effective from",
    "Daily energy (kcal)",
    "Why this energy target?",
    "Calcium minimum mg",
    "Calcium target mg",
    "Calcium maximum mg",
    "Calcium target source",
    "Calcium source version",
    "Calcium rationale",
  ].map((label) => [label, field(label).props.value]);
}
async function askGoalReplacement(action: "new" | "reload" | "date") {
  if (action === "new") await click("New goal");
  else if (action === "reload") await click(reloadGoalLabel);
  else {
    await change("Progress date", "2026-09-12");
    invoke(field("Progress date"), "onBlur");
    await hooks.settle();
  }
}
function goalReplacementLabel(action: "new" | "reload" | "date") {
  return action === "new"
    ? discardNewGoalLabel
    : action === "reload"
      ? discardReloadGoalLabel
      : discardGoalDateLabel;
}

describe("goal draft replacement choices and races", () => {
  it.each(["reload", "date"] as const)(
    "keeps exact draft and original context when declining %s",
    async (action) => {
      const { calls } = await copyWorkspace();
      await editGoalDraft();
      const before = goalDraftValues(),
        count = calls.length;
      await askGoalReplacement(action);
      expect(goalDraftValues()).toEqual(before);
      expect(hasButton(goalReplacementLabel(action))).toBe(true);
      expect(calls).toHaveLength(count);
      await click("Keep editing");
      expect(goalDraftValues()).toEqual(before);
      expect(field("Progress date").props.value).toBe(day);
      expect(text()).toContain("GOAL REVISION 3");
      expect(calls).toHaveLength(count);
    },
  );

  it("installs a new progress day only after explicit discard and preserves the previous fields while loading", async () => {
    let nextDay = false;
    const pending = deferred<Response>();
    const { calls } = await copyWorkspace({
      intercept: ({ path }) =>
        nextDay && path.startsWith("/api/goals/current?") ? pending.promise : undefined,
    });
    await editGoalDraft();
    const before = goalDraftValues();
    await askGoalReplacement("date");
    nextDay = true;
    await click(discardGoalDateLabel);
    expect(goalDraftValues()).toEqual(before);
    expect(text()).toContain("GOAL REVISION 3");
    pending.resolve(
      Response.json({
        data: { goal: { ...savedGoal(undefined, "4"), effectiveFrom: "2026-09-12" } },
      }),
    );
    await hooks.settle();
    expect(field("Progress date").props.value).toBe("2026-09-12");
    expect(field("Effective from").props.value).toBe("2026-09-12");
    expect(text()).toContain("GOAL REVISION 4");
    expect(field("Daily energy (kcal)").props.value).toBe("2100.00");
    expect(
      calls
        .filter((call) => call.path.startsWith("/api/goals/current?"))
        .map((call) => new URL(call.path, "https://fixture.test").searchParams.get("date")),
    ).toEqual([day, "2026-09-12"]);
  });

  it("refreshes route progress without replacing the dirty editor or its saved goal identity", async () => {
    const { setGoal } = await copyWorkspace();
    await editGoalDraft();
    const before = goalDraftValues();
    setGoal({ ...savedGoal(undefined, "4"), effectiveFrom: "2026-09-12" });
    navigation.query = "date=2026-09-12";
    hooks.render();
    await hooks.settle();
    expect(goalDraftValues()).toEqual(before);
    expect(text()).toContain("GOAL REVISION 3");
    expect(text()).not.toContain("GOAL REVISION 4");
    expect(field("Progress date").props.value).toBe("2026-09-12");
    expect(field("Effective from").props.value).toBe(day);
  });

  it.each(["new", "reload", "date"] as const)(
    "invalidates a retained %s choice on a newer edit and exact edit restoration",
    async (action) => {
      const { calls } = await copyWorkspace();
      await editGoalDraft();
      await askGoalReplacement(action);
      const discard = button(goalReplacementLabel(action));
      const input = field("Why this energy target?"),
        original = input.props.value;
      invoke(input, "onChange", { target: { value: "Later edit" } });
      await hooks.settle();
      await change("Why this energy target?", String(original));
      const count = calls.length;
      invoke(discard, "onClick");
      await hooks.settle();
      expect(field("Why this energy target?").props.value).toBe(original);
      expect(field("Calcium target mg").props.value).toBe("999.000000000001");
      expect(calls).toHaveLength(count);
      expect(hasButton(goalReplacementLabel(action))).toBe(false);
    },
  );

  it.each(["route", "date", "owner", "unmount"] as const)(
    "rejects retained New choices after %s scope changes",
    async (scope) => {
      let otherOwner = false;
      const { calls } = await copyWorkspace({
        intercept: ({ path }) =>
          otherOwner && path === "/api/auth/me"
            ? session("217e6c14-c82b-4451-a81e-2495863a3f64")
            : undefined,
      });
      await editGoalDraft();
      await askGoalReplacement("new");
      const old = [button(discardNewGoalLabel), button("Keep editing")];
      if (scope === "route") {
        navigation.query = "date=2026-09-12";
        hooks.renderWithoutEffects();
      }
      if (scope === "date")
        invoke(field("Progress date"), "onChange", { target: { value: "2026-09-12" } });
      if (scope === "owner") {
        otherOwner = true;
        hooks.replayEffects();
        await hooks.settle();
      }
      if (scope === "unmount") hooks.unmount();
      const count = calls.length,
        updates = hooks.afterClose();
      for (const node of old) invoke(node, "onClick");
      if (scope !== "route") await hooks.settle();
      expect(calls).toHaveLength(count);
      expect(hooks.afterClose()).toBe(updates);
      if (scope !== "owner")
        expect(field("Calcium target mg").props.value).toBe("999.000000000001");
      else expect(targetRows()).toHaveLength(0);
    },
  );

  it("uses one replacement choice and never revives an earlier New or Copy discard", async () => {
    const { calls } = await copyWorkspace();
    await editGoalDraft();
    await askGoalReplacement("new");
    const firstNew = button(discardNewGoalLabel);
    await click(copyLabel);
    expect(hasButton(discardNewGoalLabel)).toBe(false);
    const copy = button(discardLabel);
    await askGoalReplacement("reload");
    expect(hasButton(discardLabel)).toBe(false);
    const before = rawEditor(),
      count = calls.length;
    invoke(firstNew, "onClick");
    invoke(copy, "onClick");
    await hooks.settle();
    expect(rawEditor()).toEqual(before);
    expect(calls).toHaveLength(count);
    expect(hasButton(discardReloadGoalLabel)).toBe(true);
    await click("Keep editing");
    await askGoalReplacement("new");
    invoke(firstNew, "onClick");
    await hooks.settle();
    expect(rawEditor()).toEqual(before);
    expect(hasButton(discardNewGoalLabel)).toBe(true);
  });

  it.each(["new", "reload"] as const)(
    "accepts a %s discard only once before paint",
    async (action) => {
      let loading = false;
      const pending = deferred<Response>();
      const { calls } = await copyWorkspace({
        intercept: ({ path }) =>
          loading && path.startsWith("/api/goals/current?") ? pending.promise : undefined,
      });
      await editGoalDraft();
      await askGoalReplacement(action);
      const discard = button(goalReplacementLabel(action));
      const beforeReads = calls.filter((call) =>
        call.path.startsWith("/api/goals/current?"),
      ).length;
      loading = action === "reload";
      invoke(discard, "onClick");
      invoke(discard, "onClick");
      await hooks.settle();
      expect(calls.filter((call) => call.path.startsWith("/api/goals/current?"))).toHaveLength(
        beforeReads + (action === "reload" ? 1 : 0),
      );
      if (action === "reload") {
        pending.resolve(Response.json({ data: { goal: savedGoal(undefined, "4") } }));
        await hooks.settle();
      }
      await change("Why this energy target?", "Later draft");
      const count = calls.length;
      invoke(discard, "onClick");
      await hooks.settle();
      expect(field("Why this energy target?").props.value).toBe("Later draft");
      expect(calls).toHaveLength(count);
    },
  );

  it.each(["write", "profile", "candidate"] as const)(
    "blocks New, reload and progress transitions during live %s work",
    async (phase) => {
      let active = false;
      const pending = deferred<Response>();
      const { calls } = await copyWorkspace({
        intercept: ({ path, init }) =>
          active &&
          (phase === "write"
            ? init?.method === "POST"
            : phase === "profile"
              ? path === "/api/profile"
              : path.startsWith("/api/goals/reference-target-sets?"))
            ? pending.promise
            : undefined,
      });
      await editGoalDraft();
      const old = [button("New goal"), button(reloadGoalLabel)],
        dateInput = field("Progress date");
      const before = goalDraftValues();
      active = true;
      if (phase === "write") void submit();
      else if (phase === "profile") invoke(button("Save profile and check eligibility"), "onClick");
      else invoke(field("Effective from"), "onBlur");
      const count = calls.length;
      for (const node of old) invoke(node, "onClick");
      invoke(dateInput, "onChange", { target: { value: "2026-09-12" } });
      invoke(dateInput, "onBlur");
      await hooks.settle();
      expect(goalDraftValues()).toEqual(before);
      expect(field("Progress date").props.value).toBe(day);
      expect(calls).toHaveLength(count);
      hooks.render();
      expect(button("New goal").props.disabled).toBe(true);
      expect(button(reloadGoalLabel).props.disabled).toBe(true);
      active = false;
      pending.resolve(Response.json({ message: "Temporary failure" }, { status: 503 }));
      await hooks.settle();
      expect(goalDraftValues()).toEqual(before);
    },
  );

  it.each(["new", "reload", "date"] as const)(
    "preserves an ambiguous save body, key and revision across declined %s",
    async (action) => {
      const { calls } = await copyWorkspace({
        intercept: ({ init }) =>
          init?.method === "POST" ? Response.json({}, { status: 503 }) : undefined,
      });
      await editGoalDraft();
      await submit();
      await hooks.settle();
      const first = required(writes(calls)[0]),
        before = goalDraftValues(),
        count = calls.length;
      await askGoalReplacement(action);
      await click("Keep editing");
      expect(goalDraftValues()).toEqual(before);
      expect(calls).toHaveLength(count);
      await submit();
      await hooks.settle();
      const second = required(writes(calls)[1]);
      expect(second.path).toBe(first.path);
      expect(second.init?.body).toBe(first.init?.body);
      expect(new Headers(second.init?.headers).get("idempotency-key")).toBe(
        new Headers(first.init?.headers).get("idempotency-key"),
      );
      expect(new Headers(second.init?.headers).get("if-match")).toBe('"3"');
    },
  );
});

describe("goal conflict draft recovery", () => {
  it.each(["verified", "unavailable"] as const)(
    "keeps a 409 draft blocked when eligibility refresh is %s until explicit recovery",
    async (refresh) => {
      let rejected = false;
      const { calls } = await copyWorkspace({
        intercept: ({ path, init }) => {
          if (init?.method === "POST") {
            rejected = true;
            return Response.json({ message: "Eligibility changed" }, { status: 409 });
          }
          if (rejected && path === "/api/auth/me")
            return refresh === "unavailable"
              ? Response.json({}, { status: 503 })
              : session()
                  .json()
                  .then((body) => {
                    body.data.profile.revision = "5";
                    return Response.json(body);
                  });
          if (rejected && path.startsWith("/api/goals/reference-target-sets?")) {
            const body = manualReferences();
            body.data.profileRevision = "5";
            return Response.json(body);
          }
          return undefined;
        },
      });
      await editGoalDraft();
      const before = goalDraftValues();
      await submit();
      await hooks.settle();
      expect(goalDraftValues()).toEqual(before);
      expect(writes(calls)).toHaveLength(1);
      expect(hasButton(discardReloadGoalLabel)).toBe(true);
      await submit();
      await hooks.settle();
      expect(writes(calls)).toHaveLength(1);
      invoke(field("Profile-derived estimate"), "onChange");
      await hooks.settle();
      invoke(field("Fixed target"), "onChange");
      await hooks.settle();
      await submit();
      await hooks.settle();
      expect(writes(calls)).toHaveLength(1);
      expect(field("Why this energy target?").props.value).toBe(
        "  Raw energy rationale\nkeep spacing  ",
      );
      if (refresh === "verified") {
        const group = required(
          elements().find(
            (node) => node.type === "input" && node.props.name === "reference-target-group",
          ),
        );
        invoke(group, "onChange");
        await hooks.settle();
        const acknowledgement = required(
          elements().find((node) => node.type === "input" && node.props.type === "checkbox"),
        );
        invoke(acknowledgement, "onChange", { target: { checked: true } });
        await hooks.settle();
        invoke(button("Apply 12 values to unsaved draft"), "onClick");
        await hooks.settle();
        await submit();
        await hooks.settle();
        expect(writes(calls)).toHaveLength(1);
      }
    },
  );

  it.each(["GOAL_OWNER_CHANGED", "PROFILE_OWNER_CHANGED"] as const)(
    "clears private drafts for the explicit %s response",
    async (code) => {
      const { calls } = await copyWorkspace({
        intercept: ({ init }) =>
          init?.method === "POST" ? Response.json({ code }, { status: 409 }) : undefined,
      });
      await editGoalDraft();
      await askGoalReplacement("new");
      const old = button(discardNewGoalLabel);
      await submit();
      await hooks.settle();
      expect(router.replace).toHaveBeenCalledWith("/login");
      expect(targetRows()).toHaveLength(0);
      const before = rawEditor(),
        count = calls.length;
      invoke(old, "onClick");
      await hooks.settle();
      expect(rawEditor()).toEqual(before);
      expect(calls).toHaveLength(count);
    },
  );

  it("rejects a retained conflict discard after a later edit, then reloads only through the current control", async () => {
    const { calls, setGoal } = await copyWorkspace({
      intercept: ({ init }) =>
        init?.method === "POST" ? Response.json({}, { status: 412 }) : undefined,
    });
    await editGoalDraft();
    await submit();
    await hooks.settle();
    const old = button(discardReloadGoalLabel);
    await change("Calcium target mg", "998.000000000001");
    const count = calls.length;
    invoke(old, "onClick");
    await hooks.settle();
    expect(calls).toHaveLength(count);
    expect(field("Calcium target mg").props.value).toBe("998.000000000001");
    setGoal(savedGoal(undefined, "4"));
    await click(discardReloadGoalLabel);
    expect(text()).toContain("GOAL REVISION 4");
    assertSavedRows();
    expect(writes(calls)).toHaveLength(1);
    expect(hasButton(discardReloadGoalLabel)).toBe(false);
  });

  it("clears only a definitively rejected operation while retaining an earlier ambiguous body for safe replay", async () => {
    let postCount = 0;
    const { calls } = await copyWorkspace({
      intercept: ({ init }) =>
        init?.method === "POST"
          ? Response.json({}, { status: ++postCount === 2 ? 412 : 503 })
          : undefined,
    });
    await editGoalDraft();
    await submit();
    await hooks.settle();
    const first = required(writes(calls)[0]);
    await change("Why this energy target?", "Different rejected body");
    await submit();
    await hooks.settle();
    await change("Why this energy target?", "  Raw energy rationale\nkeep spacing  ");
    await submit();
    await hooks.settle();
    const replay = required(writes(calls)[2]);
    expect(replay.init?.body).toBe(first.init?.body);
    expect(new Headers(replay.init?.headers).get("idempotency-key")).toBe(
      new Headers(first.init?.headers).get("idempotency-key"),
    );
    expect(new Headers(replay.init?.headers).get("if-match")).toBe('"3"');
  });
});

describe("goal replacement read recovery", () => {
  it("recovers an initial session failure through Retry before loading private goal data", async () => {
    let authFailed = true;
    const { calls } = await copyWorkspace({
      intercept: ({ path }) =>
        path === "/api/auth/me" && authFailed ? Response.json({}, { status: 503 }) : undefined,
    });
    expect(calls.filter((call) => call.path.startsWith("/api/goals/current?"))).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    authFailed = false;
    await click("Retry goals");
    expect(calls.filter((call) => call.path === "/api/auth/me")).toHaveLength(2);
    expect(calls.filter((call) => call.path.startsWith("/api/goals/current?"))).toHaveLength(1);
    assertSavedRows();
    expect(button(copyLabel).props.disabled).toBe(false);
  });

  it.each(["auth", "goal"] as const)(
    "preserves a later edit made during an explicit replacement's pending %s response",
    async (phase) => {
      let pendingRead = false;
      const pending = deferred<Response>();
      const { setGoal } = await copyWorkspace({
        intercept: ({ path }) =>
          pendingRead &&
          (phase === "auth" ? path === "/api/auth/me" : path.startsWith("/api/goals/current?"))
            ? pending.promise
            : undefined,
      });
      await editGoalDraft();
      await click(reloadGoalLabel);
      pendingRead = true;
      await click(discardReloadGoalLabel);
      await change("Why this energy target?", "Later edit during replacement");
      expect(field("Why this energy target?").props.value).toBe("Later edit during replacement");
      const before = goalDraftValues();
      const newer = savedGoal(undefined, "4");
      setGoal(newer);
      pendingRead = false;
      pending.resolve(phase === "auth" ? session() : Response.json({ data: { goal: newer } }));
      await hooks.settle();
      expect(goalDraftValues()).toEqual(before);
      expect(text()).toContain("GOAL REVISION 3");
      expect(text()).not.toContain("GOAL REVISION 4");
    },
  );
});

describe("goal read retry and accepted save status", () => {
  it("retries an initial goal read failure without a URL date after authentication succeeded", async () => {
    navigation.query = "";
    let fail = true;
    const { calls } = await copyWorkspace({
      intercept: ({ path }) =>
        fail && path.startsWith("/api/goals/current?")
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    expect(calls.filter((call) => call.path === "/api/auth/me")).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith("/api/goals/current?"))).toHaveLength(1);
    expect(status()).toContain("could not be loaded");
    fail = false;
    await click("Retry goals");
    const reads = calls.filter((call) => call.path.startsWith("/api/goals/current?"));
    expect(reads).toHaveLength(2);
    expect(reads[1]?.path).toBe(reads[0]?.path);
    assertSavedRows();
    expect(button(copyLabel).props.disabled).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("reports an accepted publication and preserves its revision when follow-up reading fails", async () => {
    let published = false;
    const accepted = savedGoal(undefined, "4");
    accepted.currentVersion.energy.targetKcal = "2200.000001";
    const { calls, setGoal } = await copyWorkspace({
      intercept: ({ path, init }) => {
        if (init?.method === "POST") {
          published = true;
          return Response.json({ data: { replayed: false, goal: accepted } });
        }
        if (published && path.startsWith("/api/goals/current?"))
          return Response.json({}, { status: 503 });
        return undefined;
      },
    });
    await change("Daily energy (kcal)", "2200.000001");
    await submit();
    await hooks.settle();
    expect(text()).toContain("GOAL REVISION 4");
    expect(field("Daily energy (kcal)").props.value).toBe("2200.000001");
    expect(status().toLowerCase()).toContain("published");
    expect(status().toLowerCase()).toContain("refresh");
    expect(status()).not.toContain("retry safely");
    expect(writes(calls)).toHaveLength(1);
    published = false;
    setGoal(accepted);
    await click("Retry goals");
    expect(hasButton(discardReloadGoalLabel)).toBe(false);
    expect(calls.filter((call) => call.path.startsWith("/api/goals/current?"))).toHaveLength(3);
    expect(text()).toContain("GOAL REVISION 4");
    expect(field("Daily energy (kcal)").props.value).toBe("2200.000001");
  });
});

describe("goal progress limit labels", () => {
  type Row = GoalProgressView["nutrients"][number];
  const calcium: Row = {
    nutrientId: "1087",
    code: "CALCIUM",
    name: "Calcium",
    unit: "mg",
    knownAmount: "10.000000",
    completeness: "complete",
    amountInterpretation: "exact",
    minimum: { amount: "2.345000", state: "met" },
    target: null,
    maximum: { amount: "12.345000", state: "within" },
  };

  async function renderRow(row: Row) {
    const original = structuredClone(row);
    const goal = savedGoal();
    const { calls } = await workspace({
      goal,
      intercept: ({ path }) =>
        path.startsWith("/api/goals/progress?")
          ? Response.json({
              data: {
                ...progress().data,
                goal: { id: goal.id, versionId: goal.currentVersion.id, revision: goal.revision },
                nutrients: [row],
              },
            })
          : undefined,
    });
    const child = required(
      elements().find(
        (node) =>
          typeof node.type === "function" &&
          (node.props.row as Row | undefined)?.nutrientId === row.nutrientId,
      ),
    );
    // Render the real nested ProgressRow, which the state harness leaves unevaluated.
    const markup = renderToStaticMarkup(child as unknown as ReactElement);
    const visible = markup.replace(/<[^>]+>/gu, "").replaceAll("&lt;", "<");
    const label = required(/aria-label="([^"]+)"/u.exec(markup)?.[1]).replaceAll("&lt;", "<");
    expect(row).toEqual(original);
    expect(writes(calls)).toHaveLength(0);
    return { markup, visible, label };
  }

  it("shows formatted limits and exact accessible thresholds without inventing a daily target", async () => {
    const { markup, visible, label } = await renderRow(calcium);
    expect(visible).toContain("minimum 2.3 mg (met)");
    expect(visible).toContain("maximum 12.3 mg (within)");
    expect(visible).toContain("No daily target · Complete quantified coverage");
    expect(visible).not.toContain("2.345000");
    expect(visible).not.toContain("12.345000");
    expect(label).toBe(
      "Calcium: 10 mg. No daily target. Complete quantified coverage. Minimum 2.345000 mg: met. Maximum 12.345000 mg: within.",
    );
    expect(markup).not.toContain("progressTrack");
  });

  it.each([
    ["minimum", "0.000000", "met", "0 mg (met)"],
    ["maximum", "0.000000", "within", "0 mg (within)"],
    ["minimum", "0.000000000001", "below", "<0.1 mg (below)"],
    ["maximum", "0.000000000001", "within", "<0.1 mg (within)"],
  ] as const)(
    "retains a %s-only zero or tiny saved limit %s",
    async (kind, amount, state, formatted) => {
      const { markup, visible, label } = await renderRow({
        ...calcium,
        knownAmount: "0",
        minimum: kind === "minimum" ? { amount, state } : null,
        maximum: kind === "maximum" ? { amount, state } : null,
      });
      expect(visible).toContain(`${kind} ${formatted}`);
      expect(label).toContain(
        `${kind === "minimum" ? "Minimum" : "Maximum"} ${amount} mg: ${state}.`,
      );
      expect(visible).not.toContain(kind === "minimum" ? "maximum" : "minimum");
      expect(markup).not.toContain("progressTrack");
    },
  );

  it("preserves partial lower bounds and server comparisons when rounded amounts look equal", async () => {
    const { markup, visible, label } = await renderRow({
      ...calcium,
      knownAmount: "4.299999",
      completeness: "partial",
      amountInterpretation: "lower_bound",
      minimum: { amount: "4.299998", state: "met" },
      target: { amount: "10", lowerBoundPercent: "42.99999", percentIsExact: false },
      maximum: { amount: "4.299998", state: "exceeded" },
    });
    expect(visible).toContain("at least 4.2 mg");
    expect(visible).toContain("Target 10 mg · Partial coverage");
    expect(visible).toContain("minimum 4.3 mg (met)");
    expect(visible).toContain("maximum 4.3 mg (exceeded)");
    expect(label).toContain("shown amount is a quantified lower bound.");
    expect(label).toContain("Minimum 4.299998 mg: met. Maximum 4.299998 mg: exceeded.");
    expect(markup).toContain('style="width:42.99999%"');
  });

  it("keeps unknown intake separate from saved limits and an unavailable comparison", async () => {
    const { markup, visible, label } = await renderRow({
      ...calcium,
      knownAmount: "0",
      completeness: "unknown",
      amountInterpretation: "lower_bound",
      minimum: { amount: "8.000000", state: "indeterminate" },
      maximum: { amount: "45.000000", state: "indeterminate" },
    });
    expect(visible).toContain("CalciumUnknown");
    expect(visible).toContain("Unknown coverage — zero is not a measured zero");
    expect(visible).toContain("minimum 8 mg (indeterminate)");
    expect(visible).toContain("maximum 45 mg (indeterminate)");
    expect(label).toContain("Calcium: Unknown. No daily target. Unknown coverage");
    expect(label).toContain(
      "Minimum 8.000000 mg: indeterminate. Maximum 45.000000 mg: indeterminate.",
    );
    expect(markup).not.toContain("progressTrack");
  });

  it("leaves a target-only row and its accessibility and progress intact", async () => {
    const { markup, visible, label } = await renderRow({
      ...calcium,
      minimum: null,
      maximum: null,
      target: { amount: "20.000000", lowerBoundPercent: "50", percentIsExact: true },
    });
    expect(visible).toBe("Calcium10 mgTarget 20 mg · Complete quantified coverage");
    expect(label).toBe("Calcium: 10 mg. Target 20 mg. Complete quantified coverage.");
    expect(markup).toContain('style="width:50%"');
  });
});
