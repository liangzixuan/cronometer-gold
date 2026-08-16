import { describe, expect, it } from "vitest";

import { authenticatedRouteNames, authenticatedRoutes } from "./routes";

describe("authenticated mobile navigation", () => {
  it("exposes diary, food search, recipes, and goals as first-class routes", () => {
    expect(authenticatedRouteNames).toEqual(["Today", "Search", "Recipes", "Goals"]);
    expect(authenticatedRoutes).toEqual({
      today: "Today",
      search: "Search",
      recipes: "Recipes",
      goals: "Goals",
    });
  });
});
