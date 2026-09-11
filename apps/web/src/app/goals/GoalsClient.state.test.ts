import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    invoke(button("New goal"), "onClick");
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

  it("preserves query through New and same-private reload, resets actual date", async () => {
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
    expect(field("Find a nutrient").props.value).toBe("");
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
      expect(field("Find a nutrient").props.value).toBe("");
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
  expect(button("Add nutrient").props.disabled).toBe(false);
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
