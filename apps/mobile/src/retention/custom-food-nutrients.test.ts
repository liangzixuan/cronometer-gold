import type { CustomFoodNutrientDraft } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import { appendCanonicalNutrientInput, parseCanonicalNutrientInput } from "./custom-food-nutrients";

const available = Object.freeze([
  Object.freeze({ nutrientId: "1" }),
  Object.freeze({ nutrientId: "2" }),
  Object.freeze({ nutrientId: "3" }),
]);
const quantified = (nutrientId = "2", amountPer100Grams = "0"): CustomFoodNutrientDraft => ({
  nutrientId,
  state: "quantified",
  amountPer100Grams,
});
const reasons = ["not_reported", "not_analyzed", "not_applicable", "withheld"] as const;

describe("unchanged canonical custom-food nutrient parser", () => {
  it("preserves exact identifiers, decimals, zero, trace and every unknown reason in original order", () => {
    const text = [
      "  208=125.500000  ",
      "",
      "9007199254740993=0",
      "99999999999999999999=0.000000000000000001",
      "2=trace",
      ...reasons.map((reason, index) => `${index + 3}=unknown:${reason}`),
      "\t",
    ].join("\r\n");
    expect(parseCanonicalNutrientInput(text)).toEqual([
      quantified("208", "125.500000"),
      quantified("9007199254740993", "0"),
      quantified("99999999999999999999", "0.000000000000000001"),
      { nutrientId: "2", state: "trace", amountPer100Grams: null },
      ...reasons.map((reason, index) => ({
        nutrientId: String(index + 3),
        state: "unknown",
        amountPer100Grams: null,
        reason,
      })),
    ]);
  });

  it("retains the existing one-to-256 row bounds and does not impose the append text cap", () => {
    expect(() => parseCanonicalNutrientInput(" \r\n \t ")).toThrow("between 1 and 256");
    const rows = Array.from({ length: 256 }, (_, index) => `${index + 1}=0`);
    expect(parseCanonicalNutrientInput(rows.join("\n"))).toHaveLength(256);
    expect(() => parseCanonicalNutrientInput([...rows, "257=0"].join("\n"))).toThrow(
      "between 1 and 256",
    );
    expect(parseCanonicalNutrientInput("1=0".padEnd(12_001, " "))).toEqual([quantified("1")]);
  });

  it.each([
    "1=-0",
    "1=-1",
    "1=+1",
    "1=01",
    "1=.5",
    "1=1.",
    "1=1e3",
    "1=NaN",
    "1=Infinity",
    "1=1,5",
    "1=0x10",
    "1=unknown:missing",
    "1=Trace",
    "1=0\n1=trace",
    "0=0",
    "01=0",
    "100000000000000000000=0",
    "2 =0",
    "2= 0",
    "junk",
    "1=",
    `1=${"1".repeat(201)}`,
  ])("retains rejection of malformed canonical input %s", (value) => {
    expect(() => parseCanonicalNutrientInput(value)).toThrow();
  });
});

describe("lossless named custom-food nutrient append", () => {
  it.each(["0", "0.000000000000000001", "9007199254740993.000001", "1".repeat(200)])(
    "appends the explicit exact quantified amount %s without numeric conversion",
    (amount) => {
      const candidate = Object.freeze(quantified("2", amount));
      const next = appendCanonicalNutrientInput("1=trace", candidate, available);
      expect(next).toBe(`1=trace\n2=${amount}`);
      expect(parseCanonicalNutrientInput(next)[1]).toEqual(candidate);
    },
  );

  it("keeps trace separate from zero and requires no fabricated amount", () => {
    const row = Object.freeze({
      nutrientId: "2",
      state: "trace",
      amountPer100Grams: null,
    } as const);
    const next = appendCanonicalNutrientInput("1=0", row, available);
    expect(next).toBe("1=0\n2=trace");
    expect(parseCanonicalNutrientInput(next)).toEqual([quantified("1"), row]);
  });

  it.each(reasons)("preserves the explicit unknown reason %s", (reason) => {
    const row = { nutrientId: "2", state: "unknown", amountPer100Grams: null, reason } as const;
    const next = appendCanonicalNutrientInput("1=0", row, available);
    expect(next).toBe(`1=0\n2=unknown:${reason}`);
    expect(parseCanonicalNutrientInput(next)[1]).toEqual(row);
  });

  it.each([
    ["", "2=0"],
    ["  ", "  \n2=0"],
    [" \r\n\t ", " \r\n\t \r\n2=0"],
    ["1=trace", "1=trace\n2=0"],
    ["1=trace\n", "1=trace\n2=0"],
    ["1=trace\r\n", "1=trace\r\n2=0"],
    [" 1=trace \r\n\r\n ", " 1=trace \r\n\r\n \r\n2=0"],
    ["1=trace\r", "1=trace\r\n2=0"],
  ])("preserves the complete prefix and adds only a needed separator to %j", (before, expected) => {
    expect(appendCanonicalNutrientInput(before, quantified(), available)).toBe(expected);
  });

  it("preserves unavailable manual energy and non-targetable IDs, precision, order and mixed whitespace", () => {
    const before = " 208=125.500000 \r\n\n99999999999999999999=unknown:withheld\r\n\t3=trace  \n ";
    const next = appendCanonicalNutrientInput(before, quantified("2", "0.000001"), available);
    expect(next).toBe(`${before}\r\n2=0.000001`);
    expect(next.slice(0, before.length)).toBe(before);
    expect(parseCanonicalNutrientInput(next).slice(0, -1)).toEqual(
      parseCanonicalNutrientInput(before),
    );
    expect(available.map((item) => item.nutrientId)).toEqual(["1", "2", "3"]);
  });

  it("requires current named-list membership only for the appended row", () => {
    expect(parseCanonicalNutrientInput("208=125.5")).toEqual([quantified("208", "125.5")]);
    expect(() => appendCanonicalNutrientInput("", quantified("208", "125.5"), available)).toThrow(
      "available named list",
    );
    expect(() => appendCanonicalNutrientInput("208=125.5", quantified(), [])).toThrow(
      "available named list",
    );
    expect(appendCanonicalNutrientInput("208=125.5", quantified(), available)).toBe(
      "208=125.5\n2=0",
    );
  });

  it.each(["broken", "1=", "1=-1", "1=0\n1=trace", "1=unknown:invalid", "1=0\n2 =trace"])(
    "rejects malformed existing text without repairing its bytes: %s",
    (before) => {
      expect(() => appendCanonicalNutrientInput(before, quantified("3"), available)).toThrow();
      expect(before).not.toContain("3=0");
    },
  );

  it.each(["2=0", "208=125.5\r\n 2=trace \r\n", "2=unknown:not_analyzed"])(
    "rejects a duplicate selected/manual ID in %s",
    (before) => {
      expect(() => appendCanonicalNutrientInput(before, quantified(), available)).toThrow(
        "only once",
      );
    },
  );

  it("allows row 256 but rejects row 257 and an already over-capacity base", () => {
    const rows = Array.from({ length: 255 }, (_, index) => `${index + 1}=0`);
    const definitions = [{ nutrientId: "256" }, { nutrientId: "257" }, { nutrientId: "258" }];
    const before = rows.join("\n");
    const full = appendCanonicalNutrientInput(before, quantified("256"), definitions);
    expect(full).toBe(`${before}\n256=0`);
    expect(parseCanonicalNutrientInput(full)).toHaveLength(256);
    expect(() => appendCanonicalNutrientInput(full, quantified("257"), definitions)).toThrow(
      "between 1 and 256",
    );
    expect(() =>
      appendCanonicalNutrientInput(`${full}\n257=0`, quantified("258"), definitions),
    ).toThrow("between 1 and 256");
  });

  it("accepts exactly 12,000 resulting characters and rejects any extra without truncation", () => {
    const exact = "1=0".padEnd(11_996, " ");
    const next = appendCanonicalNutrientInput(exact, quantified(), available);
    expect(next).toHaveLength(12_000);
    expect(next).toBe(`${exact}\n2=0`);
    expect(() => appendCanonicalNutrientInput(`${exact} `, quantified(), available)).toThrow(
      "12,000",
    );
    expect(() =>
      appendCanonicalNutrientInput("1=0".padEnd(12_001, " "), quantified(), available),
    ).toThrow("12,000");
  });

  it.each([
    null,
    undefined,
    [],
    "2=0",
    {},
    { nutrientId: "2", state: "quantified", amountPer100Grams: "" },
    { nutrientId: "2", state: "quantified", amountPer100Grams: 0 },
    { nutrientId: "2", state: "quantified", amountPer100Grams: null },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "1", reason: "withheld" },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "1e3" },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "0.1\n3=trace" },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "0\n" },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "0 " },
    { nutrientId: "2", state: "quantified", amountPer100Grams: "1".repeat(201) },
    { nutrientId: "2", state: "trace" },
    { nutrientId: "2", state: "trace", amountPer100Grams: "0" },
    { nutrientId: "2", state: "trace", amountPer100Grams: null, reason: "withheld" },
    { nutrientId: "2", state: "unknown", amountPer100Grams: null },
    { nutrientId: "2", state: "unknown", amountPer100Grams: null, reason: "" },
    { nutrientId: "2", state: "unknown", amountPer100Grams: null, reason: "missing" },
    { nutrientId: "2", state: "unknown", amountPer100Grams: "0", reason: "withheld" },
    {
      nutrientId: "2",
      state: "unknown",
      amountPer100Grams: null,
      reason: "withheld",
      extra: "ignored",
    },
    { nutrientId: "2", state: "Quantified", amountPer100Grams: "1" },
    { nutrientId: 2, state: "trace", amountPer100Grams: null },
    { nutrientId: "02", state: "trace", amountPer100Grams: null },
    { nutrientId: "2\n", state: "trace", amountPer100Grams: null },
    { nutrientId: "2\n3", state: "trace", amountPer100Grams: null },
  ])(
    "rejects malformed runtime candidate %j without discarding irrelevant invalid fields",
    (candidate) => {
      expect(() =>
        appendCanonicalNutrientInput(
          "208=125.500000",
          candidate as CustomFoodNutrientDraft,
          available,
        ),
      ).toThrow();
    },
  );
});
