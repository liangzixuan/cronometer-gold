import { describe, expect, it } from "vitest";

import {
  assertHydrationMutationMatches,
  changeHydrationTimeDraft,
  hydrationAmountFromDraft,
  hydrationEntryAccessibilityLabel,
  hydrationTimeDraft,
  hydrationWriteBelongsToView,
  hydrationWriteOperation,
  hydrationWriteRequest,
  parseHydrationCreateBody,
  parseHydrationDay,
  parseHydrationMutation,
  parseHydrationUpdateBody,
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

describe("web explicit hydration time corrections", () => {
  const foldEntry = {
    ...entry,
    occurredAt: "2026-11-01T07:30:45.250Z",
    localDate: "2026-11-01",
    localTime: "01:30:45.250",
    timeZone: "America/Chicago",
  };
  const currentDay = { localDate: "2026-11-01", timeZone: "America/New_York" };
  const identity = {
    operationId: "515da557-df98-4181-8012-bbdb2ec2a37a",
    ownerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
  };
  const update = (prepared: ReturnType<typeof prepareHydrationUpdate>) =>
    hydrationWriteOperation({
      ...identity,
      ...prepared,
      day: currentDay,
      method: "PATCH",
      originalEntry: foldEntry,
      successMessage: "Updated.",
    });

  it("keeps the later original fold, fractional seconds and historical zone on amount-only edits", () => {
    const draft = hydrationTimeDraft(foldEntry, currentDay.timeZone);
    expect(draft).toMatchObject({
      enabled: false,
      localDate: "2026-11-01",
      localTime: "02:30",
      occurrence: null,
    });
    const prepared = prepareHydrationUpdate("500", foldEntry, draft);
    expect(prepared).toEqual({ body: { amountMilliliters: 500 }, destinationDate: "2026-11-01" });
    const operation = update(prepared);
    const request = hydrationWriteRequest(operation);
    expect(request.body).toBe('{"amountMilliliters":500}');
    expect(new Headers(request.headers).has("x-expected-profile-time-zone")).toBe(false);
    expect(operation.path).not.toContain("profileTimeZonePrecondition");
    const receipt = {
      replayed: false,
      entry: { ...foldEntry, revision: "3", amountMilliliters: 500 },
      affectedDays: [{ localDate: "2026-11-01", revision: "4" }],
    };
    expect(() => assertHydrationMutationMatches(receipt, operation)).not.toThrow();
    for (const change of [
      { occurredAt: "2026-11-01T06:30:45.250Z" },
      { occurredAt: "2026-11-01T07:30:00.000Z" },
      { timeZone: "America/New_York" },
      { localTime: "02:30:45.250" },
    ])
      expect(() =>
        assertHydrationMutationMatches(
          { ...receipt, entry: { ...receipt.entry, ...change } },
          operation,
        ),
      ).toThrow();
  });

  it("rejects gaps and requires an explicit fold occurrence that clears when time or zone changes", () => {
    const draft = { ...hydrationTimeDraft(foldEntry, "America/Chicago"), enabled: true };
    expect(() => prepareHydrationUpdate("500", foldEntry, draft)).toThrow("earlier or later");
    const later = { ...draft, occurrence: "2026-11-01T07:30:00.000Z" };
    expect(prepareHydrationUpdate("500", foldEntry, later).body).toEqual({
      amountMilliliters: 500,
      occurredAt: later.occurrence,
    });
    expect(changeHydrationTimeDraft(later, { localTime: "01:31" }).occurrence).toBeNull();
    expect(changeHydrationTimeDraft(later, { localDate: "2026-11-02" }).occurrence).toBeNull();
    expect(changeHydrationTimeDraft(later, { timeZone: "America/New_York" }).occurrence).toBeNull();
    expect(() =>
      prepareHydrationUpdate("500", foldEntry, {
        ...draft,
        localDate: "2026-03-08",
        localTime: "02:30",
      }),
    ).toThrow("does not exist");
    expect(() =>
      prepareHydrationUpdate("500", foldEntry, { ...draft, localDate: "2026-02-30" }),
    ).toThrow("valid local date");
  });

  it("binds exact retry bytes, initiating owner, entry, revision and zone to a frozen operation", () => {
    const prepared = prepareHydrationUpdate("500", foldEntry, {
      ...hydrationTimeDraft(foldEntry, currentDay.timeZone),
      enabled: true,
      localDate: "2026-11-02",
      localTime: "09:10",
    });
    const operation = update(prepared);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.originalEntry)).toBe(true);
    expect(hydrationWriteRequest(operation)).toEqual(hydrationWriteRequest(operation));
    expect(hydrationWriteRequest(operation).body).toBe(
      '{"amountMilliliters":500,"occurredAt":"2026-11-02T14:10:00.000Z"}',
    );
    const headers = new Headers(hydrationWriteRequest(operation).headers);
    expect(headers.get("if-match")).toBe('"2"');
    expect(headers.get("idempotency-key")).toBe(identity.operationId);
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/New_York");
    expect(headers.get("x-expected-owner-user-id")).toBe(identity.ownerUserId);
    expect(operation.path).toContain("?profileTimeZonePrecondition=v1");
    expect(hydrationWriteBelongsToView(operation, identity.ownerUserId, "2026-11-01")).toBe(true);
    expect(hydrationWriteBelongsToView(operation, "another-owner", "2026-11-01")).toBe(false);
    expect(hydrationWriteBelongsToView(operation, identity.ownerUserId, "2026-11-02")).toBe(false);
    expect(() =>
      hydrationWriteOperation({
        ...identity,
        ...prepared,
        day: { ...currentDay, timeZone: "UTC" },
        method: "PATCH",
        originalEntry: foldEntry,
        successMessage: "Updated.",
      }),
    ).toThrow("time zone changed");
  });

  it("requires the exact source/destination receipts, subject, values and historical-second coordinates", () => {
    const prepared = prepareHydrationUpdate("500", foldEntry, {
      ...hydrationTimeDraft(foldEntry, currentDay.timeZone),
      enabled: true,
      localDate: "2026-11-02",
      localTime: "09:10",
    });
    const operation = update(prepared);
    const receipt = {
      replayed: true,
      entry: {
        ...foldEntry,
        revision: "3",
        amountMilliliters: 500,
        occurredAt: "2026-11-02T14:10:00.000Z",
        localDate: "2026-11-02",
        localTime: "09:10:00.000",
        timeZone: "America/New_York",
      },
      affectedDays: [
        { localDate: "2026-11-01", revision: "4" },
        { localDate: "2026-11-02", revision: "1" },
      ],
    };
    expect(() => assertHydrationMutationMatches(receipt, operation)).not.toThrow();
    for (const change of [
      { id: identity.operationId },
      { amountMilliliters: 499 },
      { revision: "2" },
      { revision: "4" },
      { timeZone: "America/Chicago" },
      { localTime: "09:11:00.000" },
    ]) {
      expect(() =>
        assertHydrationMutationMatches(
          { ...receipt, entry: { ...receipt.entry, ...change } },
          operation,
        ),
      ).toThrow();
    }
    expect(() =>
      assertHydrationMutationMatches(
        { ...receipt, affectedDays: receipt.affectedDays.slice(1) },
        operation,
      ),
    ).toThrow("source and destination");
    const historical = prepareHydrationUpdate("500", foldEntry, {
      ...hydrationTimeDraft(foldEntry, "Europe/Paris"),
      enabled: true,
      localDate: "1890-01-01",
      localTime: "00:00",
    });
    const historicalOperation = hydrationWriteOperation({
      ...identity,
      ...historical,
      day: { ...currentDay, timeZone: "Europe/Paris" },
      method: "PATCH",
      originalEntry: foldEntry,
      successMessage: "Updated.",
    });
    expect(historical.body.occurredAt).toBe("1889-12-31T23:50:39.000Z");
    expect(() =>
      assertHydrationMutationMatches(
        {
          ...receipt,
          entry: {
            ...receipt.entry,
            occurredAt: historical.body.occurredAt ?? "",
            localDate: "1890-01-01",
            localTime: "00:00:00.000",
            timeZone: "Europe/Paris",
          },
          affectedDays: [
            { localDate: "2026-11-01", revision: "4" },
            { localDate: "1890-01-01", revision: "1" },
          ],
        },
        historicalOperation,
      ),
    ).not.toThrow();
  });
});
