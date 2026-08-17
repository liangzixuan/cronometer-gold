import { describe, expect, it } from "vitest";

import {
  biometricEventLocalTimeUnchanged,
  isPositiveInputDecimal,
  isSignedExactDecimal,
  operationId,
  parseBiometricTrend,
  parseExportJob,
  parseIntegrationMutation,
  parseIntegrations,
  parseNutrientTrend,
  parseReminders,
  repeatRequestBody,
  trendAggregateLabel,
} from "./retention";

const uuid = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
const instant = "2026-11-01T05:00:00.000Z";
const nutrient = {
  nutrientId: "1",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "123.45",
  completeness: "partial",
  isExact: false,
  contributorCount: 2,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 1,
  unknownReasonCounts: {
    not_reported: 1,
    not_analyzed: 0,
    not_applicable: 0,
    withheld: 0,
  },
};

describe("retention response boundaries", () => {
  it("does not rewrite seconds or milliseconds on a value-only biometric edit", () => {
    const original = {
      measuredAt: "2026-08-16T13:30:45.678Z",
      localDate: "2026-08-16",
      timeZone: "America/Chicago",
    };
    expect(biometricEventLocalTimeUnchanged(original, "2026-08-16", "08:30")).toBe(true);
    expect(biometricEventLocalTimeUnchanged(original, "2026-08-16", "08:31")).toBe(false);
  });

  it("preserves timezone-authoritative DST bounds and lower-bound semantics", () => {
    const trend = parseNutrientTrend({
      data: {
        nutrient: { id: "1", code: "energy", name: "Energy", unit: "kcal" },
        timeZone: "America/Chicago",
        from: "2026-11-01",
        to: "2026-11-01",
        bucket: "day",
        watermarkRevision: "7",
        points: [
          {
            localDate: "2026-11-01",
            startsAt: instant,
            endsAt: "2026-11-02T06:00:00.000Z",
            aggregate: nutrient,
          },
        ],
      },
    });
    expect(new Date(trend.points[0]?.endsAt ?? 0).getTime() - new Date(instant).getTime()).toBe(
      25 * 60 * 60 * 1_000,
    );
    expect(trendAggregateLabel(trend.points[0]?.aggregate ?? null)).toBe(
      "At least 123.45 kcal · partial",
    );
    expect(trendAggregateLabel(null)).toBe("No data");
  });

  it("rejects response drift and numeric coercion", () => {
    expect(() =>
      parseNutrientTrend({
        data: {
          nutrient: { id: "1", code: "energy", name: "Energy", unit: "kcal" },
          timeZone: "America/Chicago",
          from: "2026-08-01",
          to: "2026-08-01",
          bucket: "day",
          watermarkRevision: "7",
          points: [],
          unreviewed: true,
        },
      }),
    ).toThrow(/trend/u);
    expect(() =>
      parseBiometricTrend({
        data: {
          definition: {
            id: uuid,
            revision: "1",
            status: "active",
            name: "Weight",
            dimension: "mass",
            canonicalUnit: "kg",
            notes: null,
            createdAt: instant,
            updatedAt: instant,
          },
          timeZone: "America/Chicago",
          from: "2026-08-01",
          to: "2026-08-01",
          bucket: "day",
          points: [
            {
              localDate: "2026-08-01",
              startsAt: instant,
              endsAt: "2026-11-01T06:00:00.000Z",
              count: 1,
              first: 70,
              last: "70",
              minimum: "70",
              maximum: "70",
            },
          ],
        },
      }),
    ).toThrow(/point/u);
  });

  it("accepts only canonical bounded decimal inputs", () => {
    expect(isPositiveInputDecimal("100.25")).toBe(true);
    expect(isPositiveInputDecimal("0")).toBe(false);
    expect(isPositiveInputDecimal("01")).toBe(false);
    expect(isPositiveInputDecimal(`1.${"2".repeat(7)}`)).toBe(false);
    expect(isSignedExactDecimal("-12.50")).toBe(true);
    expect(isSignedExactDecimal(Number.NaN)).toBe(false);
  });

  it("builds repeat input without changing its immutable source identity", () => {
    expect(repeatRequestBody({ occurredAt: instant, mealSlot: "dinner", position: 4 })).toEqual({
      occurredAt: instant,
      mealSlot: "dinner",
      position: 4,
    });
    expect(operationId(() => uuid)).toBe(uuid);
    expect(() => operationId(() => "retry-1")).toThrow(/operation identifier/u);
  });

  it("requires generic reminder delivery text", () => {
    const reminder = {
      id: uuid,
      revision: "1",
      status: "active",
      label: "Evening check-in",
      localTime: "20:00",
      daysOfWeek: [1, 3, 5],
      timeZone: "America/Chicago",
      channel: "local",
      consent: { policyVersion: "local-reminders-v1", grantedAt: instant, revokedAt: null },
      deliveryPolicy: {
        title: "Nutrition Tracker",
        lockScreenText: "Time to check in.",
        includesHealthDetails: false,
      },
      createdAt: instant,
      updatedAt: instant,
    };
    expect(parseReminders({ data: [reminder] })).toHaveLength(1);
    expect(() =>
      parseReminders({
        data: [
          {
            ...reminder,
            deliveryPolicy: {
              title: "Nutrition Tracker",
              lockScreenText: "You missed your calorie goal",
              includesHealthDetails: true,
            },
          },
        ],
      }),
    ).toThrow(/reminder/u);
  });

  it("requires a canonical signed cursor epoch on every integration response", () => {
    const integration = {
      platform: "apple_healthkit",
      deviceId: uuid,
      cursorEpoch: "2",
      revision: "3",
      status: "connected",
      dataTypeCodes: ["body_weight"],
      consentGrantedAt: instant,
      disconnectedAt: null,
      lastImportAt: null,
      currentSourceCursor: null,
      consentHistory: [
        {
          id: "028f6f58-4e2c-7b62-8f0b-3d75491713b5",
          dataTypeCodes: ["body_weight"],
          status: "granted",
          recordedAt: instant,
        },
      ],
    };
    expect(parseIntegrations({ data: [integration] })[0]?.cursorEpoch).toBe("2");
    expect(parseIntegrationMutation({ data: { replayed: false, integration } }).cursorEpoch).toBe(
      "2",
    );
    for (const cursorEpoch of [undefined, "0", "01", "9223372036854775808"]) {
      expect(() => parseIntegrations({ data: [{ ...integration, cursorEpoch }] })).toThrow(
        /integration/u,
      );
    }
  });

  it("accepts only authenticated same-origin export artifact paths", () => {
    const response = {
      data: {
        replayed: false,
        export: {
          id: uuid,
          status: "completed",
          formats: ["json"],
          requestedAt: instant,
          startedAt: instant,
          completedAt: instant,
          expiresAt: "2026-11-01T07:00:00.000Z",
          artifacts: [
            {
              format: "json",
              fileName: "nutrition-export.json",
              byteLength: "100",
              sha256: "a".repeat(64),
              downloadPath: `/v1/exports/${uuid}/artifacts/json`,
              mediaType: "application/json",
              expiresAt: "2026-11-01T07:00:00.000Z",
            },
          ],
          manifestSha256: "b".repeat(64),
          reconciliation: {
            snapshotWatermark: "2026-11-01T05:00:00.000Z",
            entities: [
              {
                entity: "diary_entries",
                sourceCount: 1,
                exportedCount: 1,
                watermark: "2026-11-01T05:00:00.000Z",
              },
            ],
            reconciled: true,
          },
          failureCode: null,
        },
      },
    };
    expect(parseExportJob(response).status).toBe("completed");
    expect(() =>
      parseExportJob({
        data: {
          ...response.data,
          export: {
            ...response.data.export,
            artifacts: [
              {
                ...response.data.export.artifacts[0],
                downloadPath: `/v1/exports/${uuid}/artifacts/csv`,
              },
            ],
          },
        },
      }),
    ).toThrow(/artifact/u);
  });
});
