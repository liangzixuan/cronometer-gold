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
    expect(() =>
      prepareActivityCreate("Run", "35", "250", "2026-11-01", "01:30", loadedDay),
    ).toThrow("Choose the earlier or later occurrence");
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

describe("explicit web activity occurrences", () => {
  const foldDay = { localDate: "2026-11-01", timeZone: "America/Chicago" };
  it("requires an explicit occurrence for deliberate repeated-minute input", () => {
    expect(() =>
      prepareActivityCreate("Walk", "30", "", foldDay.localDate, "01:30", foldDay),
    ).toThrow("Choose the earlier or later occurrence");
  });
  it("permits an explicit correction to the other occurrence of the same displayed minute", () => {
    const first = {
      ...entry,
      occurredAt: "2026-11-01T06:30:45.123Z",
      localDate: foldDay.localDate,
      localTime: "01:30:45.123",
    };
    expect(
      prepareActivityUpdate(
        first.name,
        "35",
        "248.5",
        foldDay.localDate,
        "01:30",
        first,
        foldDay,
        "2026-11-01T07:30:00.000Z",
      ),
    ).toEqual({
      body: { occurredAt: "2026-11-01T07:30:00.000Z" },
      expectedTimeZone: "America/Chicago",
    });
  });
});

describe("web activity occurrence precision and validation", () => {
  const foldDay = { localDate: "2026-11-01", timeZone: "America/Chicago" };
  it.each(["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"])(
    "uses the explicitly selected instant %s",
    (selected) => {
      expect(
        prepareActivityCreate(
          "Walk",
          "30",
          "",
          foldDay.localDate,
          "01:30",
          foldDay,
          "2026-11-01T07:30:45.123Z",
          selected,
        ),
      ).toEqual({
        body: {
          name: "Walk",
          durationMinutes: 30,
          selfReportedEnergyKilocalories: null,
          occurredAt: selected,
        },
        expectedTimeZone: foldDay.timeZone,
      });
    },
  );
  it("supports both occurrences of a non-hour fold", () => {
    const loaded = { localDate: "2026-04-05", timeZone: "Australia/Lord_Howe" };
    for (const selected of ["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"]) {
      expect(
        prepareActivityCreate(
          "Walk",
          "30",
          "",
          loaded.localDate,
          "01:45",
          loaded,
          undefined,
          selected,
        ).body.occurredAt,
      ).toBe(selected);
    }
  });
  it.each(["2026-11-01T07:31:00.000Z", "2026-11-01T07:30:45.123Z", "invalid"])(
    "rejects off-candidate occurrence %s even with a usable captured default",
    (selected) => {
      expect(() =>
        prepareActivityCreate(
          "Walk",
          "30",
          "",
          foldDay.localDate,
          "01:30",
          foldDay,
          "2026-11-01T07:30:45.123Z",
          selected,
        ),
      ).toThrow("choice is no longer current");
    },
  );
  it("rejects a stale selected instant after moving to a unique minute and rejects a gap", () => {
    expect(() =>
      prepareActivityCreate(
        "Walk",
        "30",
        "",
        foldDay.localDate,
        "03:00",
        foldDay,
        undefined,
        "2026-11-01T07:30:00.000Z",
      ),
    ).toThrow("choice is no longer current");
    expect(() =>
      prepareActivityUpdate(
        entry.name,
        "35",
        "248.5",
        "2026-03-08",
        "02:30",
        entry,
        { localDate: entry.localDate, timeZone: "America/Chicago" },
        "2026-03-08T08:30:00.000Z",
      ),
    ).toThrow("does not exist");
  });
  it("preserves precise saved time and original zone for metadata-only corrections", () => {
    const original = {
      ...entry,
      occurredAt: "2026-11-01T07:30:45.123Z",
      localDate: foldDay.localDate,
      localTime: "01:30:45.123",
    };
    expect(
      prepareActivityUpdate(original.name, "36", "248.5", original.localDate, "01:30", original, {
        localDate: original.localDate,
        timeZone: "America/New_York",
      }),
    ).toEqual({ body: { durationMinutes: 36 } });
  });
});
