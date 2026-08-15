import { describe, expect, it } from "vitest";

import { flagOption, parseArguments, requiredOption } from "../src/arguments.js";

describe("operator CLI argument parsing", () => {
  it("separates a two-token command, positional, flags, and valued options", () => {
    const parsed = parseArguments([
      "artifact",
      "observe",
      "manifest.json",
      "--observation-out",
      "observation.json",
      "--fresh",
    ]);
    expect(parsed.command).toEqual(["artifact", "observe"]);
    expect(parsed.positionals).toEqual(["manifest.json"]);
    expect(requiredOption(parsed.options, "observation-out")).toBe("observation.json");
    expect(flagOption(parsed.options, "fresh")).toBe(true);
  });

  it("rejects duplicate options", () => {
    expect(() => parseArguments(["x", "y", "--value", "a", "--value", "b"])).toThrow(
      "repeated option",
    );
  });

  it("accepts pnpm's leading argument separator", () => {
    expect(parseArguments(["--", "manifest", "validate", "manifest.json"]).command).toEqual([
      "manifest",
      "validate",
    ]);
  });

  it("rejects surrounding whitespace in security-relevant values", () => {
    const parsed = parseArguments(["x", "y", "--principal", " operator "]);
    expect(() => requiredOption(parsed.options, "principal")).toThrow("non-blank value");
  });
});
