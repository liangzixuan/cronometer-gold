import { describe, expect, it } from "vitest";

import { foundationMilestones } from "./foundation";

describe("foundation milestone copy", () => {
  it("does not claim food ingestion is complete", () => {
    expect(foundationMilestones.some((item) => item.state === "gated")).toBe(true);
    expect(foundationMilestones).toHaveLength(3);
  });
});
