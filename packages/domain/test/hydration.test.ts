import { describe, expect, it } from "vitest";

import {
  canonicalHydrationAmountMilliliters,
  createHydrationEntryRevision,
  type DomainError,
  MAX_HYDRATION_AMOUNT_MILLILITERS,
  MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
  MAX_HYDRATION_ENTRIES_PER_DAY,
  sumHydrationMilliliters,
} from "../src/index.js";

const base = {
  revisionId: "revision-1",
  entryId: "entry-1",
  revisionNumber: 1,
  supersedesRevisionId: null,
  operation: "create" as const,
  amountMilliliters: 500,
  occurredAt: "2026-03-08T07:30:00Z",
  timeZone: "America/Chicago",
  capturedAt: "2026-03-08T07:30:01Z",
};

describe("hydration ledger domain", () => {
  it("derives immutable local coordinates from the instant and IANA profile zone", () => {
    const revision = createHydrationEntryRevision(base);
    expect(revision).toMatchObject({
      schemaVersion: 1,
      amountMilliliters: 500,
      occurredAt: "2026-03-08T07:30:00.000Z",
      localDate: "2026-03-08",
      localTime: "01:30:00",
      timeZone: "America/Chicago",
    });
    expect(Object.isFrozen(revision)).toBe(true);
  });

  it.each([0, -1, 1.5, MAX_HYDRATION_AMOUNT_MILLILITERS + 1, Number.NaN])(
    "rejects a non-exact or out-of-bound event amount: %s",
    (amountMilliliters) => {
      expect(() => canonicalHydrationAmountMilliliters(amountMilliliters)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_HYDRATION" }),
      );
    },
  );

  it("enforces the independent active-event and daily-total bounds", () => {
    expect(sumHydrationMilliliters([1, MAX_HYDRATION_AMOUNT_MILLILITERS])).toBe(20_001);
    expect(() =>
      sumHydrationMilliliters(Array.from({ length: MAX_HYDRATION_ENTRIES_PER_DAY + 1 }, () => 1)),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_HYDRATION" }));
    expect(() =>
      sumHydrationMilliliters([
        MAX_HYDRATION_AMOUNT_MILLILITERS,
        MAX_HYDRATION_AMOUNT_MILLILITERS,
        MAX_HYDRATION_AMOUNT_MILLILITERS,
        MAX_HYDRATION_AMOUNT_MILLILITERS,
        MAX_HYDRATION_AMOUNT_MILLILITERS,
        1,
      ]),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_HYDRATION" }));
    expect(
      sumHydrationMilliliters([
        MAX_HYDRATION_DAY_TOTAL_MILLILITERS / 5,
        MAX_HYDRATION_DAY_TOTAL_MILLILITERS / 5,
        MAX_HYDRATION_DAY_TOTAL_MILLILITERS / 5,
        MAX_HYDRATION_DAY_TOTAL_MILLILITERS / 5,
        MAX_HYDRATION_DAY_TOTAL_MILLILITERS / 5,
      ]),
    ).toBe(MAX_HYDRATION_DAY_TOTAL_MILLILITERS);
  });

  it("requires a linear create/update/delete revision chain", () => {
    expect(() => createHydrationEntryRevision({ ...base, revisionNumber: 2 })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_HYDRATION" }),
    );
    expect(
      createHydrationEntryRevision({
        ...base,
        revisionId: "revision-2",
        revisionNumber: 2,
        supersedesRevisionId: "revision-1",
        operation: "delete",
      }),
    ).toMatchObject({ operation: "delete", supersedesRevisionId: "revision-1" });
  });

  it("rejects normalized invalid instants and unsupported zones", () => {
    expect(() =>
      createHydrationEntryRevision({ ...base, occurredAt: "2026-02-30T08:00:00Z" }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }));
    expect(() => createHydrationEntryRevision({ ...base, timeZone: "UTC-05:00" })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_TIME_ZONE" }),
    );
  });
});
