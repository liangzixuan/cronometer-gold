import { sql, type Transaction } from "kysely";

import type { Database } from "./types.js";

const ACTIVE_NUTRIENT_REGISTRY_LOCK_NAMESPACE = "nutrition-tracker:active-nutrient-registry:v1";

export async function lockActiveNutrientRegistryForRead(
  transaction: Transaction<Database>,
): Promise<void> {
  await sql`
    select pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtext(${ACTIVE_NUTRIENT_REGISTRY_LOCK_NAMESPACE})
    )
  `.execute(transaction);
}

export async function lockActiveNutrientRegistryForWrite(
  transaction: Transaction<Database>,
): Promise<void> {
  await sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(${ACTIVE_NUTRIENT_REGISTRY_LOCK_NAMESPACE})
    )
  `.execute(transaction);
}
