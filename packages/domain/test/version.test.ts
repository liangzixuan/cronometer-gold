import { describe, expect, it } from "vitest";

import { NUTRITION_ENGINE_VERSION } from "../src/index.js";

describe("nutrition engine identity", () => {
  it("is a stable persisted package identity", () => {
    expect(NUTRITION_ENGINE_VERSION).toBe("@nutrition-tracker/domain@0.1.0");
  });
});
