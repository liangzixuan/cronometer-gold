import { describe, expect, it } from "vitest";

import {
  assertHydrationUpdateReceipt,
  hydrationAmountFromDraft,
  hydrationEntryAccessibilityLabel,
  hydrationTimeEdit,
  hydrationUpdateBody,
  parseHydrationDay,
  parseHydrationMutation,
  prepareHydrationCreate,
  prepareHydrationUpdate,
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

describe("mobile hydration response parsing", () => {
  it("accepts an exact bounded sum and keeps an entry's immutable historical time zone", () => {
    const parsed = parseHydrationDay(day);
    expect(parsed.totalMilliliters).toBe(375);
    expect(parsed.entries[0]?.localTime).toBe("08:05:01.250");
    expect(parsed.entries[0]?.timeZone).toBe("America/New_York");
  });

  it("rejects inconsistent totals, duplicate identifiers, and more than 64 entries", () => {
    expect(() => parseHydrationDay({ data: { ...day.data, totalMilliliters: 374 } })).toThrow(
      "inconsistent",
    );
    expect(() =>
      parseHydrationDay({
        data: { ...day.data, entries: [entry, entry], totalMilliliters: 750 },
      }),
    ).toThrow("inconsistent");
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

  it("fails closed on decimal milliliters, added target fields, and offsets beyond 14 hours", () => {
    expect(() =>
      parseHydrationDay({
        data: { ...day.data, entries: [{ ...entry, amountMilliliters: 375.5 }] },
      }),
    ).toThrow();
    expect(() => parseHydrationDay({ data: { ...day.data, targetMilliliters: 2_000 } })).toThrow();
    expect(() =>
      parseHydrationDay({
        data: { ...day.data, entries: [{ ...entry, occurredAt: "2026-08-15T13:05:01-14:01" }] },
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

  it("parses an exact mutation receipt with one affected local day", () => {
    expect(
      parseHydrationMutation({
        data: {
          replayed: true,
          entry,
          affectedDays: [{ localDate: "2026-08-15", revision: "3" }],
        },
      }),
    ).toMatchObject({ replayed: true, entry: { amountMilliliters: 375 } });
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

describe("mobile hydration input and presentation semantics", () => {
  it("accepts only whole milliliters from 1 through 20,000", () => {
    expect(hydrationAmountFromDraft("1")).toBe(1);
    expect(hydrationAmountFromDraft("20000")).toBe(20_000);
    for (const value of ["", "0", "01", "1.5", "20001", "1e3", " 250 "]) {
      expect(() => hydrationAmountFromDraft(value)).toThrow("whole number");
    }
  });

  it("uses the loaded day's current zone even when the initial profile prop is stale", () => {
    const initialProfileTimeZone = "America/New_York";
    const loadedDay = { localDate: "2026-08-15", timeZone: "America/Chicago" };
    expect(loadedDay.timeZone).not.toBe(initialProfileTimeZone);
    expect(prepareHydrationCreate("250", "2026-08-15", "08:15", loadedDay)).toEqual({
      body: { amountMilliliters: 250, occurredAt: "2026-08-15T13:15:00.000Z" },
      expectedTimeZone: "America/Chicago",
    });
    expect(() =>
      prepareHydrationCreate("250", "2026-03-08", "02:30", {
        localDate: "2026-03-08",
        timeZone: "America/Chicago",
      }),
    ).toThrow("does not exist");
    expect(() => prepareHydrationCreate("250", "2026-08-16", "08:15", loadedDay)).toThrow(
      "selected hydration day",
    );
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

  it("updates and labels exact milliliters without inventing target, food, or energy semantics", () => {
    const body = hydrationUpdateBody("500");
    expect(body).toEqual({ amountMilliliters: 500 });
    expect(body).not.toHaveProperty("targetMilliliters");
    expect(body).not.toHaveProperty("nutrients");
    expect(body).not.toHaveProperty("energyAdjustment");
    const label = hydrationEntryAccessibilityLabel(entry);
    expect(label).toBe("375 milliliters at 08:05.");
    expect(label).not.toMatch(/target|goal|progress|calorie|nutrient/iu);
  });
});

describe("mobile hydration time corrections", () => {
  const original = {
    ...entry,
    occurredAt: "2026-11-01T07:30:45.250Z",
    localDate: "2026-11-01",
    localTime: "01:30:45.250",
    timeZone: "America/Chicago",
  };

  it("keeps amount-only precision and historical coordinates even after profile-zone changes", () => {
    expect(hydrationTimeEdit(original, "America/New_York")).toEqual({
      localDate: "2026-11-01",
      localTime: "02:30",
      timeZone: "America/New_York",
      selectedOccurredAt: null,
    });
    const prepared = prepareHydrationUpdate(original, "500");
    expect(prepared).toEqual({
      body: { amountMilliliters: 500 },
      destinationLocalDate: original.localDate,
    });
    const receipt = {
      replayed: true,
      entry: { ...original, revision: "3", amountMilliliters: 500 },
      affectedDays: [{ localDate: original.localDate, revision: "5" }],
    };
    expect(() => assertHydrationUpdateReceipt(receipt, original, prepared)).not.toThrow();
    for (const altered of [
      { occurredAt: "2026-11-01T07:30:00.000Z" },
      { occurredAt: "2026-11-01T06:30:45.250Z" },
      { timeZone: "America/New_York" },
      { localTime: "01:30:45.249" },
    ]) {
      expect(() =>
        assertHydrationUpdateReceipt(
          { ...receipt, entry: { ...receipt.entry, ...altered } },
          original,
          prepared,
        ),
      ).toThrow();
    }
  });

  it("requires an explicit repeated-minute choice and rejects gaps or a choice from another minute", () => {
    const time = hydrationTimeEdit(original, "America/Chicago");
    expect(() => prepareHydrationUpdate(original, "375", time)).toThrow("earlier or later");
    expect(
      prepareHydrationUpdate(original, "375", {
        ...time,
        selectedOccurredAt: "2026-11-01T07:30:00.000Z",
      }),
    ).toEqual({
      body: { amountMilliliters: 375, occurredAt: "2026-11-01T07:30:00.000Z" },
      expectedTimeZone: "America/Chicago",
      destinationLocalDate: "2026-11-01",
    });
    expect(() =>
      prepareHydrationUpdate(original, "375", {
        ...time,
        localTime: "01:31",
        selectedOccurredAt: "2026-11-01T07:30:00.000Z",
      }),
    ).toThrow("earlier or later");
    expect(() =>
      prepareHydrationUpdate(original, "375", {
        ...time,
        localDate: "2026-03-08",
        localTime: "02:30",
      }),
    ).toThrow("does not exist");
    expect(() =>
      prepareHydrationUpdate(original, "375", { ...time, localDate: "2026-02-30" }),
    ).toThrow("valid date");
  });

  it("requires the exact correction subject, revision, values, zone, and both moved days", () => {
    const prepared = prepareHydrationUpdate(original, "500", {
      ...hydrationTimeEdit(original, "America/Chicago"),
      localDate: "2026-11-02",
    });
    const receipt = {
      replayed: false,
      entry: {
        ...original,
        revision: "3",
        amountMilliliters: 500,
        occurredAt: "2026-11-02T07:30:00.000Z",
        localDate: "2026-11-02",
        localTime: "01:30:00",
      },
      affectedDays: [
        { localDate: "2026-11-01", revision: "4" },
        { localDate: "2026-11-02", revision: "1" },
      ],
    };
    expect(() => assertHydrationUpdateReceipt(receipt, original, prepared)).not.toThrow();
    for (const altered of [
      { id: "5eff67ee-721a-411e-b935-7699065c8d2a" },
      { revision: "2" },
      { revision: "4" },
      { amountMilliliters: 499 },
      { timeZone: "America/New_York" },
      { localTime: "01:30:01" },
      { createdAt: "2026-01-01T00:00:00.000Z" },
      { occurredAt: "2026-11-02T07:30:00.250Z" },
    ]) {
      expect(() =>
        assertHydrationUpdateReceipt(
          { ...receipt, entry: { ...receipt.entry, ...altered } },
          original,
          prepared,
        ),
      ).toThrow();
    }
    expect(() =>
      assertHydrationUpdateReceipt(
        { ...receipt, affectedDays: receipt.affectedDays.slice(1) },
        original,
        prepared,
      ),
    ).toThrow();
    expect(() =>
      assertHydrationUpdateReceipt(
        {
          ...receipt,
          affectedDays: [
            { localDate: "2026-11-01", revision: "4" },
            { localDate: "2026-11-03", revision: "1" },
          ],
        },
        original,
        prepared,
      ),
    ).toThrow();
  });
});
