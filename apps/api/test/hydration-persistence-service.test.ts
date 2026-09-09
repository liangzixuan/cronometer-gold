import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({ updateHydrationEntry: vi.fn() }));

vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  updateHydrationEntry: databaseMocks.updateHydrationEntry,
}));

import { HydrationTimeZoneChangedError } from "@nutrition-tracker/db";
import { HydrationTimeZoneChangedServiceError } from "../src/modules/hydration/hydration.routes.js";
import { DatabaseHydrationService } from "../src/persistence-services.js";

const identity = {
  userId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
  entryId: "75d7fa63-4e26-42de-a1f8-0683ce268f62",
  clientOperationId: "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
  requestDigest: "c".repeat(64),
};

beforeEach(() => vi.resetAllMocks());

describe("hydration correction persistence adapter", () => {
  it("passes the guarded timestamp, original revision and retry binding to PostgreSQL", async () => {
    const sentinel = new Error("stop after argument capture");
    databaseMocks.updateHydrationEntry.mockRejectedValueOnce(sentinel);
    await expect(
      new DatabaseHydrationService({} as never).updateEntry({
        ...identity,
        expectedRevision: "3",
        expectedProfileTimeZone: "America/Chicago",
        patch: { occurredAt: "2026-11-01T07:30:00.000Z", amountMilliliters: 500 },
      }),
    ).rejects.toBe(sentinel);
    expect(databaseMocks.updateHydrationEntry).toHaveBeenCalledWith(
      {},
      {
        ...identity,
        expectedEntryRevision: "3",
        expectedProfileTimeZone: "America/Chicago",
        occurredAt: "2026-11-01T07:30:00.000Z",
        amountMilliliters: 500,
      },
    );
  });

  it("keeps amount-only corrections free of timestamp and zone fields", async () => {
    const sentinel = new Error("stop after argument capture");
    databaseMocks.updateHydrationEntry.mockRejectedValueOnce(sentinel);
    await expect(
      new DatabaseHydrationService({} as never).updateEntry({
        ...identity,
        expectedRevision: "3",
        patch: { amountMilliliters: 500 },
      }),
    ).rejects.toBe(sentinel);
    expect(databaseMocks.updateHydrationEntry).toHaveBeenCalledWith(
      {},
      { ...identity, expectedEntryRevision: "3", amountMilliliters: 500 },
    );
  });

  it("maps the locked-profile mismatch to the existing public conflict type", async () => {
    databaseMocks.updateHydrationEntry.mockRejectedValueOnce(new HydrationTimeZoneChangedError());
    await expect(
      new DatabaseHydrationService({} as never).updateEntry({
        ...identity,
        expectedRevision: "3",
        expectedProfileTimeZone: "America/Chicago",
        patch: { occurredAt: "2026-11-01T07:30:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(HydrationTimeZoneChangedServiceError);
  });
});
