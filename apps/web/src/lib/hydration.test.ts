import { describe, expect, it } from "vitest";

import {
  hydrationAmountFromDraft,
  hydrationEntryAccessibilityLabel,
  parseHydrationCreateBody,
  parseHydrationDay,
  parseHydrationMutation,
  parseHydrationUpdateBody,
} from "./hydration";

const entry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  amountMilliliters: 375,
  occurredAt: "2026-08-15T13:05:01.250Z",
  localDate: "2026-08-15",
  localTime: "08:05:01.250",
  timeZone: "America/New_York",
  createdAt: "2026-08-15T13:05:02.000Z",
} as const;

const day = {
  data: {
    localDate: "2026-08-15",
    timeZone: "America/Chicago",
    revision: "3",
    entries: [entry],
    totalMilliliters: 375,
    updatedAt: "2026-08-15T13:05:02.000Z",
  },
} as const;

describe("web hydration response parsing", () => {
  it("accepts an exact bounded total while retaining an entry's historical time zone", () => {
    const parsed = parseHydrationDay(day);
    expect(parsed.totalMilliliters).toBe(375);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.timeZone).toBe("America/New_York");
    expect(parsed.entries[0]?.localTime).toBe("08:05:01.250");
  });

  it("rejects totals that are not the exact sum and days beyond the 64-entry bound", () => {
    expect(() => parseHydrationDay({ data: { ...day.data, totalMilliliters: 374 } })).toThrow(
      "inconsistent",
    );
    expect(() =>
      parseHydrationDay({
        data: {
          ...day.data,
          entries: Array.from({ length: 65 }, (_, index) => ({
            ...entry,
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          })),
          totalMilliliters: 24_375,
        },
      }),
    ).toThrow("invalid");
  });

  it("fails closed on unknown fields, non-integer amounts, and offsets beyond 14 hours", () => {
    expect(() => parseHydrationDay({ data: { ...day.data, targetMilliliters: 2_000 } })).toThrow();
    expect(() =>
      parseHydrationDay({
        data: { ...day.data, entries: [{ ...entry, amountMilliliters: 375.5 }] },
      }),
    ).toThrow();
    expect(() =>
      parseHydrationDay({
        data: { ...day.data, entries: [{ ...entry, occurredAt: "2026-08-15T13:05:01+14:01" }] },
      }),
    ).toThrow();
    expect(() =>
      parseHydrationDay({
        data: {
          ...day.data,
          entries: [{ ...entry, occurredAt: "2026-08-15T13:05:01.1234Z" }],
        },
      }),
    ).toThrow();
  });

  it("parses mutation receipts without losing the exact integer amount", () => {
    expect(
      parseHydrationMutation({
        data: {
          replayed: false,
          entry,
          affectedDays: [{ localDate: "2026-08-15", revision: "3" }],
        },
      }),
    ).toMatchObject({ replayed: false, entry: { amountMilliliters: 375 } });
    expect(() =>
      parseHydrationMutation({
        data: {
          replayed: false,
          entry,
          affectedDays: [{ localDate: "2026-08-15", revision: "0" }],
        },
      }),
    ).toThrow("mutation day");
  });
});

describe("web hydration request and presentation bounds", () => {
  it("accepts only whole milliliters from 1 through 20,000", () => {
    expect(hydrationAmountFromDraft("1")).toBe(1);
    expect(hydrationAmountFromDraft("20000")).toBe(20_000);
    for (const value of ["", "0", "01", "1.5", "20001", "1e3", " 250 "]) {
      expect(() => hydrationAmountFromDraft(value)).toThrow("whole number");
    }
  });

  it("accepts exact create/update bodies and rejects added semantics", () => {
    expect(
      parseHydrationCreateBody({
        amountMilliliters: 250,
        occurredAt: "2026-08-15T13:05:00Z",
      }),
    ).toEqual({ amountMilliliters: 250, occurredAt: "2026-08-15T13:05:00Z" });
    expect(parseHydrationUpdateBody({ amountMilliliters: 500 })).toEqual({
      amountMilliliters: 500,
    });
    expect(() => parseHydrationUpdateBody({})).toThrow();
    expect(() => parseHydrationUpdateBody({ amountMilliliters: 500, target: 2_000 })).toThrow();
  });

  it("provides a unit-and-time accessibility label without target language", () => {
    const label = hydrationEntryAccessibilityLabel(entry);
    expect(label).toBe("375 milliliters at 08:05.");
    expect(label).not.toMatch(/target|goal|progress|calorie|nutrient/iu);
  });
});
