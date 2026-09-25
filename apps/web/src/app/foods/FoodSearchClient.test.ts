import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("date=2026-09-24&meal=dinner"),
}));

import { parseDiaryMutation, prepareQuickAddOperation } from "../../lib/diary";
import {
  confirmedFoodAddDate,
  FoodAddConfirmation,
  FoodSearchClient,
  fenceQuickAddForTimeZoneChange,
  quickAddTimeZoneReviewMessage,
} from "./FoodSearchClient";

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

const source = {
  code: "USDA_FDC",
  releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
  displayName: "USDA FoodData Central",
  licenseExpression: "CC0-1.0",
  attributionRequired: true,
  attributionText: "Data source: USDA FoodData Central",
};

function mutationResponse() {
  return {
    data: {
      replayed: false,
      entry: {
        id: "96aac405-c107-4776-923e-a40ca5014975",
        revision: "1",
        entryKind: "food",
        foodVersionId: "202",
        recipeVersionId: null,
        portion: { kind: "serving", servingId: "303", amount: "0.5", servingLabel: "1 medium" },
        food: { name: "Banana", brandName: null },
        recipe: null,
        source,
        foodProvenance: { kind: "public", source },
        mealSlot: "dinner",
        resolvedGrams: "60",
        note: null,
        occurredAt: "2026-09-23T17:00:00.000Z",
        localDate: "2026-09-23",
        timeZone: "America/Chicago",
        localTime: "12:00:00",
        position: 0,
        nutrients: [],
      },
      affectedDays: [{ localDate: "2026-09-23", revision: "8" }],
    },
  };
}

describe("confirmed food-add destination", () => {
  it.each([false, true])(
    "uses the saved entry and affected-day date for replayed=%s",
    (replayed) => {
      const response = mutationResponse();
      response.data.replayed = replayed;
      const original = JSON.stringify(response);
      const savedDate = confirmedFoodAddDate(parseDiaryMutation(response), "202");
      expect(savedDate).toBe("2026-09-23");
      expect(JSON.stringify(response)).toBe(original);
    },
  );

  it("rejects absent, invalid, ambiguous or unrelated affected days instead of inventing a destination", () => {
    const response = mutationResponse();
    for (const affectedDays of [
      [],
      [{ localDate: "invalid", revision: "8" }],
      [{ localDate: "2026-09-24", revision: "8" }],
      [...response.data.affectedDays, { localDate: "2026-09-24", revision: "9" }],
    ]) {
      expect(() =>
        confirmedFoodAddDate(
          parseDiaryMutation({
            data: { ...response.data, affectedDays },
          }),
          "202",
        ),
      ).toThrow();
    }
    expect(() =>
      confirmedFoodAddDate(
        parseDiaryMutation({
          data: { ...response.data, entry: null },
        }),
        "202",
      ),
    ).toThrow();
    expect(() => confirmedFoodAddDate(parseDiaryMutation(response), "203")).toThrow();
  });

  it("keeps the inline area mounted without duplicating the global announcement", () => {
    const markup = renderToStaticMarkup(createElement(FoodAddConfirmation, { confirmation: null }));
    expect(markup).toContain('data-state="idle"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("aria-live");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("hidden");
  });

  it("renders an explicit link to the confirmed date, independent of the current form date", () => {
    const localDate = confirmedFoodAddDate(parseDiaryMutation(mutationResponse()), "202");
    const markup = renderToStaticMarkup(
      createElement(FoodAddConfirmation, {
        confirmation: {
          localDate,
          message: "0.5 default servings of Banana was added to Dinner on 2026-09-23.",
        },
      }),
    );
    expect(markup).toContain('data-state="ready"');
    expect(markup).toContain('href="/dashboard?date=2026-09-23"');
    expect(markup).toContain("Open diary for 2026-09-23");
    expect(markup).toContain("was added to Dinner on 2026-09-23.");
    expect(markup).not.toContain("2026-09-24");
  });
});

describe("food search presentation", () => {
  it("puts the query before food types and destination without changing the requested day and meal", () => {
    const markup = renderToStaticMarkup(createElement(FoodSearchClient));
    expect(markup.indexOf('id="food-query"')).toBeLessThan(
      markup.indexOf('class="intentFieldset"'),
    );
    expect(markup.indexOf('class="intentFieldset"')).toBeLessThan(
      markup.indexOf('id="quick-add-date"'),
    );
    expect(markup.indexOf('id="quick-add-date"')).toBeLessThan(markup.indexOf('class="addStatus'));
    expect(markup).toContain('value="2026-09-24"');
    expect(markup).toContain('<option value="dinner" selected="">Dinner</option>');
    expect(markup).toContain('aria-label="Food search"');
    expect(markup).toContain('class="addStatus addStatus--idle" role="status" aria-live="polite"');
  });
});
