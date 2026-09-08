import type {
  GoalNutrientDefinitionRecord,
  NutritionGoalRecord,
  NutritionGoalReferenceRecord,
  NutritionReportAggregateRecord,
  NutritionReportSnapshotRecord,
} from "@nutrition-tracker/db";
import { getNutritionReportSnapshot, NutritionReportCapacityError } from "@nutrition-tracker/db";
import { CORE_NUTRIENTS } from "@nutrition-tracker/domain";
import { describe, expect, it, vi } from "vitest";

import { NutritionReportCapacityServiceError } from "../src/modules/reports/nutrition-report.routes.js";
import {
  DatabaseNutritionReportService,
  mapNutritionReportSnapshot,
} from "../src/nutrition-report-persistence-service.js";

vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  getNutritionReportSnapshot: vi.fn(),
}));

const ownerUserId = "10000000-0000-4000-8000-000000000001";
const diaryId = "20000000-0000-4000-8000-000000000001";

const definitions: readonly GoalNutrientDefinitionRecord[] = CORE_NUTRIENTS.map(
  (nutrient, index) => ({
    category: nutrient.category,
    code: nutrient.id,
    id: String(index + 1),
    name: nutrient.name,
    unit: nutrient.canonicalUnit,
  }),
);

function definitionByCode(code: string): GoalNutrientDefinitionRecord {
  const definition = definitions.find((candidate) => candidate.code === code);
  if (!definition) throw new TypeError(`Missing test nutrient definition: ${code}`);
  return definition;
}

function aggregate(
  definition: GoalNutrientDefinitionRecord,
  state: "exact" | "trace" | "unknown",
): NutritionReportAggregateRecord {
  return {
    code: definition.code,
    completeness: state === "unknown" ? "unknown" : "complete",
    contributorCount: 1,
    isExact: state === "exact",
    knownAmount: state === "exact" && definition.code !== "energy" ? "10" : "0",
    name: definition.name,
    nutrientId: definition.id,
    quantifiedCount: state === "exact" ? 1 : 0,
    traceCount: state === "trace" ? 1 : 0,
    unit: definition.unit,
    unknownCount: state === "unknown" ? 1 : 0,
    unknownReasons: {
      not_analyzed: 0,
      not_applicable: 0,
      not_reported: state === "unknown" ? 1 : 0,
      withheld: 0,
    },
  };
}

function goal(input: {
  id: string;
  versionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  energyTarget: string;
  proteinTarget: string;
  referenceTargetSet?: NutritionGoalReferenceRecord;
}): NutritionGoalRecord {
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    currentRevision: "1",
    currentVersion: {
      calculationVersion: "nutrition-engine-v1",
      createdAt: "2026-09-01T00:00:00.000Z",
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      energy: {
        mode: "fixed",
        rationale: "User-selected report target.",
        source: { code: "user-fixed", version: "1" },
        targetKcal: input.energyTarget,
      },
      id: input.versionId,
      referenceTargetSet: input.referenceTargetSet ?? null,
      status: "active",
      targets: [
        {
          maximumAmount: null,
          minimumAmount: null,
          nutrient: definitionByCode("protein"),
          rationale: "User-selected report target.",
          source: { label: "User supplied", version: null },
          targetAmount: input.proteinTarget,
        },
      ],
      versionNumber: "1",
    },
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    id: input.id,
    status: "active",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function snapshot(): NutritionReportSnapshotRecord {
  return {
    days: [
      {
        aggregates: definitions.map((definition) =>
          aggregate(definition, definition.code === "protein" ? "trace" : "exact"),
        ),
        endsAt: "2026-09-02T05:00:00.000Z",
        entryCount: 1,
        localDate: "2026-09-01",
        sourceDiaries: [{ id: diaryId, localDate: "2026-09-01", revision: "2" }],
        sourceTimeZones: ["America/Chicago"],
        startsAt: "2026-09-01T05:00:00.000Z",
      },
      {
        aggregates: definitions.map((definition) => aggregate(definition, "unknown")),
        endsAt: "2026-09-03T05:00:00.000Z",
        entryCount: 1,
        localDate: "2026-09-02",
        sourceDiaries: [{ id: diaryId, localDate: "2026-09-02", revision: "3" }],
        sourceTimeZones: ["America/Chicago"],
        startsAt: "2026-09-02T05:00:00.000Z",
      },
      {
        aggregates: [],
        endsAt: "2026-09-04T05:00:00.000Z",
        entryCount: 0,
        localDate: "2026-09-03",
        sourceDiaries: [],
        sourceTimeZones: [],
        startsAt: "2026-09-03T05:00:00.000Z",
      },
    ],
    definitions,
    fromLocalDate: "2026-09-01",
    goals: [
      goal({
        effectiveFrom: "2026-09-01",
        effectiveTo: "2026-09-02",
        energyTarget: "2000",
        id: "30000000-0000-4000-8000-000000000001",
        proteinTarget: "30",
        versionId: "40000000-0000-4000-8000-000000000001",
      }),
      goal({
        effectiveFrom: "2026-09-02",
        effectiveTo: null,
        energyTarget: "2500",
        id: "30000000-0000-4000-8000-000000000002",
        proteinTarget: "25",
        versionId: "40000000-0000-4000-8000-000000000002",
      }),
    ],
    ownerUserId,
    profileRevision: "4",
    profileTimeZone: "America/Chicago",
    snapshotAt: "2026-09-04T12:00:00.000Z",
    toLocalDate: "2026-09-03",
    watermarkRevision: "9",
  };
}

describe("nutrition report persistence mapper", () => {
  it("maps report capacity separately from range validation", async () => {
    vi.mocked(getNutritionReportSnapshot).mockRejectedValueOnce(
      new NutritionReportCapacityError("fixture capacity"),
    );
    const service = new DatabaseNutritionReportService({} as never);

    await expect(
      service.getNutritionReport({
        from: "2026-09-01",
        to: "2026-09-01",
        userId: ownerUserId,
      }),
    ).rejects.toBeInstanceOf(NutritionReportCapacityServiceError);
  });

  it("preserves exact zero, trace, unknown, missing-day, and goal-boundary semantics", () => {
    const result = mapNutritionReportSnapshot(snapshot()).data;

    expect(result.ownerUserId).toBe(ownerUserId);
    expect(result.dateBasis).toBe("active-profile-time-zone-v1");
    expect(result.goalVersionBasis).toBe("current-version-at-report-snapshot-v1");
    expect(result.targetSegments).toEqual([
      {
        from: "2026-09-01",
        goalVersionId: "40000000-0000-4000-8000-000000000001",
        to: "2026-09-01",
      },
      {
        from: "2026-09-02",
        goalVersionId: "40000000-0000-4000-8000-000000000002",
        to: "2026-09-03",
      },
    ]);

    const energy = result.series.find((candidate) => candidate.nutrient.code === "energy");
    expect(energy).toMatchObject({
      scaleMaximum: "2500",
      scalePolicy: "max-intake-or-saved-threshold-v1",
      summary: {
        completeDays: 1,
        diaryDays: 2,
        exactDays: 1,
        missingDays: 1,
        unknownDays: 1,
      },
    });
    expect(energy?.points[0]).toMatchObject({
      aggregate: { isExact: true, knownAmount: "0" },
      knownPercentOfScale: "0",
      targetPercentOfScale: "80",
    });
    expect(energy?.points[1]).toMatchObject({
      aggregate: { completeness: "unknown", isExact: false, knownAmount: "0" },
      comparison: { targetLowerBoundPercent: "0", targetPercentIsExact: false },
      targetPercentOfScale: "100",
    });
    expect(energy?.points[2]).toMatchObject({
      aggregate: null,
      comparison: null,
      knownPercentOfScale: null,
      targetPercentOfScale: "100",
    });

    const protein = result.series.find((candidate) => candidate.nutrient.code === "protein");
    expect(protein).toMatchObject({
      scaleMaximum: "30",
      summary: {
        completeDays: 1,
        diaryDays: 2,
        exactDays: 0,
        missingDays: 1,
        traceDays: 1,
        unknownDays: 1,
      },
    });
    expect(protein?.points[0]).toMatchObject({
      aggregate: {
        completeness: "complete",
        isExact: false,
        knownAmount: "0",
        traceCount: 1,
      },
      comparison: { targetLowerBoundPercent: "0", targetPercentIsExact: false },
    });
    expect(result.goalVersions).toHaveLength(2);
    expect(result.series).toHaveLength(CORE_NUTRIENTS.length);
  });

  it("fails closed when a nonempty day omits a core aggregate", () => {
    const record = snapshot();
    const [firstDay, ...remainingDays] = record.days;
    if (!firstDay) throw new TypeError("Test snapshot requires a first day");
    const inconsistent: NutritionReportSnapshotRecord = {
      ...record,
      days: [{ ...firstDay, aggregates: firstDay.aggregates.slice(1) }, ...remainingDays],
    };

    expect(() => mapNutritionReportSnapshot(inconsistent)).toThrow(
      "Nutrition report missing-day semantics are inconsistent",
    );
  });

  it("stops reference target markers on the exclusive eligibility date", () => {
    const record = snapshot();
    const initialGoal = record.goals[0];
    if (!initialGoal) throw new TypeError("Test snapshot requires an initial goal");
    const expiringGoal = goal({
      effectiveFrom: "2026-09-02",
      effectiveTo: null,
      energyTarget: "2500",
      id: "30000000-0000-4000-8000-000000000002",
      proteinTarget: "25",
      referenceTargetSet: {
        acknowledgement: {
          accepted: true,
          acceptedAt: "2026-09-01T12:00:00.000Z",
          policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
          policyVersion: "1",
        },
        ageYears: 50,
        appliedProfileRevision: "4",
        eligibleThroughExclusive: "2026-09-03",
        groupCode: "male-19-50",
        policyDigest: "a".repeat(64),
        templateCode: "us-ca-dri-adults-19-50",
        templateVersion: "1",
      },
      versionId: "40000000-0000-4000-8000-000000000002",
    });
    const result = mapNutritionReportSnapshot({
      ...record,
      goals: [initialGoal, expiringGoal],
    }).data;

    expect(result.targetSegments).toEqual([
      {
        from: "2026-09-01",
        goalVersionId: "40000000-0000-4000-8000-000000000001",
        to: "2026-09-01",
      },
      {
        from: "2026-09-02",
        goalVersionId: "40000000-0000-4000-8000-000000000002",
        to: "2026-09-02",
      },
      { from: "2026-09-03", goalVersionId: null, to: "2026-09-03" },
    ]);
    expect(result.goalVersions[1]?.reference).toMatchObject({
      eligibleThroughExclusive: "2026-09-03",
      groupCode: "male-19-50",
    });
    for (const series of result.series) {
      expect(series.points[2]).toMatchObject({
        comparison: null,
        goalVersionId: null,
        maximumPercentOfScale: null,
        minimumPercentOfScale: null,
        targetPercentOfScale: null,
      });
    }
  });
});
