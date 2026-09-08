import { describe, expect, it } from "vitest";

import {
  nativeAppliedReferenceMatchesGoal,
  nativeAppliedReferenceSetForDisplay,
  nativeCarriedReferenceSet,
  nativeReferenceDraftTargets,
  nativeReferenceGoalRequest,
  nativeReferenceSelection,
  nativeReferenceTargetSectionVisible,
  parseNativeReferenceTargetSets,
} from "./reference-targets";

const base =
  "https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes";
const macros = `${base}/tables/reference-values-macronutrients.html`;
const elements = `${base}/tables/reference-values-elements.html`;
const vitamins = `${base}/tables/reference-values-vitamins.html`;

function fixture() {
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
  ] as const;
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

function firstSet<T>(value: { readonly sets: readonly T[] }): T {
  const set = value.sets[0];
  if (!set) throw new Error("Expected one candidate set in the fixture.");
  return set;
}

describe("mobile source-verified candidate targets", () => {
  it("hides all candidate advertising for a disabled 404 until discovery succeeds", () => {
    expect(nativeReferenceTargetSectionVisible(false, null)).toBe(false);
    expect(nativeReferenceTargetSectionVisible(true, null)).toBe(false);
    expect(
      nativeReferenceTargetSectionVisible(true, parseNativeReferenceTargetSets(fixture())),
    ).toBe(true);
  });

  it("parses exact rows and creates an explicit acknowledged selection", () => {
    const parsed = parseNativeReferenceTargetSets(fixture());
    const set = firstSet(parsed);
    expect(set.targets).toHaveLength(12);
    expect(parsed.applied?.set.targets).toHaveLength(12);
    expect(parsed.applied?.acknowledgement.acceptedAt).toBe("2026-09-07T18:30:00.000Z");
    expect(nativeReferenceSelection(parsed, set)).toMatchObject({
      groupCode: "male-19-50",
      eligibilityAcknowledgement: { accepted: true, policyVersion: "1" },
    });
    expect(nativeReferenceDraftTargets(set)[5]).toMatchObject({
      targetAmount: "1000",
      maximumAmount: "2500",
    });
    expect(
      nativeAppliedReferenceMatchesGoal(parsed.applied, {
        id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
        versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
        revision: "3",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched persisted snapshot or malformed acknowledgement timestamp", () => {
    const mismatched = fixture();
    mismatched.data.applied.set.policyDigest = "b".repeat(64);
    expect(() => parseNativeReferenceTargetSets(mismatched)).toThrow("snapshot identity");

    const malformed = fixture();
    malformed.data.applied.acknowledgement.acceptedAt = "2026-09-07";
    expect(() => parseNativeReferenceTargetSets(malformed)).toThrow("provenance");
  });

  it("rejects a source/version swap and accepts unavailable revision-zero profiles", () => {
    const swapped = fixture();
    const swappedTarget = firstSet(swapped.data).targets[0];
    if (!swappedTarget) throw new Error("Expected a first fixture target.");
    (swappedTarget.source as { version: string }).version = "HC-2025-11-19/IOM-2000";
    expect(() => parseNativeReferenceTargetSets(swapped)).toThrow("pinned policy row");

    const unavailable = fixture();
    const mutable = unavailable.data as unknown as {
      profileRevision: string;
      availability: { available: boolean; reasonCodes: string[] };
      sets: unknown[];
    };
    mutable.profileRevision = "0";
    mutable.availability = { available: false, reasonCodes: ["profile_missing_birth_date"] };
    mutable.sets = [];
    expect(parseNativeReferenceTargetSets(unavailable).profileRevision).toBe("0");
  });

  it("labels an explicit customized copy and clears no identity implicitly", () => {
    const parsed = parseNativeReferenceTargetSets(fixture());
    expect(nativeReferenceDraftTargets(firstSet(parsed), true)[0]).toMatchObject({
      sourceLabel: "User-customized copy of Health Canada Dietary Reference Intakes",
      rationale: "User-editable copy; verified reference-template identity cleared.",
    });
  });

  it("does not carry prior acknowledgement onto a changed profile revision", () => {
    const parsed = parseNativeReferenceTargetSets(fixture());
    const goal = {
      id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
      versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
      revision: "3",
    };
    expect(nativeCarriedReferenceSet(parsed, goal)?.groupCode).toBe("male-19-50");
    const drifted = { ...parsed, profileRevision: "5" };
    expect(nativeCarriedReferenceSet(drifted, goal)).toBeNull();
    expect(nativeAppliedReferenceSetForDisplay(drifted, goal)?.targets).toHaveLength(12);
    expect(nativeAppliedReferenceSetForDisplay(drifted, goal)?.groupCode).toBe("male-19-50");
  });

  it("builds an owner/profile-bound server-materialized goal body with no preview amounts", () => {
    const parsed = parseNativeReferenceTargetSets(fixture());
    const set = firstSet(parsed);
    expect(
      nativeReferenceGoalRequest(
        null,
        parsed.date,
        { mode: "fixed", targetKcal: "2100", rationale: "My energy target." },
        "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
        parsed.profileRevision,
        nativeReferenceSelection(parsed, set),
      ),
    ).toMatchObject({
      effectiveFrom: "2026-09-07",
      expectedOwnerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
      expectedProfileRevision: "4",
      nutrientTargets: [],
      referenceTargetSet: {
        groupCode: "male-19-50",
        eligibilityAcknowledgement: { accepted: true },
      },
    });
  });
});
