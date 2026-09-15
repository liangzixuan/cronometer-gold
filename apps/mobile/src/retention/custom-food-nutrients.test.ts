import type { CustomFoodNutrientDraft } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  appendCanonicalNutrientInput,
  parseCanonicalNutrientInput,
  removeCanonicalNutrientInput,
} from "./custom-food-nutrients";

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

describe("lossless canonical nutrient row removal", () => {
  it.each([
    [" 1=0 \n\n2=trace\n3=unknown:withheld", "1", "\n\n2=trace\n3=unknown:withheld"],
    [
      "1=0\r\n\t2=trace  \r\n \r\n3=unknown:withheld\r\n",
      "2",
      "1=0\r\n\r\n \r\n3=unknown:withheld\r\n",
    ],
    [" \r\n1=0\n\t\r\n 2=trace \r\n3=unknown:withheld", "3", " \r\n1=0\n\t\r\n 2=trace \r\n"],
  ])(
    "removes exact first/middle/last ID %s while retaining LF, CRLF and mixed delimiters",
    (before, id, expected) => {
      expect(removeCanonicalNutrientInput(before, id)).toBe(expected);
      expect(parseCanonicalNutrientInput(expected)).toEqual(
        parseCanonicalNutrientInput(before).filter((row) => row.nutrientId !== id),
      );
    },
  );

  it.each([
    ["1=0", "1", ""],
    [" 1=trace \r\n", "1", "\r\n"],
    [" \r\n\t 20=unknown:withheld\t\n\t", "20", " \r\n\n\t"],
  ])(
    "allows last-row removal to leave an empty draft with unchanged surrounding blanks: %j",
    (before, id, expected) => {
      expect(removeCanonicalNutrientInput(before, id)).toBe(expected);
      expect(() => parseCanonicalNutrientInput(expected)).toThrow("between 1 and 256");
    },
  );

  it("retains exact zero, long precision, legacy IDs and all unknown reasons without numeric conversion", () => {
    const precision = "0." + "1".repeat(198);
    const untouched = " 1=" + precision + " \r\n9007199254740993=0\n11=trace\r\n";
    const unknownLines = reasons.map((reason, index) => String(index + 20) + "=unknown:" + reason);
    const before = untouched + "\t99999999999999999999=trace  \n" + unknownLines.join("\r\n");
    const expected = untouched + "\n" + unknownLines.join("\r\n");
    expect(removeCanonicalNutrientInput(before, "99999999999999999999")).toBe(expected);
    expect(removeCanonicalNutrientInput(expected, "1")).toBe(
      "\r\n9007199254740993=0\n11=trace\r\n\n" + unknownLines.join("\r\n"),
    );
    for (const [index, line] of unknownLines.entries()) {
      const raw = "1=" + precision + "\n \t" + line + "  \r\n11=0";
      expect(removeCanonicalNutrientInput(raw, String(index + 20))).toBe(
        "1=" + precision + "\n\r\n11=0",
      );
    }
  });

  it("rejects absent or non-exact IDs instead of changing a neighboring numeric prefix", () => {
    const before = " 1=0 \r\n11=trace\n9007199254740993=unknown:withheld";
    for (const id of [
      "2",
      "",
      "0",
      "01",
      "1 ",
      " 1",
      "1\n",
      "1=0",
      "9007199254740992",
      "100000000000000000000",
    ]) {
      expect(() => removeCanonicalNutrientInput(before, id)).toThrow(
        "present in the current draft",
      );
    }
    expect(() => removeCanonicalNutrientInput(before, 1 as unknown as string)).toThrow(
      "present in the current draft",
    );
    expect(removeCanonicalNutrientInput(before, "1")).toBe(
      "\r\n11=trace\n9007199254740993=unknown:withheld",
    );
  });

  it("validates all current rows first, refusing malformed, duplicate or empty input without repair", () => {
    for (const before of [
      "",
      " \r\n\t ",
      "1=0\ninvalid",
      "1=0\n2=-1",
      "1=0\n2=unknown:missing",
      "1=0\n1=trace",
      "1=0\n2=0\n2=trace",
      "01=0",
      "1=" + "1".repeat(201),
    ]) {
      expect(() => removeCanonicalNutrientInput(before, "1")).toThrow();
    }
    expect(() => removeCanonicalNutrientInput("1=0\n1=trace", "missing")).toThrow("only once");
    expect(() => removeCanonicalNutrientInput(null as unknown as string, "1")).toThrow(
      "must be a string",
    );
  });

  it("accepts the parser's 256-row boundary and text length while refusing an already oversized row set", () => {
    const rows = Array.from({ length: 256 }, (_, index) => String(index + 1) + "=0");
    const full = rows.join("\n");
    const next = removeCanonicalNutrientInput(full, "256");
    expect(next).toBe(rows.slice(0, -1).join("\n") + "\n");
    expect(parseCanonicalNutrientInput(next)).toHaveLength(255);
    expect(() => removeCanonicalNutrientInput(full + "\n257=trace", "257")).toThrow(
      "between 1 and 256",
    );
    const prefix = "1=0".padEnd(12_001, " ");
    expect(removeCanonicalNutrientInput(prefix + "\n2=trace", "2")).toBe(prefix + "\n");
  });
});
