import { describe, expect, it } from "vitest";

import type { GoalView } from "../../lib/recipes-goals";
import { emptyGoal, goalBody, goalBuilderFromGoal, goalBuilderIsHistorical } from "./GoalsClient";

const fixedGoal = {
  id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
  status: "active",
  revision: "3",
  versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
  versionNumber: 3,
  effectiveFrom: "2026-08-16",
  effectiveTo: null,
  energy: { mode: "fixed", targetKcal: "2100", rationale: "Selected with my clinician." },
  targets: [
    {
      nutrientId: "1087",
      code: "CALCIUM",
      name: "Calcium",
      unit: "mg",
      category: "mineral",
      minimumAmount: "800",
      targetAmount: "1000",
      maximumAmount: "2500",
      targetSource: "National reference",
      targetSourceVersion: "2026",
      rationale: "Personal target rationale",
    },
  ],
  notice: "General wellness estimate; not medical advice.",
} satisfies GoalView;

describe("web goal builder integrity", () => {
  it("starts without an implicit energy recommendation or nutrient source", () => {
    const builder = emptyGoal("2026-08-16");
    expect(builder.fixedKcal).toBe("");
    expect(builder.rationale).toBe("");
    expect(builder.activityLevelCode).toBe("");
    expect(builder.activityFactor).toBe("");
    expect(builder.targets).toEqual([]);
  });

  it("preserves immutable target rationale/source metadata and leaves derived fields unselected", () => {
    const builder = goalBuilderFromGoal(fixedGoal);
    expect(builder.activityLevelCode).toBe("");
    expect(builder.activityFactor).toBe("");
    expect(builder.palAcknowledged).toBe(false);
    expect(builder.targets[0]).toMatchObject({
      sourceLabel: "National reference",
      sourceVersion: "2026",
      rationale: "Personal target rationale",
    });
  });

  it("treats a closed loaded goal as read-only and a new draft as independently editable", () => {
    const closedGoal = { ...fixedGoal, effectiveTo: "2026-09-01" } satisfies GoalView;
    expect(goalBuilderIsHistorical(closedGoal, goalBuilderFromGoal(closedGoal))).toBe(true);
    expect(goalBuilderIsHistorical(closedGoal, emptyGoal("2026-09-02"))).toBe(false);
  });

  it("round-trips user-authored goal metadata without silently normalizing a revision", () => {
    const builder = goalBuilderFromGoal(fixedGoal);
    const target = builder.targets[0];
    if (!target) throw new Error("Expected the fixture target.");
    const request = goalBody({
      ...builder,
      rationale: " Selected with my clinician. ",
      targets: [
        {
          ...target,
          sourceLabel: " National reference ",
          sourceVersion: " 2026 ",
          rationale: " Personal target rationale ",
        },
      ],
    });
    expect(request).not.toHaveProperty("effectiveFrom");
    expect(request.energy.rationale).toBe(" Selected with my clinician. ");
    expect(request.nutrientTargets[0]).toMatchObject({
      source: { label: " National reference ", version: " 2026 " },
      rationale: " Personal target rationale ",
    });
  });

  it("rejects a PAL factor outside the explicitly selected reviewed category", () => {
    expect(() =>
      goalBody({
        ...emptyGoal("2026-08-16"),
        energyMode: "derived",
        activityLevelCode: "sedentary_or_light",
        activityFactor: "1.70",
        palAcknowledged: true,
        rationale: "My explicit estimate inputs.",
      }),
    ).toThrow("outside the selected reviewed category");
  });
});
