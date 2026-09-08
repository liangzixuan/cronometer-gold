import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  deleteDiaryEntry: vi.fn(),
  getUserProfile: vi.fn(),
  reorderDiaryDay: vi.fn(),
  repeatDiaryEntry: vi.fn(),
  updateDiaryEntry: vi.fn(),
}));

vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  deleteDiaryEntry: databaseMocks.deleteDiaryEntry,
  getUserProfile: databaseMocks.getUserProfile,
  reorderDiaryDay: databaseMocks.reorderDiaryDay,
  repeatDiaryEntry: databaseMocks.repeatDiaryEntry,
  updateDiaryEntry: databaseMocks.updateDiaryEntry,
}));

import {
  type DiaryCorrectionMutationResult,
  type DiaryDayReorderResult,
  DiaryDayRevisionConflictError,
  DiaryLockedError,
} from "@nutrition-tracker/db";
import {
  DiaryLockedServiceError,
  DiaryRevisionConflictServiceError,
} from "../src/modules/diary/diary.routes.js";
import { DatabaseDiaryService } from "../src/persistence-services.js";
import { DatabaseRetentionService } from "../src/retention-persistence-service.js";

const userId = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const entryId = "75d7fa63-4e26-42de-a1f8-0683ce268f62";
const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc";
const requestDigest = "c".repeat(64);
const expectedOrderDigest = "a".repeat(64);
const orderDigest = "b".repeat(64);

const deleteResult = {
  replayed: false,
  entry: {} as never,
  days: [{ localDate: "2026-08-15", revision: "5" }],
  receipt: {
    protocol: "v1",
    operationId,
    kind: "delete",
    expectedSubjects: [{ entryId, revision: "3" }],
    resultSubjects: [{ entryId, revision: "4", state: "deleted" }],
    affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
  },
} as const satisfies DiaryCorrectionMutationResult;

const reorderResult = {
  replayed: false,
  receipt: {
    operationId,
    localDate: "2026-08-15",
    timeZone: "America/Chicago",
    expectedDayRevision: "4",
    resultingDayRevision: "5",
    previousOrderDigest: expectedOrderDigest,
    orderDigest,
    groups: [
      {
        mealSlot: "breakfast",
        entries: [{ entryId, entryRevision: "4", position: 0 }],
      },
      { mealSlot: "lunch", entries: [] },
      { mealSlot: "dinner", entries: [] },
      { mealSlot: "snacks", entries: [] },
    ],
  },
} as const satisfies DiaryDayReorderResult;

function service(): DatabaseDiaryService {
  return new DatabaseDiaryService({} as never, { cursorSecret: "c".repeat(32) });
}

function retentionService(): DatabaseRetentionService {
  return new DatabaseRetentionService({
    database: {} as never,
    artifacts: {} as never,
    deviceChallengeHmacKey: new Uint8Array(32),
    erasureStatusCapabilityHmacKey: new Uint8Array(32),
    erasureLedgerLocatorKeyRing: {} as never,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("diary correction persistence adapter", () => {
  it("passes the guarded update coordinates and idempotency binding to PostgreSQL", async () => {
    const sentinel = new Error("stop after argument capture");
    databaseMocks.updateDiaryEntry.mockRejectedValueOnce(sentinel);
    await expect(
      service().updateEntryCorrection({
        userId,
        entryId,
        expectedRevision: "3",
        clientOperationId: operationId,
        requestDigest,
        expectedProfileTimeZone: "America/Chicago",
        patch: { occurredAt: "2026-08-16T12:00:00.000Z", note: "Private note" },
      }),
    ).rejects.toBe(sentinel);

    expect(databaseMocks.updateDiaryEntry).toHaveBeenCalledWith(
      {},
      {
        userId,
        entryId,
        expectedEntryRevision: "3",
        clientOperationId: operationId,
        requestDigest,
        expectedProfileTimeZone: "America/Chicago",
        occurredAt: "2026-08-16T12:00:00.000Z",
        note: "Private note",
      },
    );
  });

  it("passes the exact repeat source and target timezone to PostgreSQL", async () => {
    const sentinel = new Error("stop after argument capture");
    databaseMocks.repeatDiaryEntry.mockRejectedValueOnce(sentinel);
    await expect(
      service().repeatEntryCorrection({
        userId,
        sourceEntryId: entryId,
        expectedSourceRevision: "3",
        clientOperationId: operationId,
        requestDigest,
        expectedProfileTimeZone: "America/Chicago",
        request: {
          occurredAt: "2026-08-16T12:00:00.000Z",
          mealSlot: "dinner",
          position: 2,
        },
      }),
    ).rejects.toBe(sentinel);

    expect(databaseMocks.repeatDiaryEntry).toHaveBeenCalledWith(
      {},
      {
        userId,
        sourceEntryId: entryId,
        sourceRevision: "3",
        clientOperationId: operationId,
        requestDigest,
        expectedProfileTimeZone: "America/Chicago",
        occurredAt: "2026-08-16T12:00:00.000Z",
        mealSlot: "dinner",
        position: 2,
      },
    );
  });

  it("maps a durable delete without returning the private deleted snapshot", async () => {
    databaseMocks.deleteDiaryEntry.mockResolvedValueOnce(deleteResult);
    const response = await service().deleteEntryCorrection({
      userId,
      entryId,
      expectedRevision: "3",
      clientOperationId: operationId,
      requestDigest,
    });

    expect(databaseMocks.deleteDiaryEntry).toHaveBeenCalledWith(
      {},
      {
        userId,
        entryId,
        expectedEntryRevision: "3",
        clientOperationId: operationId,
        requestDigest,
      },
    );
    expect(response).toEqual({
      data: {
        replayed: false,
        entry: null,
        affectedDays: deleteResult.days,
        receipt: deleteResult.receipt,
      },
    });
  });

  it("maps the canonical atomic reorder receipt and stale-day conflict", async () => {
    databaseMocks.reorderDiaryDay.mockResolvedValueOnce(reorderResult);
    const input = {
      userId,
      localDate: "2026-08-15",
      expectedDayRevision: "4",
      expectedOrderDigest,
      expectedProfileTimeZone: "America/Chicago",
      clientOperationId: operationId,
      requestDigest,
      groups: { breakfast: [0], lunch: [], dinner: [], snacks: [] },
    } as const;
    await expect(service().reorderDay(input)).resolves.toEqual({
      data: { replayed: false, receipt: reorderResult.receipt },
    });
    expect(databaseMocks.reorderDiaryDay).toHaveBeenCalledWith({}, input);

    databaseMocks.reorderDiaryDay.mockRejectedValueOnce(new DiaryDayRevisionConflictError());
    await expect(service().reorderDay(input)).rejects.toBeInstanceOf(
      DiaryRevisionConflictServiceError,
    );
  });

  it("preserves a locked-day conflict through the legacy repeat adapter", async () => {
    databaseMocks.getUserProfile.mockResolvedValueOnce({
      timeZone: "America/Chicago",
    });
    databaseMocks.repeatDiaryEntry.mockRejectedValueOnce(new DiaryLockedError());
    await expect(
      retentionService().repeatEntry({
        userId,
        sourceEntryId: entryId,
        expectedSourceRevision: "3",
        clientOperationId: operationId,
        requestDigest,
        request: { occurredAt: "2026-08-16T12:00:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(DiaryLockedServiceError);

    expect(databaseMocks.getUserProfile).toHaveBeenCalledWith({}, userId);
    expect(databaseMocks.repeatDiaryEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ expectedProfileTimeZone: "America/Chicago" }),
    );
  });
});
