import { describe, expect, it } from "vitest";

import { prepareQuickAddOperation } from "../../lib/diary";
import { fenceQuickAddForTimeZoneChange, quickAddTimeZoneReviewMessage } from "./FoodSearchClient";

function operation(operationId = "a7183708-7725-4b7c-a180-58e03ca01234") {
  return prepareQuickAddOperation(
    new Map(),
    {
      foodVersionId: "202",
      portion: { kind: "grams", grams: "125.5" },
      localDate: "2026-09-08",
      mealSlot: "breakfast",
      timeZone: "America/Chicago",
    },
    new Date("2026-09-08T13:30:00.000Z"),
    () => operationId,
  );
}

describe("web food quick-add time-zone recovery", () => {
  it("invalidates the exact stale retry only for the forwarded typed no-write conflict", () => {
    const stale = operation();
    const pending = new Map([[stale.intentKey, stale]]);

    expect(
      fenceQuickAddForTimeZoneChange(pending, stale, 409, {
        error: "The profile time zone changed.",
        code: "DIARY_TIME_ZONE_CHANGED",
      }),
    ).toBe(true);
    expect(pending.has(stale.intentKey)).toBe(false);
    expect(pending.size).toBe(0);
  });

  it("retains the retry for ambiguous or differently typed failures", () => {
    const pendingForGenericConflict = new Map<string, ReturnType<typeof operation>>();
    const genericConflict = operation();
    pendingForGenericConflict.set(genericConflict.intentKey, genericConflict);
    expect(
      fenceQuickAddForTimeZoneChange(pendingForGenericConflict, genericConflict, 409, {
        error: "Conflict",
        code: "CONFLICT",
      }),
    ).toBe(false);
    expect(pendingForGenericConflict.get(genericConflict.intentKey)).toBe(genericConflict);

    const pendingForWrongStatus = new Map<string, ReturnType<typeof operation>>();
    const wrongStatus = operation("f2a47c26-8e02-4057-8b48-cda619302452");
    pendingForWrongStatus.set(wrongStatus.intentKey, wrongStatus);
    expect(
      fenceQuickAddForTimeZoneChange(pendingForWrongStatus, wrongStatus, 422, {
        code: "DIARY_TIME_ZONE_CHANGED",
      }),
    ).toBe(false);
    expect(pendingForWrongStatus.get(wrongStatus.intentKey)).toBe(wrongStatus);
  });

  it("tells the user no write occurred and requires date review before another add", () => {
    const refreshed = quickAddTimeZoneReviewMessage("2026-09-08", "Pacific/Kiritimati");
    expect(refreshed).toContain("This food was not added");
    expect(refreshed).toContain("Review 2026-09-08");
    expect(refreshed).toContain("confirm the day before adding again");
    expect(refreshed).toContain("Pacific/Kiritimati");

    const unavailable = quickAddTimeZoneReviewMessage("2026-09-08", null);
    expect(unavailable).toContain("stale retry was cleared");
    expect(unavailable).toContain("refresh this page");
  });
});
