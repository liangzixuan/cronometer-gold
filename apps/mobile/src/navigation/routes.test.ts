import { describe, expect, it } from "vitest";

import { authenticatedRouteNames, authenticatedRoutes } from "./routes";

describe("authenticated mobile navigation", () => {
  it("exposes diary, food search, recipes, goals, hydration, health, and email status as first-class routes", () => {
    expect(authenticatedRouteNames).toEqual([
      "Today",
      "Search",
      "Recipes",
      "Goals",
      "Hydration",
      "Health",
      "VerifyEmail",
    ]);
    expect(authenticatedRoutes).toEqual({
      today: "Today",
      search: "Search",
      recipes: "Recipes",
      goals: "Goals",
      hydration: "Hydration",
      health: "Health",
      verifyEmail: "VerifyEmail",
    });
  });
});
