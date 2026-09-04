import { describe, expect, it } from "vitest";

import { hydrationUpdateBody, prepareHydrationCreate } from "./HydrationClient";

describe("web hydration client request semantics", () => {
  it("uses the loaded day's current zone even when the initial session zone is stale", () => {
    const initialSessionTimeZone = "America/New_York";
    const loadedDay = { localDate: "2026-08-15", timeZone: "America/Chicago" };
    expect(loadedDay.timeZone).not.toBe(initialSessionTimeZone);
    expect(prepareHydrationCreate("250", "2026-08-15", "08:15", loadedDay)).toEqual({
      body: { amountMilliliters: 250, occurredAt: "2026-08-15T13:15:00.000Z" },
      expectedTimeZone: "America/Chicago",
    });
  });

  it("rejects a nonexistent local time instead of silently shifting it", () => {
    expect(() =>
      prepareHydrationCreate("250", "2026-03-08", "02:30", {
        localDate: "2026-03-08",
        timeZone: "America/Chicago",
      }),
    ).toThrow("does not exist");
    expect(() =>
      prepareHydrationCreate("250", "2026-08-16", "08:15", {
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
      }),
    ).toThrow("selected hydration day");
  });

  it("preserves the captured second fall-back fold until the default time is edited", () => {
    const loadedDay = { localDate: "2026-11-01", timeZone: "America/Chicago" };
    const secondFold = "2026-11-01T07:30:45.123Z";

    expect(prepareHydrationCreate("250", "2026-11-01", "01:30", loadedDay, secondFold)).toEqual({
      body: { amountMilliliters: 250, occurredAt: secondFold },
      expectedTimeZone: "America/Chicago",
    });
    expect(prepareHydrationCreate("250", "2026-11-01", "01:30", loadedDay)).toEqual({
      body: { amountMilliliters: 250, occurredAt: "2026-11-01T06:30:00.000Z" },
      expectedTimeZone: "America/Chicago",
    });
  });

  it("updates only exact milliliters and does not introduce target or nutrient fields", () => {
    expect(hydrationUpdateBody("500")).toEqual({ amountMilliliters: 500 });
    expect(hydrationUpdateBody("500")).not.toHaveProperty("targetMilliliters");
    expect(hydrationUpdateBody("500")).not.toHaveProperty("nutrients");
  });
});
