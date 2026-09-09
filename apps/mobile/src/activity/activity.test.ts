import { describe, expect, it } from "vitest";

import {
  ACTIVITY_ENERGY_POLICY_COPY,
  ACTIVITY_ESTIMATE_POLICY_COPY,
  ACTIVITY_ONLINE_POLICY_COPY,
  activityDurationFromDraft,
  activityEnergyFromDraft,
  activityEntryAccessibilityLabel,
  canonicalActivityName,
  isActivityTimeZoneChangedProblem,
  parseActivityDay,
  parseActivityMutation,
  prepareActivityCreate,
  prepareActivityUpdate,
} from "./activity";

const entry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  name: "Evening walk",
  durationMinutes: 45,
  selfReportedEnergyKilocalories: "125.5",
  occurredAt: "2026-11-01T07:30:45.123Z",
  localDate: "2026-11-01",
  localTime: "01:30:45.123",
  timeZone: "America/Chicago",
  createdAt: "2026-11-01T07:30:46.000Z",
} as const;

const day = {
  data: {
    localDate: "2026-11-01",
    timeZone: "America/New_York",
    revision: "3",
    entries: [entry],
    totalDurationMinutes: 45,
    updatedAt: "2026-11-01T07:30:46.000Z",
  },
} as const;

describe("mobile activity response parsing", () => {
  it("keeps exact optional energy and an entry's immutable historical time zone", () => {
    const parsed = parseActivityDay(day);
    expect(parsed.totalDurationMinutes).toBe(45);
    expect(parsed.entries[0]).toMatchObject({
      selfReportedEnergyKilocalories: "125.5",
      timeZone: "America/Chicago",
    });
    expect(parsed.timeZone).toBe("America/New_York");
  });

  it("requires canonical zones and exact local coordinates derived from the start instant", () => {
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: [{ ...entry, localTime: "01:30:45.122" }],
        },
      }),
    ).toThrow("inconsistent local coordinates");
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: [{ ...entry, localDate: "2026-10-31" }],
        },
      }),
    ).toThrow("inconsistent local coordinates");
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: [{ ...entry, timeZone: "US/Central" }],
        },
      }),
    ).toThrow("activity entry");
  });

  it("preserves missing self-reported energy as null rather than zero", () => {
    const parsed = parseActivityDay({
      data: {
        ...day.data,
        entries: [{ ...entry, selfReportedEnergyKilocalories: null }],
      },
    });
    expect(parsed.entries[0]?.selfReportedEnergyKilocalories).toBeNull();
  });

  it("rejects inconsistent totals, duplicate identifiers, wrong dates, and more than 64 entries", () => {
    expect(() => parseActivityDay({ data: { ...day.data, totalDurationMinutes: 44 } })).toThrow(
      "inconsistent",
    );
    expect(() =>
      parseActivityDay({
        data: { ...day.data, entries: [entry, entry], totalDurationMinutes: 90 },
      }),
    ).toThrow("inconsistent");
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: [{ ...entry, localDate: "2026-11-02" }],
        },
      }),
    ).toThrow("inconsistent");
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: Array.from({ length: 65 }, (_, index) => ({
            ...entry,
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          })),
          totalDurationMinutes: 2_925,
        },
      }),
    ).toThrow("invalid");
  });

  it("rejects entries outside canonical occurredAt-then-id server order", () => {
    const later = {
      ...entry,
      id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
      occurredAt: "2026-11-01T08:00:00.000Z",
      localTime: "02:00:00",
    };
    expect(() =>
      parseActivityDay({
        data: { ...day.data, entries: [later, entry], totalDurationMinutes: 90 },
      }),
    ).toThrow("inconsistent");

    const lowerIdAtSameInstant = {
      ...entry,
      id: "2bcfa2bf-4950-43f7-9f24-b983ac803012",
    };
    expect(() =>
      parseActivityDay({
        data: {
          ...day.data,
          entries: [entry, lowerIdAtSameInstant],
          totalDurationMinutes: 90,
        },
      }),
    ).toThrow("inconsistent");
  });

  it("fails closed on noncanonical or numeric energy and unexpected fields", () => {
    for (const value of ["0", "01", "1.0", "1.0001", "20000.1", 125.5]) {
      expect(() =>
        parseActivityDay({
          data: {
            ...day.data,
            entries: [{ ...entry, selfReportedEnergyKilocalories: value }],
          },
        }),
      ).toThrow("activity entry");
    }
    expect(() => parseActivityDay({ data: { ...day.data, caloriesBurned: 125.5 } })).toThrow();
  });

  it("parses exact one- and two-day mutation receipts and rejects duplicates", () => {
    expect(
      parseActivityMutation({
        data: {
          replayed: true,
          entry,
          affectedDays: [
            { localDate: "2026-11-01", revision: "3" },
            { localDate: "2026-11-02", revision: "1" },
          ],
        },
      }),
    ).toMatchObject({ replayed: true, entry: { name: "Evening walk" } });
    expect(
      parseActivityMutation({
        data: {
          replayed: false,
          entry: null,
          affectedDays: [{ localDate: "2026-11-01", revision: "4" }],
        },
      }).entry,
    ).toBeNull();
    expect(() =>
      parseActivityMutation({
        data: {
          replayed: false,
          entry,
          affectedDays: [
            { localDate: "2026-11-01", revision: "3" },
            { localDate: "2026-11-01", revision: "4" },
          ],
        },
      }),
    ).toThrow("duplicated");
  });
});

describe("mobile activity input semantics", () => {
  it("normalizes names with NFC and collapsed whitespace within scalar and byte bounds", () => {
    expect(canonicalActivityName("  Cafe\u0301   walk  ")).toBe("Caf\u00e9 walk");
    expect(canonicalActivityName("😀".repeat(120))).toBe("😀".repeat(120));
    expect(() => canonicalActivityName("a".repeat(121))).toThrow("120");
    expect(() => canonicalActivityName("😀".repeat(121))).toThrow();
  });

  it("rejects blank, control-bearing, and malformed Unicode names before normalization", () => {
    for (const value of ["", "   ", "Morning\nwalk", "Morning\twalk", "bad\ud800name"]) {
      expect(() => canonicalActivityName(value)).toThrow();
    }
  });

  it("accepts only whole durations from 1 through 1,440 minutes", () => {
    expect(activityDurationFromDraft("1")).toBe(1);
    expect(activityDurationFromDraft("1440")).toBe(1_440);
    for (const value of ["", "0", "01", "1.5", "1441", "1e3", " 45 "]) {
      expect(() => activityDurationFromDraft(value)).toThrow("whole minutes");
    }
  });

  it("canonicalizes optional exact calories without passing them through a number", () => {
    expect(activityEnergyFromDraft("")).toBeNull();
    expect(activityEnergyFromDraft("  ")).toBeNull();
    expect(activityEnergyFromDraft("0.010")).toBe("0.01");
    expect(activityEnergyFromDraft("125.500")).toBe("125.5");
    expect(activityEnergyFromDraft("20000.000")).toBe("20000");
    for (const value of ["0", "00.1", "0.000", "1.0001", "20000.001", "20001", "1e3"])
      expect(() => activityEnergyFromDraft(value)).toThrow("self-reported calories");
  });

  it("uses the loaded current profile zone and preserves an untouched second DST fold instant", () => {
    const prepared = prepareActivityCreate(
      " Walk ",
      "30",
      "100.00",
      "2026-11-01",
      "01:30",
      { localDate: "2026-11-01", timeZone: "America/Chicago" },
      "2026-11-01T07:30:45.123Z",
    );
    expect(prepared).toEqual({
      body: {
        name: "Walk",
        durationMinutes: 30,
        selfReportedEnergyKilocalories: "100",
        occurredAt: "2026-11-01T07:30:45.123Z",
      },
      expectedTimeZone: "America/Chicago",
    });
    expect(() =>
      prepareActivityCreate("Walk", "30", "", "2026-03-08", "02:30", {
        localDate: "2026-03-08",
        timeZone: "America/Chicago",
      }),
    ).toThrow("does not exist");
    expect(() =>
      prepareActivityCreate("Walk", "30", "", "2026-11-02", "08:00", {
        localDate: "2026-11-01",
        timeZone: "America/Chicago",
      }),
    ).toThrow("selected activity day");
  });

  it("builds a minimal update and adds a zone guard only when start time changes", () => {
    expect(
      prepareActivityUpdate(
        {
          entry,
          name: "Evening   stroll",
          durationMinutes: "45",
          selfReportedEnergyKilocalories: "125.500",
          localDate: "2026-11-01",
          localTime: "01:30",
        },
        "America/Chicago",
      ),
    ).toEqual({ body: { name: "Evening stroll" }, expectedTimeZone: null });

    expect(
      prepareActivityUpdate(
        {
          entry,
          name: entry.name,
          durationMinutes: "60",
          selfReportedEnergyKilocalories: "",
          localDate: "2026-11-02",
          localTime: "08:15",
        },
        "America/Chicago",
      ),
    ).toEqual({
      body: {
        durationMinutes: 60,
        selfReportedEnergyKilocalories: null,
        occurredAt: "2026-11-02T14:15:00.000Z",
      },
      expectedTimeZone: "America/Chicago",
    });
  });

  it("rejects no-op updates and nonexistent edited local times", () => {
    expect(() =>
      prepareActivityUpdate(
        {
          entry,
          name: entry.name,
          durationMinutes: String(entry.durationMinutes),
          selfReportedEnergyKilocalories: entry.selfReportedEnergyKilocalories,
          localDate: entry.localDate,
          localTime: entry.localTime.slice(0, 5),
        },
        "America/Chicago",
      ),
    ).toThrow("at least one");
    expect(() =>
      prepareActivityUpdate(
        {
          entry,
          name: entry.name,
          durationMinutes: String(entry.durationMinutes),
          selfReportedEnergyKilocalories: entry.selfReportedEnergyKilocalories,
          localDate: "2026-03-08",
          localTime: "02:30",
        },
        "America/Chicago",
      ),
    ).toThrow("does not exist");
  });
});

describe("mobile activity mutation failures", () => {
  it("recognizes only the exact typed 409 time-zone problem", () => {
    expect(
      isActivityTimeZoneChangedProblem(409, {
        code: "ACTIVITY_TIME_ZONE_CHANGED",
        detail: "The profile time zone changed.",
      }),
    ).toBe(true);
    expect(isActivityTimeZoneChangedProblem(422, { code: "ACTIVITY_TIME_ZONE_CHANGED" })).toBe(
      false,
    );
    expect(isActivityTimeZoneChangedProblem(409, { code: "CONFLICT" })).toBe(false);
    expect(isActivityTimeZoneChangedProblem(409, null)).toBe(false);
  });
});

describe("mobile activity presentation policy", () => {
  it("labels missing calories truthfully and states the PAL/no-adjustment boundary", () => {
    expect(activityEntryAccessibilityLabel(entry)).toContain("125.5 self-reported kilocalories");
    expect(
      activityEntryAccessibilityLabel({ ...entry, selfReportedEnergyKilocalories: null }),
    ).toContain("self-reported calories not entered");
    expect(ACTIVITY_ENERGY_POLICY_COPY).toMatch(/do not change your nutrition goal/iu);
    expect(ACTIVITY_ENERGY_POLICY_COPY).toMatch(/never add burned calories or adjust PAL/iu);
    expect(ACTIVITY_ENERGY_POLICY_COPY).toMatch(/PAL, ordinary activity is already included/iu);
    expect(ACTIVITY_ESTIMATE_POLICY_COPY).toMatch(/does not estimate calories/iu);
    expect(ACTIVITY_ONLINE_POLICY_COPY).toMatch(/not queued for later/iu);
  });
});
