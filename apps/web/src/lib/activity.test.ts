import { describe, expect, it } from "vitest";

import {
  activityDurationFromDraft,
  activityEnergyFromDraft,
  activityEntryAccessibilityLabel,
  assertActivityMutationSemantics,
  canonicalActivityNameFromDraft,
  parseActivityCreateBody,
  parseActivityDay,
  parseActivityMutation,
  parseActivityUpdateBody,
} from "./activity";

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

describe("web activity response parsing", () => {
  it("accepts one exact, ordered activity day without deriving calorie totals", () => {
    const parsed = parseActivityDay({
      data: {
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        revision: "3",
        entries: [entry],
        totalDurationMinutes: 35,
        updatedAt: "2026-08-15T13:05:02.000Z",
      },
    });
    expect(parsed.entries).toEqual([entry]);
    expect(parsed.totalDurationMinutes).toBe(35);
    expect(parsed).not.toHaveProperty("totalEnergyKilocalories");
  });

  it("rejects unknown fields, inconsistent totals, and unstable entry order", () => {
    const day = {
      localDate: "2026-08-15",
      timeZone: "America/Chicago",
      revision: "3",
      entries: [entry],
      totalDurationMinutes: 35,
      updatedAt: "2026-08-15T13:05:02.000Z",
    };
    expect(() => parseActivityDay({ data: { ...day, calorieBalance: 248.5 } })).toThrow();
    expect(() => parseActivityDay({ data: { ...day, totalDurationMinutes: 34 } })).toThrow();
    expect(() =>
      parseActivityDay({
        data: {
          ...day,
          entries: [
            {
              ...entry,
              id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
              occurredAt: "2026-08-15T14:00:00.000Z",
            },
            entry,
          ],
          totalDurationMinutes: 70,
        },
      }),
    ).toThrow();
  });

  it("rejects coordinate drift and noncanonical time-zone aliases", () => {
    const day = (changedEntry: unknown) => ({
      data: {
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        revision: "3",
        entries: [changedEntry],
        totalDurationMinutes: 35,
        updatedAt: "2026-08-15T13:05:02.000Z",
      },
    });
    expect(() => parseActivityDay(day({ ...entry, localTime: "08:06:01" }))).toThrow();
    expect(() =>
      parseActivityDay(
        day({
          ...entry,
          timeZone: "US/Central",
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed empty days and mutation envelopes", () => {
    expect(() =>
      parseActivityDay({
        data: {
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          revision: "1",
          entries: [],
          totalDurationMinutes: 0,
          updatedAt: null,
        },
      }),
    ).toThrow();
    expect(() =>
      parseActivityMutation({
        data: { replayed: false, entry, affectedDays: [], calorieBalance: 100 },
      }),
    ).toThrow();
  });
});

describe("web activity draft and request validation", () => {
  it("normalizes safe activity names while rejecting controls and exact size violations", () => {
    expect(canonicalActivityNameFromDraft("  Cafe\u0301   walk  ")).toBe("Caf\u00e9 walk");
    expect(canonicalActivityNameFromDraft("\ud83c\udfc3".repeat(120))).toHaveLength(240);
    expect(() => canonicalActivityNameFromDraft("Run\tfast")).toThrow("control characters");
    expect(() => canonicalActivityNameFromDraft("\ud800")).toThrow("control characters");
    expect(() => canonicalActivityNameFromDraft("a".repeat(121))).toThrow();
    expect(() => canonicalActivityNameFromDraft("\ud83c\udfc3".repeat(121))).toThrow();
  });

  it("enforces exact duration and optional self-reported energy bounds", () => {
    expect(activityDurationFromDraft("1")).toBe(1);
    expect(activityDurationFromDraft("1440")).toBe(1_440);
    expect(() => activityDurationFromDraft("0")).toThrow();
    expect(() => activityDurationFromDraft("1441")).toThrow();
    expect(activityEnergyFromDraft("")).toBeNull();
    expect(activityEnergyFromDraft("248.500")).toBe("248.5");
    expect(activityEnergyFromDraft("0.001")).toBe("0.001");
    expect(activityEnergyFromDraft("20000")).toBe("20000");
    expect(() => activityEnergyFromDraft("0")).toThrow();
    expect(() => activityEnergyFromDraft("20000.001")).toThrow();
    expect(() => activityEnergyFromDraft("1.0001")).toThrow();
  });

  it("requires the nullable energy field on create and a nonempty exact update", () => {
    const create = {
      name: "Trail run",
      durationMinutes: 35,
      selfReportedEnergyKilocalories: null,
      occurredAt: "2026-08-15T13:05:01.000Z",
    };
    expect(parseActivityCreateBody(create)).toEqual(create);
    const { selfReportedEnergyKilocalories: _energy, ...missingEnergy } = create;
    expect(() => parseActivityCreateBody(missingEnergy)).toThrow();
    expect(parseActivityUpdateBody({ selfReportedEnergyKilocalories: null })).toEqual({
      selfReportedEnergyKilocalories: null,
    });
    expect(() => parseActivityUpdateBody({})).toThrow();
    expect(() => parseActivityUpdateBody({ durationMinutes: 35, goal: 500 })).toThrow();
  });

  it("announces whether calories are self-reported or absent", () => {
    expect(activityEntryAccessibilityLabel(entry)).toContain("248.5 self-reported kilocalories");
    expect(
      activityEntryAccessibilityLabel({ ...entry, selfReportedEnergyKilocalories: null }),
    ).toContain("no calorie estimate");
  });

  it("validates create, update, and delete meaning against the exact request", () => {
    const createMutation = parseActivityMutation({
      data: {
        replayed: false,
        entry,
        affectedDays: [{ localDate: "2026-08-15", revision: "3" }],
      },
    });
    expect(() =>
      assertActivityMutationSemantics(createMutation, {
        kind: "create",
        sourceLocalDate: "2026-08-15",
        request: {
          name: "Trail run",
          durationMinutes: 35,
          selfReportedEnergyKilocalories: "248.5",
          occurredAt: "2026-08-15T13:05:01.000Z",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertActivityMutationSemantics(createMutation, {
        kind: "update",
        entryId: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
        sourceLocalDate: "2026-08-15",
        request: { durationMinutes: 35 },
      }),
    ).toThrow("wrong entry");
    const deletion = parseActivityMutation({
      data: {
        replayed: false,
        entry: null,
        affectedDays: [{ localDate: "2026-08-15", revision: "4" }],
      },
    });
    expect(() =>
      assertActivityMutationSemantics(deletion, {
        kind: "delete",
        entryId: entry.id,
        sourceLocalDate: "2026-08-15",
      }),
    ).not.toThrow();
    expect(() =>
      assertActivityMutationSemantics(createMutation, {
        kind: "delete",
        entryId: entry.id,
        sourceLocalDate: "2026-08-15",
      }),
    ).toThrow("delete response");
  });
});
