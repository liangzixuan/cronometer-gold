import { describe, expect, it } from "vitest";

import { HYDRATION_OWNER_CHANGED_CODE } from "../../lib/hydration";
import {
  hydrationReadClosesPrivateUi,
  hydrationReadHeaders,
  hydrationUpdateBody,
  prepareHydrationCreate,
} from "./HydrationClient";

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
    expect(() => prepareHydrationCreate("250", "2026-11-01", "01:30", loadedDay)).toThrow(
      "Choose the earlier or later occurrence",
    );
  });

  it("updates only exact milliliters and does not introduce target or nutrient fields", () => {
    expect(hydrationUpdateBody("500")).toEqual({ amountMilliliters: 500 });
    expect(hydrationUpdateBody("500")).not.toHaveProperty("targetMilliliters");
    expect(hydrationUpdateBody("500")).not.toHaveProperty("nutrients");
  });

  it("binds reads to the initiating owner and closes private UI on owner drift", () => {
    const owner = "5e041a5d-00e7-4260-832a-90e34a04e60a";
    expect(hydrationReadHeaders(owner)).toEqual({
      accept: "application/json",
      "x-expected-owner-user-id": owner,
    });
    expect(hydrationReadClosesPrivateUi(401, null)).toBe(true);
    expect(hydrationReadClosesPrivateUi(409, { code: HYDRATION_OWNER_CHANGED_CODE })).toBe(true);
    expect(hydrationReadClosesPrivateUi(409, { code: "CONFLICT" })).toBe(false);
  });
});

describe("web hydration Add occurrence precision and validation", () => {
  const foldDay = { localDate: "2026-11-01", timeZone: "America/Chicago" };
  const secondFold = "2026-11-01T07:30:45.123Z";

  it.each(["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"])(
    "uses the explicit Chicago occurrence %s instead of the precise default",
    (selected) => {
      expect(
        prepareHydrationCreate("250", foldDay.localDate, "01:30", foldDay, secondFold, selected),
      ).toEqual({
        body: { amountMilliliters: 250, occurredAt: selected },
        expectedTimeZone: foldDay.timeZone,
      });
    },
  );

  it.each(["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"])(
    "supports the non-hour Lord Howe occurrence %s",
    (selected) => {
      const loadedDay = { localDate: "2026-04-05", timeZone: "Australia/Lord_Howe" };
      expect(
        prepareHydrationCreate("250", loadedDay.localDate, "01:45", loadedDay, undefined, selected),
      ).toEqual({
        body: { amountMilliliters: 250, occurredAt: selected },
        expectedTimeZone: loadedDay.timeZone,
      });
    },
  );

  it.each(["250", "500"])(
    "preserves the precise second-fold default when only the amount becomes %s",
    (amount) => {
      expect(
        prepareHydrationCreate(amount, foldDay.localDate, "01:30", foldDay, secondFold, null),
      ).toEqual({
        body: { amountMilliliters: Number(amount), occurredAt: secondFold },
        expectedTimeZone: foldDay.timeZone,
      });
    },
  );

  it("requires an occurrence for deliberate ambiguous input with a cleared selection", () => {
    expect(() =>
      prepareHydrationCreate("250", foldDay.localDate, "01:30", foldDay, undefined, null),
    ).toThrow("Choose the earlier or later occurrence");
  });

  it("uses a unique minute without requiring an occurrence", () => {
    expect(
      prepareHydrationCreate("250", foldDay.localDate, "03:00", foldDay, undefined, null),
    ).toEqual({
      body: { amountMilliliters: 250, occurredAt: "2026-11-01T09:00:00.000Z" },
      expectedTimeZone: foldDay.timeZone,
    });
  });

  it.each(["2026-11-01T07:31:00.000Z", "2026-11-01T07:30:45.123Z", "invalid"])(
    "rejects the off-candidate choice %s even with a usable precise default",
    (selected) => {
      expect(() =>
        prepareHydrationCreate("250", foldDay.localDate, "01:30", foldDay, secondFold, selected),
      ).toThrow("choice is no longer current");
    },
  );

  it.each([
    { label: "date", localDate: "2026-11-02", localTime: "01:30", timeZone: "America/Chicago" },
    {
      label: "ambiguous minute",
      localDate: "2026-11-01",
      localTime: "01:31",
      timeZone: "America/Chicago",
    },
    {
      label: "unique minute",
      localDate: "2026-11-01",
      localTime: "03:00",
      timeZone: "America/Chicago",
    },
    {
      label: "loaded zone",
      localDate: "2026-11-01",
      localTime: "01:30",
      timeZone: "America/New_York",
    },
  ])("rejects a stale choice after the $label changes", ({ localDate, localTime, timeZone }) => {
    expect(() =>
      prepareHydrationCreate(
        "250",
        localDate,
        localTime,
        { localDate, timeZone },
        undefined,
        "2026-11-01T07:30:00.000Z",
      ),
    ).toThrow("choice is no longer current");
  });

  it.each([
    { localDate: "2026-02-29", localTime: "01:30", timeZone: "America/Chicago" },
    { localDate: "2026-11-01", localTime: "24:00", timeZone: "America/Chicago" },
    { localDate: "2026-11-01", localTime: "1:30", timeZone: "America/Chicago" },
    { localDate: "2026-11-01", localTime: "01:30", timeZone: "not-a-time-zone" },
  ])("rejects invalid local coordinates %j", ({ localDate, localTime, timeZone }) => {
    expect(() =>
      prepareHydrationCreate(
        "250",
        localDate,
        localTime,
        { localDate, timeZone },
        undefined,
        "2026-11-01T07:30:00.000Z",
      ),
    ).toThrow("valid hydration date, 24-hour time, and profile time zone");
  });

  it("rejects a nonexistent minute even when an instant was selected", () => {
    const loadedDay = { localDate: "2026-03-08", timeZone: "America/Chicago" };
    expect(() =>
      prepareHydrationCreate(
        "250",
        loadedDay.localDate,
        "02:30",
        loadedDay,
        undefined,
        "2026-03-08T08:30:00.000Z",
      ),
    ).toThrow("does not exist");
  });
});
