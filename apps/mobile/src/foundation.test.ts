import { describe, expect, it } from "vitest";

import { foundationItems } from "./foundation";

describe("mobile foundation ledger", () => {
  it("uses the allowed delivery states", () => {
    expect(foundationItems.map((item) => item.state).sort()).toEqual([
      "building",
      "gated",
      "ready",
    ]);
  });
});
