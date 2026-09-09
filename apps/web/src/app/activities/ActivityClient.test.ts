import { describe, expect, it } from "vitest";

import { activityUpdateBody, prepareActivityCreate, prepareActivityUpdate } from "./ActivityClient";

const entry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  name: "Trail run",
  durationMinutes: 35,
  selfReportedEnergyKilocalories: "248.5",
  occurredAt: "2026-08-15T13:05:01.000Z",
  localDate: "2026-08-15",
  localTime: "08:05:01",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:05:02.000Z",
} as const;

describe("web activity client request semantics", () => {
  it("uses the loaded day's current zone and canonical activity fields", () => {
    const initialSessionTimeZone = "America/New_York";
    const loadedDay = { localDate: "2026-08-15", timeZone: "America/Chicago" };
    expect(loadedDay.timeZone).not.toBe(initialSessionTimeZone);
    expect(
      prepareActivityCreate(" Trail   run ", "35", "248.500", "2026-08-15", "08:15", loadedDay),
    ).toEqual({
      body: {
        name: "Trail run",
        durationMinutes: 35,
        selfReportedEnergyKilocalories: "248.5",
        occurredAt: "2026-08-15T13:15:00.000Z",
      },
      expectedTimeZone: "America/Chicago",
    });
  });

  it("rejects a nonexistent local time and the wrong selected date", () => {
    expect(() =>
      prepareActivityCreate("Run", "35", "", "2026-03-08", "02:30", {
        localDate: "2026-03-08",
        timeZone: "America/Chicago",
      }),
    ).toThrow("does not exist");
    expect(() =>
      prepareActivityCreate("Run", "35", "", "2026-08-16", "08:15", {
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
      }),
    ).toThrow("selected activity day");
  });

  it("preserves the captured second fall-back fold until the default time is edited", () => {
    const loadedDay = { localDate: "2026-11-01", timeZone: "America/Chicago" };
    const secondFold = "2026-11-01T07:30:45.123Z";

    expect(
      prepareActivityCreate("Run", "35", "250", "2026-11-01", "01:30", loadedDay, secondFold),
    ).toEqual({
      body: {
        name: "Run",
        durationMinutes: 35,
        selfReportedEnergyKilocalories: "250",
        occurredAt: secondFold,
      },
      expectedTimeZone: "America/Chicago",
    });
    expect(
      prepareActivityCreate("Run", "35", "250", "2026-11-01", "01:30", loadedDay),
    ).toMatchObject({ body: { occurredAt: "2026-11-01T06:30:00.000Z" } });
  });

  it("updates only manual activity fields and never goal or balance fields", () => {
    const update = activityUpdateBody(" Cafe\u0301 walk ", "45", "");
    expect(update).toEqual({
      name: "Caf\u00e9 walk",
      durationMinutes: 45,
      selfReportedEnergyKilocalories: null,
    });
    expect(update).not.toHaveProperty("goal");
    expect(update).not.toHaveProperty("remainingEnergyKilocalories");
  });

  it("adds an occurredAt update and zone guard only when local coordinates change", () => {
    const loadedDay = { localDate: "2026-08-15", timeZone: "America/Chicago" };
    expect(() =>
      prepareActivityUpdate("Trail run", "35", "248.5", "2026-08-15", "08:05", entry, loadedDay),
    ).toThrow("Change at least one");
    expect(
      prepareActivityUpdate("Trail run", "40", "", "2026-08-16", "09:30", entry, loadedDay),
    ).toEqual({
      body: {
        durationMinutes: 40,
        selfReportedEnergyKilocalories: null,
        occurredAt: "2026-08-16T14:30:00.000Z",
      },
      expectedTimeZone: "America/Chicago",
    });
  });

  it("rejects raw control characters in an activity name", () => {
    expect(() => activityUpdateBody("Trail\trun", "35", "250")).toThrow("control characters");
  });
});
