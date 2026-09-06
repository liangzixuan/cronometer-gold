import type { Transaction } from "kysely";
import { describe, expectTypeOf, it } from "vitest";

import {
  lockActiveNutrientRegistryForRead,
  lockActiveNutrientRegistryForWrite,
} from "../src/nutrient-registry-lock.js";
import type { Database } from "../src/types.js";

describe("active nutrient registry lock helpers", () => {
  it("requires a transaction-scoped executor for both lock modes", () => {
    expectTypeOf(lockActiveNutrientRegistryForRead)
      .parameter(0)
      .toEqualTypeOf<Transaction<Database>>();
    expectTypeOf(lockActiveNutrientRegistryForWrite)
      .parameter(0)
      .toEqualTypeOf<Transaction<Database>>();
  });
});
