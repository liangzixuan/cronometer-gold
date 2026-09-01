import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createFoodDiaryEntry,
  type Database,
  DiaryEntryRevisionConflictError,
  DiaryIdempotencyConflictError,
  DiaryNotFoundError,
  DiaryValidationError,
  getDiaryDay,
  registerPasswordAccount,
} from "../src/index.js";

const unreachableDatabase = {} as Kysely<Database>;

describe("diary persistence boundary validation", () => {
  it("rejects malformed operation identities before opening a transaction", async () => {
    await expect(
      createFoodDiaryEntry(unreachableDatabase, {
        clientOperationId: "not-a-uuid",
        foodVersionId: "1",
        mealSlot: "breakfast",
        occurredAt: "2026-08-15T00:00:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "a".repeat(64),
        userId: "user",
      }),
    ).rejects.toMatchObject({ code: "DIARY_VALIDATION" });
  });

  it.each(["", "x".repeat(2_001), "bad\u0000note", "\uD800", "\uDC00"])(
    "rejects an invalid mutable note before opening a transaction",
    async (note) => {
      await expect(
        createFoodDiaryEntry(unreachableDatabase, {
          clientOperationId: "10000000-0000-4000-8000-000000000001",
          foodVersionId: "1",
          mealSlot: "breakfast",
          note,
          occurredAt: "2026-08-15T00:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "a".repeat(64),
          userId: "user",
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
    },
  );

  it("rejects impossible calendar dates before querying", async () => {
    await expect(
      getDiaryDay(unreachableDatabase, { localDate: "2026-02-30", userId: "user" }),
    ).rejects.toBeInstanceOf(DiaryValidationError);
  });

  it("rejects PostgreSQL-incompatible year zero before querying", async () => {
    await expect(
      getDiaryDay(unreachableDatabase, { localDate: "0000-01-01", userId: "user" }),
    ).rejects.toBeInstanceOf(DiaryValidationError);
  });

  it("normalizes no malformed email into account persistence", async () => {
    await expect(
      registerPasswordAccount(unreachableDatabase, {
        email: "invalid",
        passwordHash: "fixture-password-hash",
        passwordParameters: {},
        passwordSalt: "fixture-password-salt",
        timeZone: "UTC",
      }),
    ).rejects.toThrow("email is invalid");
  });

  it("publishes stable typed conflict/not-found codes", () => {
    expect(new DiaryNotFoundError().code).toBe("DIARY_NOT_FOUND");
    expect(new DiaryEntryRevisionConflictError().code).toBe("DIARY_ENTRY_REVISION_CONFLICT");
    expect(new DiaryIdempotencyConflictError().code).toBe("DIARY_IDEMPOTENCY_CONFLICT");
  });
});
