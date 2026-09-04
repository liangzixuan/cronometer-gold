import { Ajv, type AnySchema } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  createHydrationEntryHeadersSchema,
  createHydrationEntryQuerySchema,
  createHydrationEntryRequestSchema,
  hydrationDayResponseSchema,
  hydrationMutationResponseSchema,
  MAX_HYDRATION_AMOUNT_MILLILITERS,
  MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
  MAX_HYDRATION_ENTRIES_PER_DAY,
  updateHydrationEntryRequestSchema,
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
  amountMilliliters: 500,
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  localTime: "08:30:00",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:30:01.000Z",
} as const;

describe("hydration transport contracts", () => {
  it("accepts exact integer milliliters and rejects out-of-bound or fractional amounts", () => {
    const validate = validator(createHydrationEntryRequestSchema);
    expect(validate({ amountMilliliters: 1, occurredAt: entry.occurredAt })).toBe(true);
    expect(
      validate({
        amountMilliliters: MAX_HYDRATION_AMOUNT_MILLILITERS,
        occurredAt: entry.occurredAt,
      }),
    ).toBe(true);
    for (const amountMilliliters of [0, MAX_HYDRATION_AMOUNT_MILLILITERS + 1, 1.5]) {
      expect(validate({ amountMilliliters, occurredAt: entry.occurredAt })).toBe(false);
    }
    expect(validate({ amountMilliliters: 250, occurredAt: entry.occurredAt, calories: 0 })).toBe(
      false,
    );
  });

  it("publishes a closed bounded day without nutrient or energy fields", () => {
    const validate = validator(hydrationDayResponseSchema);
    const response = {
      data: {
        localDate: entry.localDate,
        timeZone: entry.timeZone,
        revision: "1",
        entries: [entry],
        totalMilliliters: 500,
        updatedAt: entry.createdAt,
      },
    };
    expect(validate(response)).toBe(true);
    expect(hydrationDayResponseSchema.properties.data.properties.entries.maxItems).toBe(
      MAX_HYDRATION_ENTRIES_PER_DAY,
    );
    expect(hydrationDayResponseSchema.properties.data.properties.totalMilliliters.maximum).toBe(
      MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
    );
    expect(hydrationDayResponseSchema.properties.data.properties).not.toHaveProperty("nutrients");
    expect(hydrationDayResponseSchema.properties.data.properties).not.toHaveProperty("energy");
    expect(validate({ ...response, data: { ...response.data, totalMilliliters: 500.5 } })).toBe(
      false,
    );
  });

  it("requires a meaningful closed update patch", () => {
    const validate = validator(updateHydrationEntryRequestSchema);
    expect(validate({ amountMilliliters: 750 })).toBe(true);
    expect(validate({ occurredAt: "2026-08-15T14:00:00Z" })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ amountMilliliters: 750, foodVersionId: "1" })).toBe(false);
  });

  it("keeps guarded-create capability schemas aligned with diary semantics", () => {
    expect(createHydrationEntryHeadersSchema.additionalProperties).toBe(true);
    expect(createHydrationEntryHeadersSchema.properties).toHaveProperty(
      "x-expected-profile-time-zone",
    );
    expect(createHydrationEntryQuerySchema.properties.profileTimeZonePrecondition.const).toBe("v1");
  });

  it("accepts replay-safe create and delete mutation results", () => {
    const validate = validator(hydrationMutationResponseSchema);
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
