import { randomUUID } from "expo-crypto";

import { createOperationId } from "../diary/diary";

/** Generate a CSPRNG-backed UUID or throw; mutation identity never uses weak randomness. */
export function newOperationId(): string {
  return createOperationId(randomUUID);
}
