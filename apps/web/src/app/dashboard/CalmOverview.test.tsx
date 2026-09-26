import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteSession, otherNoteOwner } from "../../lib/day-notes.test-fixtures";
import { type DiaryDay, type DiaryEntry, type DiaryNutrient, parseSession } from "../../lib/diary";
import type { GoalProgressRowView, GoalProgressView } from "../../lib/recipes-goals";
import { CalmOverview } from "./CalmOverview";
import {
  goalPercent,
  goalPercentLabel,
  loadCalmGoalProgress,
  matchedGoalRow,
  mealEnergy,
  remainingEnergy,
} from "./calm-overview";

const session = parseSession(noteSession());
function nutrient(overrides: Partial<DiaryNutrient> = {}): DiaryNutrient {
  return {
    nutrientId: "1",
    code: "energy",
    name: "Energy",
    unit: "kcal",
    knownAmount: "125.5",
    completeness: "complete",
    isExact: true,
    contributorCount: 1,
    quantifiedCount: 1,
    traceCount: 0,
    unknownCount: 0,
    unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
    ...overrides,
  };
}
function entry(nutrients: readonly DiaryNutrient[] = [nutrient()]): DiaryEntry {
  const source = {
    code: "TEST",
    releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
    displayName: "Test source",
    licenseExpression: "CC0-1.0",
    attributionRequired: false,
    attributionText: "Test source",
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    revision: "1",
    entryKind: "food",
    foodVersionId: "202",
    recipeVersionId: null,
    portion: { kind: "grams", grams: "100" },
    food: { name: "Apples", brandName: null },
    recipe: null,
    source,
    foodProvenance: { kind: "public", source },
    mealSlot: "breakfast",
    resolvedGrams: "100",
    note: null,
    occurredAt: "2026-09-15T13:30:00.000Z",
    localDate: "2026-09-15",
    timeZone: "America/Chicago",
    localTime: "08:30:00",
    position: 0,
    nutrients,
  };
}
const day: DiaryDay = {
  id: null,
  localDate: "2026-09-15",
  timeZone: "America/Chicago",
  status: "open",
  revision: "8",
  orderDigest: "a".repeat(64),
  entries: [entry()],
  totals: [nutrient()],
  updatedAt: null,
};
function progressRow(overrides: Partial<GoalProgressRowView> = {}): GoalProgressRowView {
  return {
    nutrientId: "1",
    code: "energy",
    name: "Energy",
    unit: "kcal",
    knownAmount: "125.5",
    completeness: "complete",
    amountInterpretation: "exact",
    minimum: null,
    target: { amount: "2000", lowerBoundPercent: "6.275", percentIsExact: true },
    maximum: null,
    ...overrides,
  };
}
function progress(overrides: Partial<GoalProgressView> = {}): GoalProgressView {
  return {
    localDate: day.localDate,
    timeZone: day.timeZone,
    diaryRevision: day.revision,
    goal: {
      id: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      revision: "1",
    },
    energy: progressRow(),
    nutrients: [],
    notice: "General wellness estimate; not medical advice.",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
function load(
  options: {
    readonly isCurrent?: () => boolean;
    readonly onUnauthorized?: () => void;
    readonly signal?: AbortSignal;
  } = {},
) {
  return loadCalmGoalProgress({
    day,
    session,
    signal: options.signal ?? new AbortController().signal,
    isCurrent: options.isCurrent ?? (() => true),
    onUnauthorized: options.onUnauthorized ?? vi.fn(),
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("Calm overview nutrition semantics", () => {
  it("sums complete meal energy exactly without floating-point loss", () => {
    expect(
      mealEnergy([
        entry([nutrient({ knownAmount: "0.1" })]),
        entry([nutrient({ knownAmount: "0.2" })]),
      ]),
    ).toBe("0.3 kcal");
    expect(
      mealEnergy([
        entry([nutrient({ knownAmount: "9007199254740993.000000000001" })]),
        entry([nutrient({ knownAmount: "0.000000000001" })]),
      ]),
    ).toBe("9007199254740993.000000000002 kcal");
    expect(mealEnergy([entry([nutrient({ knownAmount: "0.000" })])])).toBe("0 kcal");
  });
  it("preserves absent, partial, trace, estimated and unknown energy", () => {
    expect(mealEnergy([])).toBe("No foods logged");
    expect(mealEnergy([entry([])])).toBe("Energy unknown");
    expect(
      mealEnergy([
        entry([nutrient({ completeness: "unknown", knownAmount: "0", isExact: false })]),
      ]),
    ).toBe("Energy unknown");
    for (const change of [
      { completeness: "partial" as const },
      { traceCount: 1 },
      { isExact: false },
    ]) {
      expect(mealEnergy([entry([nutrient(change)])])).toBe("≥ 125.5 kcal · lower bound");
    }
    expect(mealEnergy([entry(), entry([])])).toBe("≥ 125.5 kcal · lower bound");
  });
  it("shows only saved matching goal progress, and never maps unknown to zero", () => {
    expect(matchedGoalRow(nutrient(), progress({ goal: null }))).toBeNull();
    expect(
      matchedGoalRow(nutrient(), progress({ energy: progressRow({ knownAmount: "999" }) })),
    ).toBeNull();
    expect(
      matchedGoalRow(nutrient({ knownAmount: "125.500000000000" }), progress()),
    ).not.toBeNull();
    const percentageRow = (percent: string, exact: boolean) =>
      progressRow({
        target: { amount: "2000", lowerBoundPercent: percent, percentIsExact: exact },
        amountInterpretation: exact ? "exact" : "lower_bound",
      });
    expect(
      goalPercentLabel(
        nutrient(),
        percentageRow("81.2499999999999999999999999999999999999999", true),
      ),
    ).toBe("81.2%");
    expect(goalPercentLabel(nutrient(), percentageRow("81.24", true))).toBe("81.2%");
    expect(goalPercentLabel(nutrient(), percentageRow("81.25", true))).toBe("81.3%");
    expect(
      goalPercentLabel(
        nutrient(),
        percentageRow("81.2999999999999999999999999999999999999999", false),
      ),
    ).toBe("≥ 81.2%");
    expect(
      goalPercentLabel(
        nutrient(),
        percentageRow("99.9999999999999999999999999999999999999999", false),
      ),
    ).toBe("≥ 99.9%");
    expect(goalPercentLabel(nutrient(), percentageRow("1000", false))).toBe("≥ 1000%");
    expect(
      goalPercentLabel(
        nutrient(),
        percentageRow("0.0999999999999999999999999999999999999999", false),
      ),
    ).toBe("≥ 0%");
    expect(goalPercentLabel(nutrient(), percentageRow("10", true))).toBe("10%");
    expect(goalPercentLabel(nutrient({ completeness: "unknown" }), progressRow())).toBeNull();
    expect(goalPercentLabel(nutrient(), percentageRow("124.295", true))).toBe("124.3%");
    expect(goalPercentLabel(nutrient(), percentageRow("124.295", false))).toBe("≥ 124.2%");
    expect(goalPercent(nutrient(), percentageRow("124.295", true))).toBe(100);
    const row = matchedGoalRow(nutrient(), progress());
    expect(goalPercent(nutrient(), row)).toBe(6.275);
    expect(
      goalPercent(nutrient({ completeness: "unknown", knownAmount: "0" }), progressRow()),
    ).toBeNull();
    expect(goalPercent(nutrient(), progressRow({ target: null }))).toBeNull();
    expect(
      goalPercent(
        nutrient(),
        progressRow({
          target: { amount: "100", lowerBoundPercent: "125.5", percentIsExact: true },
        }),
      ),
    ).toBe(100);
  });
  it("computes remaining or over only from complete exact data and a positive saved target", () => {
    expect(remainingEnergy(nutrient(), progressRow())).toBe("1874.5 kcal remaining");
    expect(remainingEnergy(nutrient({ knownAmount: "2000.000000000001" }), progressRow())).toBe(
      "0.000000000001 kcal over saved target",
    );
    expect(remainingEnergy(nutrient({ knownAmount: "2000" }), progressRow())).toBe(
      "0 kcal remaining",
    );
    expect(
      remainingEnergy(
        nutrient(),
        progressRow({ target: { amount: "0", lowerBoundPercent: null, percentIsExact: true } }),
      ),
    ).toBeNull();
    for (const change of [
      { completeness: "partial" as const },
      { completeness: "unknown" as const },
      { traceCount: 1 },
      { isExact: false },
    ])
      expect(remainingEnergy(nutrient(change), progressRow())).toBeNull();
  });
  it("qualifies loaded meals while keeping whole-day totals and date-linked actions", () => {
    const markup = renderToStaticMarkup(
      <CalmOverview
        day={day}
        totalEntries={45}
        completeDayLoaded={false}
        session={session}
        isCurrent={() => true}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(markup).toContain("Totals cover all 45 diary entries");
    expect(markup).toContain("Macronutrients");
    expect(markup).toContain(
      'data-nutrient="protein" data-completeness="unknown" data-exact="false"',
    );
    expect(markup).toContain("Showing 1 of 45 entries");
    expect(markup).toContain("Meal counts cover loaded entries only");
    expect(markup).toContain("1 loaded entry");
    expect(markup.match(/Meal energy unavailable/gu)).toHaveLength(4);
    expect(markup).toContain('href="/foods?date=2026-09-15&amp;meal=breakfast"');
    expect(markup).toContain('href="/reports?to=2026-09-15"');
    expect(markup).not.toContain("calmEnergyRing");
    expect(markup).not.toContain("remaining");
    expect(markup).not.toContain("Meal illustration");
  });
  it("uses custom meal labels and leaves missing macro/snapshot values unknown", () => {
    const customSession = {
      ...session,
      profile: {
        ...session.profile,
        diaryGroups: session.profile.diaryGroups.map((group) =>
          group.mealSlot === "breakfast" ? { ...group, label: "Early meal" } : group,
        ),
      },
    };
    const markup = renderToStaticMarkup(
      <CalmOverview
        day={{ ...day, totals: [], entries: [] }}
        totalEntries={0}
        completeDayLoaded
        session={customSession}
        isCurrent={() => true}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(markup).toContain("Early meal");
    expect(markup.match(/>Unknown</gu)).toHaveLength(8);
    expect(markup).not.toMatch(/>0 (g|kcal)</u);
    expect(markup).not.toContain("calmProgressTrack");
  });
});

describe("Calm goal response ownership and freshness", () => {
  it("loads only the selected day, revalidates owner, and returns the matched saved goal", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: progress() }))
      .mockResolvedValueOnce(Response.json(noteSession()));
    vi.stubGlobal("fetch", fetch);
    expect(await load()).toEqual(progress());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/goals/progress?date=2026-09-15",
      "/api/auth/me",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });
  it.each([{ localDate: "2026-09-16" }, { timeZone: "UTC" }, { diaryRevision: "9" }])(
    "rejects mismatched day snapshot %j",
    async (change) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ data: progress(change) }))
          .mockResolvedValueOnce(Response.json(noteSession())),
      );
      await expect(load()).rejects.toThrow("Your diary changed");
    },
  );
  it("closes private UI for a current unauthorized response or another owner", async () => {
    const closed = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })));
    expect(await load({ onUnauthorized: closed })).toBeNull();
    expect(closed).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: progress() }))
        .mockResolvedValueOnce(Response.json(noteSession(otherNoteOwner))),
    );
    expect(await load({ onUnauthorized: closed })).toBeNull();
    expect(closed).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed profile before revealing goal targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: progress() }))
        .mockResolvedValueOnce(Response.json(noteSession(undefined, "UTC"))),
    );
    await expect(load()).rejects.toThrow("Your profile changed");
  });
  it("ignores an old date/generation response, including a stale 401", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetch);
    let current = true;
    const closed = vi.fn();
    const request = load({ isCurrent: () => current, onUnauthorized: closed });
    current = false;
    pending.resolve(new Response(null, { status: 401 }));
    expect(await request).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("ignores delayed JSON and unmount/abort even if the transport resolves", async () => {
    const body = deferred<unknown>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const request = load({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    body.resolve({ data: progress() });
    expect(await request).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not erase nutrition data by converting failed goal loading to zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));
    await expect(load()).rejects.toThrow("Saved targets could not be loaded");
  });
});
