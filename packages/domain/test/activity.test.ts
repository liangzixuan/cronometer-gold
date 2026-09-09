import { describe, expect, it } from "vitest";

import {
  canonicalActivityDurationMinutes,
  canonicalActivityName,
  canonicalActivitySelfReportedEnergyKilocalories,
  createActivityEntryRevision,
  type DomainError,
  MAX_ACTIVITY_DURATION_MINUTES,
  MAX_ACTIVITY_ENTRIES_PER_DAY,
  MAX_ACTIVITY_NAME_CODE_POINTS,
  sumActivityDurationMinutes,
} from "../src/index.js";

const base = {
  revisionId: "revision-1",
  entryId: "entry-1",
  revisionNumber: 1,
  supersedesRevisionId: null,
  operation: "create" as const,
  name: "Outdoor walk",
  durationMinutes: 35,
  selfReportedEnergyKilocalories: "125.5",
  occurredAt: "2026-03-08T07:30:00Z",
  timeZone: "America/Chicago",
  capturedAt: "2026-03-08T07:30:01Z",
};

describe("manual activity ledger domain", () => {
  it("normalizes the label and derives immutable local coordinates from the start instant", () => {
    const revision = createActivityEntryRevision({ ...base, name: "  Outdoor\u00a0wa\u0301lk  " });
    expect(revision).toMatchObject({
      schemaVersion: 1,
      name: "Outdoor wálk",
      durationMinutes: 35,
      selfReportedEnergyKilocalories: "125.5",
      occurredAt: "2026-03-08T07:30:00.000Z",
      localDate: "2026-03-08",
      localTime: "01:30:00",
      timeZone: "America/Chicago",
    });
    expect(Object.isFrozen(revision)).toBe(true);
  });

  it("bounds names by Unicode characters and UTF-8 bytes", () => {
    expect(canonicalActivityName("  strength   training ")).toBe("strength training");
    expect(canonicalActivityName("😀".repeat(MAX_ACTIVITY_NAME_CODE_POINTS))).toHaveLength(
      MAX_ACTIVITY_NAME_CODE_POINTS * 2,
    );
    for (const name of [
      " ",
      "line\u0000break",
      "line\nbreak",
      "tab\tseparated",
      "orphan\ud800",
      "a".repeat(MAX_ACTIVITY_NAME_CODE_POINTS + 1),
      "😀".repeat(121),
    ]) {
      expect(() => canonicalActivityName(name)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_ACTIVITY" }),
      );
    }
  });

  it.each([0, -1, 1.5, MAX_ACTIVITY_DURATION_MINUTES + 1, Number.NaN])(
    "rejects a non-exact or out-of-bound duration: %s",
    (durationMinutes) => {
      expect(() => canonicalActivityDurationMinutes(durationMinutes)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_ACTIVITY" }),
      );
    },
  );

  it("preserves missing energy and canonicalizes only bounded self-reported values", () => {
    expect(canonicalActivitySelfReportedEnergyKilocalories(undefined)).toBeNull();
    expect(canonicalActivitySelfReportedEnergyKilocalories(null)).toBeNull();
    expect(canonicalActivitySelfReportedEnergyKilocalories("00125.5000")).toBe("125.5");
    for (const energy of ["0", "-1", "20000.001", "1.0001"]) {
      expect(() => canonicalActivitySelfReportedEnergyKilocalories(energy)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_ACTIVITY" }),
      );
    }
    expect(() => canonicalActivitySelfReportedEnergyKilocalories("NaN")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DECIMAL" }),
    );
  });

  it("bounds active entries without pretending overlapping activity must fit inside one day", () => {
    expect(sumActivityDurationMinutes([30, MAX_ACTIVITY_DURATION_MINUTES])).toBe(1_470);
    expect(
      sumActivityDurationMinutes(
        Array.from({ length: MAX_ACTIVITY_ENTRIES_PER_DAY }, () => MAX_ACTIVITY_DURATION_MINUTES),
      ),
    ).toBe(MAX_ACTIVITY_ENTRIES_PER_DAY * MAX_ACTIVITY_DURATION_MINUTES);
    expect(() =>
      sumActivityDurationMinutes(Array.from({ length: MAX_ACTIVITY_ENTRIES_PER_DAY + 1 }, () => 1)),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_ACTIVITY" }));
  });

  it("requires a linear create/update/delete revision chain", () => {
    expect(() => createActivityEntryRevision({ ...base, revisionNumber: 2 })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_ACTIVITY" }),
    );
    expect(
      createActivityEntryRevision({
        ...base,
        revisionId: "revision-2",
        revisionNumber: 2,
        supersedesRevisionId: "revision-1",
        operation: "delete",
      }),
    ).toMatchObject({ operation: "delete", supersedesRevisionId: "revision-1" });
  });
});
