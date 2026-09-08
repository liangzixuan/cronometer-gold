import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyReferenceTargetSets } from "../app/api/goals/proxy";
import { SESSION_COOKIE } from "./private-api";
import {
  appliedReferenceMatchesGoal,
  appliedReferenceSetForDisplay,
  carriedReferenceSet,
  parseReferenceTargetSets,
  referenceTargetSectionVisible,
  referenceTargetSelection,
  referenceTargetsForDraft,
} from "./reference-targets";

afterEach(() => vi.unstubAllGlobals());

function response() {
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

function firstSet<T>(value: { readonly sets: readonly T[] }): T {
  const set = value.sets[0];
  if (!set) throw new Error("Expected one candidate set in the fixture.");
  return set;
}

describe("web source-verified candidate targets", () => {
  it("hides all candidate advertising for a disabled 404 until discovery succeeds", () => {
    expect(referenceTargetSectionVisible(false, null)).toBe(false);
    expect(referenceTargetSectionVisible(true, null)).toBe(false);
    expect(referenceTargetSectionVisible(true, parseReferenceTargetSets(response()))).toBe(true);
  });

  it("strictly parses the 12-target candidate and applied provenance", () => {
    const parsed = parseReferenceTargetSets(response());
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0]?.targets).toHaveLength(12);
    expect(parsed.applied?.set.targets).toHaveLength(12);
    expect(parsed.applied?.acknowledgement.acceptedAt).toBe("2026-09-07T18:30:00.000Z");
    expect(
      appliedReferenceMatchesGoal(parsed.applied, {
        id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
        versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
        revision: "3",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched persisted snapshot or malformed acknowledgement timestamp", () => {
    const mismatched = response();
    mismatched.data.applied.set.policyDigest = "b".repeat(64);
    expect(() => parseReferenceTargetSets(mismatched)).toThrow("snapshot identity");

    const malformed = response();
    malformed.data.applied.acknowledgement.acceptedAt = "2026-09-07";
    expect(() => parseReferenceTargetSets(malformed)).toThrow("provenance");
  });

  it("rejects missing targets, duplicate nutrients, unsafe sources, and availability drift", () => {
    const missing = response();
    const missingSet = firstSet(missing.data);
    missingSet.targets = missingSet.targets.slice(0, 11);
    expect(() => parseReferenceTargetSets(missing)).toThrow();

    const duplicate = response();
    const duplicateTarget = firstSet(duplicate.data).targets[1];
    if (!duplicateTarget) throw new Error("Expected a second fixture target.");
    duplicateTarget.definition.id = "1";
    expect(() => parseReferenceTargetSets(duplicate)).toThrow("duplicate nutrients");

    const unsafe = response();
    const unsafeTarget = firstSet(unsafe.data).targets[0];
    if (!unsafeTarget) throw new Error("Expected a first fixture target.");
    (unsafeTarget.source as { url: string }).url = "http://example.test/reference";
    expect(() => parseReferenceTargetSets(unsafe)).toThrow("target");

    const contradictory = response();
    contradictory.data.availability.available = false;
    expect(() => parseReferenceTargetSets(contradictory)).toThrow("contradictory");
  });

  it("accepts profile revision zero for a new account while still failing closed", () => {
    const unavailable = response();
    const mutable = unavailable.data as unknown as {
      profileRevision: string;
      availability: { available: boolean; reasonCodes: string[] };
      sets: unknown[];
    };
    mutable.profileRevision = "0";
    mutable.availability = {
      available: false,
      reasonCodes: ["profile_missing_birth_date"],
    };
    mutable.sets = [];
    expect(parseReferenceTargetSets(unavailable).profileRevision).toBe("0");
  });

  it("does not carry prior acknowledgement onto a changed profile revision", () => {
    const parsed = parseReferenceTargetSets(response());
    const goal = {
      id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
      versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
      revision: "3",
    };
    expect(carriedReferenceSet(parsed, goal)?.groupCode).toBe("male-19-50");
    const drifted = {
      ...parsed,
      profileRevision: "5",
    };
    expect(appliedReferenceMatchesGoal(drifted.applied, goal)).toBe(true);
    expect(carriedReferenceSet(drifted, goal)).toBeNull();
    expect(appliedReferenceSetForDisplay(drifted, goal)?.targets).toHaveLength(12);
    expect(appliedReferenceSetForDisplay(drifted, goal)?.groupCode).toBe("male-19-50");
  });

  it("preserves candidate values and explicitly clears identity on customization", () => {
    const parsed = parseReferenceTargetSets(response());
    const set = firstSet(parsed);
    expect(referenceTargetSelection(parsed, set)).toEqual({
      templateCode: "us-ca-dri-adults-19-50",
      templateVersion: "1",
      groupCode: "male-19-50",
      eligibilityAcknowledgement: {
        policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
        policyVersion: "1",
        accepted: true,
      },
    });
    expect(referenceTargetsForDraft(set)[0]).toMatchObject({
      targetAmount: "130",
      maximumAmount: "",
      sourceLabel: "Health Canada Dietary Reference Intakes",
    });
    expect(referenceTargetsForDraft(set, true)[0]).toMatchObject({
      sourceLabel: "User-customized copy of Health Canada Dietary Reference Intakes",
      rationale: "User-editable copy; verified reference-template identity cleared.",
    });
  });
});

describe("web candidate-target same-origin proxy", () => {
  it("rejects extra query fields before contacting the private API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await proxyReferenceTargetSets(
      new Request(
        "https://app.example.test/api/goals/reference-target-sets?date=2026-09-07&debug=1",
        { headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` } },
      ),
    );
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the upstream envelope and preserves a private no-store response", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.href);
        return Response.json(response());
      }),
    );
    const result = await proxyReferenceTargetSets(
      new Request("https://app.example.test/api/goals/reference-target-sets?date=2026-09-07", {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(calls).toEqual(["http://127.0.0.1:4000/v1/goals/reference-target-sets?date=2026-09-07"]);
  });

  it("preserves an older API 404 so only the optional template is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "NOT_FOUND", detail: "Route not found" }, { status: 404 }),
      ),
    );
    const result = await proxyReferenceTargetSets(
      new Request("https://app.example.test/api/goals/reference-target-sets?date=2026-09-07", {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
      }),
    );
    expect(result.status).toBe(404);
  });
});
