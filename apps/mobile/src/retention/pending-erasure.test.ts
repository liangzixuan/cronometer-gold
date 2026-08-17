import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ERASURE_SERIALIZED_BODY,
  createPendingErasureStore,
  type PendingErasureKeyValue,
} from "./pending-erasure";

function memory(): PendingErasureKeyValue & { value: string | null } {
  return {
    value: null,
    async get() {
      return this.value;
    },
    async set(value) {
      this.value = value;
    },
    async delete() {
      this.value = null;
    },
  };
}

describe("protected pending erasure envelope", () => {
  it("survives a process restart byte-exactly until the capability is durable", async () => {
    const storage = memory();
    const envelope = {
      version: 1 as const,
      operationId: "018f6f58-4e2c-4b62-8f0b-3d75491713b5",
      serializedBody: ACCOUNT_ERASURE_SERIALIZED_BODY,
      reauthenticationToken: "r".repeat(43),
      createdAt: "2026-08-16T12:00:00.000Z",
    } as const;
    await createPendingErasureStore(storage).save(envelope);
    expect(await createPendingErasureStore(storage).load()).toEqual(envelope);
    await createPendingErasureStore(storage).clear();
    expect(await createPendingErasureStore(storage).load()).toBeNull();
  });

  it("rejects a changed body or operation identity", async () => {
    const storage = memory();
    storage.value = JSON.stringify({
      version: 1,
      operationId: "not-an-operation",
      serializedBody: '{"confirmation":"NO"}',
      reauthenticationToken: "r".repeat(43),
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    await expect(createPendingErasureStore(storage).load()).rejects.toThrow(/invalid/u);
  });
});
