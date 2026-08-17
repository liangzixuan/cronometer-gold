import { describe, expect, it } from "vitest";

import {
  assertTrendRange,
  canonicalIsoWeekdays,
  canonicalRetentionDecimal,
  nextReminderOccurrence,
} from "../src/index.js";

describe("retention domain policies", () => {
  it("chooses the first fall-back instant and never fires the duplicate", () => {
    expect(
      nextReminderOccurrence({
        after: "2026-11-01T05:00:00Z",
        daysOfWeek: [7],
        localTime: "01:30",
        timeZone: "America/Chicago",
      }).instant,
    ).toBe("2026-11-01T06:30:00.000Z");

    expect(
      nextReminderOccurrence({
        after: "2026-11-01T06:31:00Z",
        daysOfWeek: [7],
        localTime: "01:30",
        timeZone: "America/Chicago",
      }).instant,
    ).toBe("2026-11-08T07:30:00.000Z");
  });

  it("skips a spring-forward wall-clock gap", () => {
    expect(
      nextReminderOccurrence({
        after: "2026-03-08T05:00:00Z",
        daysOfWeek: [7],
        localTime: "02:30",
        timeZone: "America/Chicago",
      }).instant,
    ).toBe("2026-03-15T07:30:00.000Z");
  });

  it("requires canonical unique weekdays", () => {
    expect(canonicalIsoWeekdays([7, 1, 4])).toEqual([1, 4, 7]);
    expect(() => canonicalIsoWeekdays([1, 1])).toThrow();
    expect(() => canonicalIsoWeekdays([0])).toThrow();
  });

  it("enforces trend and decimal boundaries", () => {
    expect(assertTrendRange("2026-01-01", "2026-12-31")).toBe(365);
    expect(() => assertTrendRange("2026-01-01", "2027-01-02")).toThrow();
    expect(canonicalRetentionDecimal("0.0000000000000000001", "value")).toBe(
      "0.0000000000000000001",
    );
    expect(() => canonicalRetentionDecimal("0", "value")).toThrow();
  });
});
