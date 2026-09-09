import { Ajv, type AnySchema } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  activityDayResponseSchema,
  activityMutationResponseSchema,
  activityOwnerHeadersSchema,
  createActivityEntryHeadersSchema,
  createActivityEntryQuerySchema,
  createActivityEntryRequestSchema,
  MAX_ACTIVITY_DAY_DURATION_MINUTES,
  MAX_ACTIVITY_ENTRIES_PER_DAY,
  updateActivityEntryRequestSchema,
} from "./index.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

function validator(schema: AnySchema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const entry = {
  id: "10000000-0000-4000-8000-000000000001",
  revision: "1",
  name: "Outdoor walk",
  durationMinutes: 35,
  selfReportedEnergyKilocalories: "125.5",
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  localTime: "08:30:00",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:30:01.000Z",
} as const;

describe("manual activity transport contracts", () => {
  it("accepts bounded canonical input and preserves missing self-reported energy", () => {
    const validate = validator(createActivityEntryRequestSchema);
    expect(
      validate({
        name: entry.name,
        durationMinutes: 1,
        selfReportedEnergyKilocalories: null,
        occurredAt: entry.occurredAt,
      }),
    ).toBe(true);
    expect(validate({ name: entry.name, durationMinutes: 30, occurredAt: entry.occurredAt })).toBe(
      false,
    );
    expect(
      validate({
        name: entry.name,
        durationMinutes: 1_440,
        selfReportedEnergyKilocalories: null,
        occurredAt: entry.occurredAt,
      }),
    ).toBe(true);
    for (const selfReportedEnergyKilocalories of ["0", "01", "1.0", "1.0001", "20000.1"]) {
      expect(
        validate({
          name: entry.name,
          durationMinutes: 30,
          selfReportedEnergyKilocalories,
          occurredAt: entry.occurredAt,
        }),
      ).toBe(false);
    }
    expect(
      validate({
        name: " two  spaces ",
        durationMinutes: 30,
        selfReportedEnergyKilocalories: null,
        occurredAt: entry.occurredAt,
      }),
    ).toBe(false);
    expect(
      validate({
        name: "line\u0000break",
        durationMinutes: 30,
        selfReportedEnergyKilocalories: null,
        occurredAt: entry.occurredAt,
      }),
    ).toBe(false);
  });

  it("publishes a closed day with duration history and no energy-balance field", () => {
    const validate = validator(activityDayResponseSchema);
    const response = {
      data: {
        localDate: entry.localDate,
        timeZone: entry.timeZone,
        revision: "1",
        entries: [
          entry,
          {
            ...entry,
            id: "20000000-0000-4000-8000-000000000002",
            selfReportedEnergyKilocalories: null,
          },
        ],
        totalDurationMinutes: 70,
        updatedAt: entry.createdAt,
      },
    };
    expect(validate(response)).toBe(true);
    expect(activityDayResponseSchema.properties.data.properties.entries.maxItems).toBe(
      MAX_ACTIVITY_ENTRIES_PER_DAY,
    );
    expect(activityDayResponseSchema.properties.data.properties.totalDurationMinutes.maximum).toBe(
      MAX_ACTIVITY_DAY_DURATION_MINUTES,
    );
    expect(activityDayResponseSchema.properties.data.properties).not.toHaveProperty(
      "energyBalance",
    );
    expect(activityDayResponseSchema.properties.data.properties).not.toHaveProperty(
      "caloriesRemaining",
    );
  });

  it("requires a meaningful closed update while allowing reported energy to be cleared", () => {
    const validate = validator(updateActivityEntryRequestSchema);
    expect(validate({ name: "Strength training" })).toBe(true);
    expect(validate({ durationMinutes: 45 })).toBe(true);
    expect(validate({ selfReportedEnergyKilocalories: null })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ durationMinutes: 45, goalAdjustment: "100" })).toBe(false);
  });

  it("keeps guarded-create capability schemas aligned with diary and hydration", () => {
    expect(activityOwnerHeadersSchema.properties).toHaveProperty("x-expected-owner-user-id");
    expect(createActivityEntryHeadersSchema.additionalProperties).toBe(true);
    expect(createActivityEntryHeadersSchema.properties).toHaveProperty("x-expected-owner-user-id");
    expect(createActivityEntryHeadersSchema.properties).toHaveProperty(
      "x-expected-profile-time-zone",
    );
    expect(createActivityEntryQuerySchema.properties.profileTimeZonePrecondition.const).toBe("v1");
  });

  it("accepts replay-safe create and delete mutation results", () => {
    const validate = validator(activityMutationResponseSchema);
    expect(
      validate({
        data: {
          replayed: false,
          entry,
          affectedDays: [{ localDate: entry.localDate, revision: "1" }],
        },
      }),
    ).toBe(true);
    expect(
      validate({
        data: {
          replayed: true,
          entry: null,
          affectedDays: [{ localDate: entry.localDate, revision: "2" }],
        },
      }),
    ).toBe(true);
  });
});
