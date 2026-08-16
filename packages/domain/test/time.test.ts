import { describe, expect, it } from "vitest";

import {
  canonicalIanaTimeZone,
  canonicalRfc3339Instant,
  type DomainError,
  deriveDiaryLocalCoordinates,
} from "../src/index.js";

describe("diary time boundaries", () => {
  it("derives the user-local day from the persisted IANA zone", () => {
    expect(deriveDiaryLocalCoordinates("2026-08-16T03:15:12.345Z", "America/Chicago")).toEqual({
      occurredAt: "2026-08-16T03:15:12.345Z",
      timeZone: "America/Chicago",
      localDate: "2026-08-15",
      localTime: "22:15:12.345",
    });
  });

  it("keeps both fall-back instants on the same repeated local clock time", () => {
    const daylight = deriveDiaryLocalCoordinates("2026-11-01T06:30:00Z", "America/Chicago");
    const standard = deriveDiaryLocalCoordinates("2026-11-01T07:30:00Z", "America/Chicago");

    expect(daylight).toMatchObject({ localDate: "2026-11-01", localTime: "01:30:00" });
    expect(standard).toMatchObject({ localDate: "2026-11-01", localTime: "01:30:00" });
    expect(daylight.occurredAt).not.toBe(standard.occurredAt);
  });

  it("pads early Common Era local years to four digits", () => {
    expect(deriveDiaryLocalCoordinates("0001-01-01T12:00:00Z", "UTC")).toMatchObject({
      localDate: "0001-01-01",
      localTime: "12:00:00",
    });
  });

  it.each([
    ["0001-01-01T00:00:00Z", "America/Chicago"],
    ["9999-12-31T23:59:59Z", "Pacific/Kiritimati"],
  ])("rejects a derived local year outside 0001 through 9999: %s in %s", (instant, zone) => {
    expect(() => deriveDiaryLocalCoordinates(instant, zone)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }),
    );
  });

  it.each([
    "0000-01-01T00:00:00Z",
    "2026-02-30T08:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:00+14:01",
    "2026-01-01T12:00:00.1234Z",
    "2026-01-01",
  ])("rejects a normalized or incomplete timestamp: %s", (value) => {
    expect(() => canonicalRfc3339Instant(value)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }),
    );
  });

  it("rejects unsupported and fixed-offset pseudo zones", () => {
    expect(canonicalIanaTimeZone("US/Central")).toBe("America/Chicago");
    expect(() => canonicalIanaTimeZone("UTC-05:00")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_TIME_ZONE" }),
    );
  });
});
