import { describe, expect, it } from "vitest";

import { probeResponseSchema, problemCodes, problemDetailsSchema } from "./index.js";

describe("public contracts", () => {
  it("keeps the liveness response intentionally small", () => {
    expect(probeResponseSchema.required).toEqual(["status"]);
    expect(probeResponseSchema.properties.status.const).toBe("ok");
  });

  it("keeps the problem schema and code taxonomy synchronized", () => {
    expect(problemDetailsSchema.properties.code.enum).toEqual(problemCodes);
    expect(problemCodes).toContain("INTERNAL_ERROR");
    expect(new Set(problemCodes).size).toBe(problemCodes.length);
  });
});
