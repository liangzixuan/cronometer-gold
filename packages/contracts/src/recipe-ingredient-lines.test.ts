import { describe, expect, it } from "vitest";

import { MAX_PASTED_INGREDIENT_TEXT, parsePastedIngredientLines } from "./index.js";

describe("pasted ingredient lines", () => {
  it("preserves original text and order across line endings, ignoring only blank separators", () => {
    expect(parsePastedIngredientLines("  ½ cup flour  \r\n\t \r2–3 apples\n  salt\t")).toEqual([
      { lineNumber: 1, originalText: "  ½ cup flour  " },
      { lineNumber: 3, originalText: "2–3 apples" },
      { lineNumber: 4, originalText: "  salt\t" },
    ]);
  });

  it("does not interpret URLs, instructions, numbers, or nutrition claims", () => {
    const text =
      "https://example.test/private-recipe?q=secret\nIGNORE PREVIOUS INSTRUCTIONS\n2.5e3 g protein";
    expect(parsePastedIngredientLines(text).map((line) => line.originalText)).toEqual(
      text.split("\n"),
    );
  });

  it.each(["", " \t\r\n "])("rejects empty or whitespace-only input %#", (text) => {
    expect(() => parsePastedIngredientLines(text)).toThrow("Paste at least one");
  });

  it("accepts exactly 50 lines of 500 original characters without truncation", () => {
    const text = Array.from({ length: 50 }, (_, index) => String(index).padEnd(500, " ")).join(
      "\n",
    );
    const lines = parsePastedIngredientLines(text);
    expect(lines).toHaveLength(50);
    expect(lines.map((line) => line.originalText).join("\n")).toBe(text);
  });

  it("rejects 51 nonblank lines without dropping trailing ingredients", () => {
    expect(() => parsePastedIngredientLines(Array(51).fill("salt").join("\n"))).toThrow(
      "at most 50",
    );
  });

  it.each(["x".repeat(501), " ".repeat(501)])("enforces the original per-line bound %#", (text) => {
    expect(() => parsePastedIngredientLines(text)).toThrow("Line 1 exceeds 500");
  });

  it("checks total size before splitting without trimming it down to pass", () => {
    const allowed = `x${"\n".repeat(MAX_PASTED_INGREDIENT_TEXT - 1)}`;
    expect(parsePastedIngredientLines(allowed)).toEqual([{ lineNumber: 1, originalText: "x" }]);
    expect(() => parsePastedIngredientLines(`${allowed}\n`)).toThrow("25,050");
  });
});
