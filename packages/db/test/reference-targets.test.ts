import { describe, expect, it } from "vitest";

import {
  assertReferenceSourcesHttps,
  assertReferenceTargetSelection,
  REFERENCE_TARGET_CAUTIONS,
  REFERENCE_TARGET_SOURCES,
  referenceEligibleThroughExclusive,
  referenceTargetPolicy,
} from "../src/reference-targets.js";

describe("reviewed reference target policy", () => {
  it("pins the complete male and female vectors and safety-bound digests", () => {
    const male = referenceTargetPolicy("male-19-50");
    const female = referenceTargetPolicy("female-19-50");
    expect(male.policyDigest).toBe(
      "4a1e050607e9bbaa20a4b67921fcbb9dbfa2c9bfd2393ac1a58d41cc3dc03def",
    );
    expect(female.policyDigest).toBe(
      "24c3747c2d0c2946d3dc071277935b9bc0e21c715e47952dbff5aedb96e99249",
    );
    expect(male.rows).toHaveLength(12);
    expect(female.rows).toHaveLength(12);
    expect(new Set(male.rows.map((row) => row.code)).size).toBe(12);
    expect(
      male.rows.every(
        (row) =>
          row.maximumAmount === null || Number(row.maximumAmount) >= Number(row.targetAmount),
      ),
    ).toBe(true);
    expect(
      Object.fromEntries(male.rows.map((row) => [row.code, [row.targetAmount, row.maximumAmount]])),
    ).toMatchObject({
      protein: ["56", null],
      fiber: ["38", null],
      potassium: ["3400", null],
      iron: ["8", "45"],
      "vitamin-c": ["90", "2000"],
      "vitamin-a-rae": ["900", null],
    });
    expect(
      Object.fromEntries(
        female.rows.map((row) => [row.code, [row.targetAmount, row.maximumAmount]]),
      ),
    ).toMatchObject({
      protein: ["46", null],
      fiber: ["25", null],
      potassium: ["2600", null],
      iron: ["18", "45"],
      "vitamin-c": ["75", "2000"],
      "vitamin-a-rae": ["700", null],
    });
    expect(REFERENCE_TARGET_CAUTIONS.map((caution) => caution.code)).toContain(
      "clinical-exclusions",
    );
  });

  it("requires the exact accepted acknowledgement and official HTTPS source set", () => {
    expect(
      assertReferenceTargetSelection({
        templateCode: "us-ca-dri-adults-19-50",
        templateVersion: "1",
        groupCode: "male-19-50",
        eligibilityAcknowledgement: {
          policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
          policyVersion: "1",
          accepted: true,
        },
      }),
    ).toBe("male-19-50");
    expect(() =>
      assertReferenceTargetSelection({
        templateCode: "us-ca-dri-adults-19-50",
        templateVersion: "1",
        groupCode: "male-19-50",
        eligibilityAcknowledgement: {
          policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
          policyVersion: "1",
          accepted: false,
        },
      }),
    ).toThrow("Unsupported reference target selection");
    expect(() => assertReferenceSourcesHttps()).not.toThrow();
    for (const [key, value] of Object.entries(REFERENCE_TARGET_SOURCES)) {
      if (key.endsWith("Url")) expect(value).toMatch(/^https:\/\//u);
    }
  });

  it("expires on the 51st birthday using the same March-1 leap-day boundary as age checks", () => {
    expect(referenceEligibleThroughExclusive("1975-09-07")).toBe("2026-09-07");
    expect(referenceEligibleThroughExclusive("1980-02-29")).toBe("2031-03-01");
  });
});
