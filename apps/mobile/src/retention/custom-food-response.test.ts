import { describe, expect, it } from "vitest";

import { parseCustomFoodList, parseCustomFoodResponse } from "./retention";

const customFood = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  status: "active",
  revision: "1",
  currentVersion: {
    id: "123",
    versionNumber: 1,
    name: "Synthetic test food",
    brandName: null,
    notes: null,
    serving: { id: "456", label: "Serving", grams: "100" },
    nutrients: [
      {
        nutrient: { id: "208", code: "energy", name: "Energy", unit: "kcal" },
        state: "quantified",
        amountPer100Grams: "125.5",
      },
    ],
    provenance: { kind: "user_entered", statement: "Synthetic user-entered test fixture." },
    createdAt: "2026-09-09T12:00:00.000Z",
  },
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
} as const;

describe("mobile custom-food version identifiers", () => {
  it.each(["1", "9007199254740993", "99999999999999999999"])(
    "preserves exact decimal identifier %s in detail, create/replay, and list responses",
    (versionId) => {
      const food = {
        ...customFood,
        currentVersion: { ...customFood.currentVersion, id: versionId },
      };
      for (const data of [
        { customFood: food },
        { replayed: false, customFood: food },
        { replayed: true, customFood: food },
      ]) {
        const parsed = parseCustomFoodResponse({ data });
        expect(parsed.currentVersion.id).toBe(versionId);
        expect(parsed.id).toBe(customFood.id);
      }
      const page = parseCustomFoodList({ data: [food], page: { nextCursor: null } });
      expect(page.items[0]?.currentVersion.id).toBe(versionId);
    },
  );

  it.each([
    "3bcfa2bf-4950-43f7-9f24-b983ac803012",
    123,
    9007199254740993n,
    "",
    "0",
    "01",
    "1.0",
    "1e3",
    "+1",
    "-1",
    " 1",
    "1 ",
    "1\n",
    "100000000000000000000",
    null,
  ])("rejects the noncanonical or nonstring version identifier %s", (versionId) => {
    const food = { ...customFood, currentVersion: { ...customFood.currentVersion, id: versionId } };
    expect(() => parseCustomFoodResponse({ data: { customFood: food } })).toThrow(
      "custom food was invalid",
    );
    expect(() => parseCustomFoodList({ data: [food], page: { nextCursor: null } })).toThrow(
      "custom food was invalid",
    );
  });

  it("continues to require a UUID for the separate custom-food identity", () => {
    expect(() =>
      parseCustomFoodResponse({ data: { customFood: { ...customFood, id: "123" } } }),
    ).toThrow("custom food was invalid");
  });
});
