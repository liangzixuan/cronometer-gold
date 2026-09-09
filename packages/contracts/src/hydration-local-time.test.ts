import { describe, expect, it } from "vitest";

import { resolveHydrationLocalMinute } from "./index.js";

describe("explicit hydration local-minute resolution", () => {
  it("resolves a unique profile-local minute independently of the device zone", () => {
    expect(resolveHydrationLocalMinute("2026-08-15", "08:15", "America/Chicago")).toEqual({
      kind: "unique",
      timeZone: "America/Chicago",
      candidates: [
        {
          occurredAt: "2026-08-15T13:15:00.000Z",
          utcOffsetSeconds: -18_000,
          utcOffsetLabel: "UTC−05:00",
        },
      ],
    });
  });

  it("requires an explicit occurrence for the repeated Chicago minute", () => {
    expect(resolveHydrationLocalMinute("2026-11-01", "01:30", "America/Chicago")).toEqual({
      kind: "ambiguous",
      timeZone: "America/Chicago",
      candidates: [
        {
          occurredAt: "2026-11-01T06:30:00.000Z",
          utcOffsetSeconds: -18_000,
          utcOffsetLabel: "UTC−05:00",
        },
        {
          occurredAt: "2026-11-01T07:30:00.000Z",
          utcOffsetSeconds: -21_600,
          utcOffsetLabel: "UTC−06:00",
        },
      ],
    });
  });

  it("does not normalize spring gaps or a skipped calendar day", () => {
    expect(resolveHydrationLocalMinute("2026-03-08", "02:30", "America/Chicago")).toEqual({
      kind: "gap",
      timeZone: "America/Chicago",
      candidates: [],
    });
    expect(resolveHydrationLocalMinute("2011-12-30", "12:00", "Pacific/Apia")).toMatchObject({
      kind: "gap",
      candidates: [],
    });
  });

  it("handles a half-hour fold without assuming a one-hour DST adjustment", () => {
    const result = resolveHydrationLocalMinute("2026-04-05", "01:45", "Australia/Lord_Howe");
    expect(result.kind).toBe("ambiguous");
    expect(result.candidates).toEqual([
      {
        occurredAt: "2026-04-04T14:45:00.000Z",
        utcOffsetSeconds: 39_600,
        utcOffsetLabel: "UTC+11:00",
      },
      {
        occurredAt: "2026-04-04T15:15:00.000Z",
        utcOffsetSeconds: 37_800,
        utcOffsetLabel: "UTC+10:30",
      },
    ]);
  });

  it("retains historical offset seconds instead of rounding them to minutes", () => {
    expect(resolveHydrationLocalMinute("1890-01-01", "00:00", "Europe/Paris")).toMatchObject({
      kind: "unique",
      candidates: [
        {
          occurredAt: "1889-12-31T23:50:39.000Z",
          utcOffsetSeconds: 561,
          utcOffsetLabel: "UTC+00:09:21",
        },
      ],
    });
  });

  it.each(["0001-01-01", "0099-12-31", "0100-01-01", "2000-02-29", "9999-12-31"])(
    "preserves the exact supported calendar year: %s",
    (date) => {
      expect(resolveHydrationLocalMinute(date, "12:34", "UTC")).toEqual({
        kind: "unique",
        timeZone: "UTC",
        candidates: [
          {
            occurredAt: `${date}T12:34:00.000Z`,
            utcOffsetSeconds: 0,
            utcOffsetLabel: "UTC+00:00",
          },
        ],
      });
    },
  );

  it.each(["0000-01-01", "10000-01-01", "2026-02-29", "1900-02-29", "2026-04-31", ""])(
    "rejects invalid calendar input instead of Date normalization: %s",
    (date) => {
      expect(resolveHydrationLocalMinute(date, "12:00", "UTC")).toEqual({
        kind: "invalid",
        reason: "date",
        candidates: [],
      });
    },
  );

  it.each(["24:00", "12:60", "1:30", "12:00:00", ""])(
    "rejects input outside the selected-minute form: %s",
    (time) => {
      expect(resolveHydrationLocalMinute("2026-01-01", time, "UTC")).toMatchObject({
        kind: "invalid",
        reason: "time",
        candidates: [],
      });
    },
  );

  it("rejects unsupported zones and UTC instants outside the transport range", () => {
    expect(resolveHydrationLocalMinute("2026-01-01", "00:00", "Not/A_Zone")).toMatchObject({
      kind: "invalid",
      reason: "time-zone",
    });
    expect(resolveHydrationLocalMinute("0001-01-01", "00:00", "Etc/GMT-14")).toMatchObject({
      kind: "invalid",
      reason: "range",
      candidates: [],
    });
    expect(resolveHydrationLocalMinute("9999-12-31", "23:59", "Etc/GMT+12")).toMatchObject({
      kind: "invalid",
      reason: "range",
      candidates: [],
    });
  });
});
