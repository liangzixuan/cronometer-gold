import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createHydrationEntry,
  type Database,
  getHydrationDay,
  HydrationEntryRevisionConflictError,
  HydrationIdempotencyConflictError,
  HydrationNotFoundError,
  HydrationTimeZoneChangedError,
  HydrationValidationError,
  updateHydrationEntry,
} from "../src/index.js";

const unreachableDatabase = {} as Kysely<Database>;

describe("hydration persistence boundary validation", () => {
  it("rejects malformed operation identities and volumes before opening a transaction", async () => {
    await expect(
      createHydrationEntry(unreachableDatabase, {
        amountMilliliters: 250,
        clientOperationId: "not-a-uuid",
        occurredAt: "2026-08-15T00:00:00Z",
        requestDigest: "a".repeat(64),
        userId: "user",
      }),
    ).rejects.toBeInstanceOf(HydrationValidationError);
    for (const amountMilliliters of [0, 20_001, 1.5]) {
      await expect(
        createHydrationEntry(unreachableDatabase, {
          amountMilliliters,
          clientOperationId: "10000000-0000-4000-8000-000000000001",
          occurredAt: "2026-08-15T00:00:00Z",
          requestDigest: "a".repeat(64),
          userId: "user",
        }),
      ).rejects.toBeInstanceOf(HydrationValidationError);
    }
  });

  it("rejects unsupported guarded-create zones and empty updates before querying", async () => {
    await expect(
      createHydrationEntry(unreachableDatabase, {
        amountMilliliters: 250,
        clientOperationId: "10000000-0000-4000-8000-000000000001",
        expectedProfileTimeZone: "Not/A_Zone",
        occurredAt: "2026-08-15T00:00:00Z",
        requestDigest: "a".repeat(64),
        userId: "user",
      }),
    ).rejects.toBeInstanceOf(HydrationValidationError);
    await expect(
      updateHydrationEntry(unreachableDatabase, {
        clientOperationId: "10000000-0000-4000-8000-000000000001",
        entryId: "10000000-0000-4000-8000-000000000002",
        expectedEntryRevision: "1",
        requestDigest: "a".repeat(64),
        userId: "user",
      }),
    ).rejects.toBeInstanceOf(HydrationValidationError);
  });

  it.each(["0000-01-01", "2026-02-30", "not-a-date"])(
    "rejects an invalid local day before querying: %s",
    async (localDate) => {
      await expect(
        getHydrationDay(unreachableDatabase, { localDate, userId: "user" }),
      ).rejects.toBeInstanceOf(HydrationValidationError);
    },
  );

  it("publishes stable typed persistence errors", () => {
    expect(new HydrationNotFoundError().code).toBe("HYDRATION_NOT_FOUND");
    expect(new HydrationEntryRevisionConflictError().code).toBe(
      "HYDRATION_ENTRY_REVISION_CONFLICT",
    );
    expect(new HydrationIdempotencyConflictError().code).toBe("HYDRATION_IDEMPOTENCY_CONFLICT");
    expect(new HydrationTimeZoneChangedError().code).toBe("HYDRATION_TIME_ZONE_CHANGED");
  });
});
