import { describe, expect, it } from "vitest";

import {
  createErasureCapabilityStore,
  type ErasureCapabilityKeyValue,
  type ErasureStatusCapability,
} from "./erasure-status";

const capability: ErasureStatusCapability = {
  version: 1,
  jobId: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
  token: "s".repeat(43),
  expiresAt: "2026-08-17T08:00:00.000Z",
};

function memory(): { readonly storage: ErasureCapabilityKeyValue; raw(): string | null } {
  let raw: string | null = null;
  return {
    storage: {
      get: async () => raw,
      set: async (value) => {
        raw = value;
      },
      delete: async () => {
        raw = null;
      },
    },
    raw: () => raw,
  };
}

describe("restart-safe erasure status capability", () => {
  it("retains only the bounded one-purpose tuple across session revocation and restart", async () => {
    const state = memory();
    const first = createErasureCapabilityStore(
      state.storage,
      () => new Date("2026-08-16T08:00:00.000Z"),
    );
    await first.save(capability);
    expect(Object.keys(JSON.parse(state.raw() ?? "{}")).sort()).toEqual([
      "expiresAt",
      "jobId",
      "token",
      "version",
    ]);
    const restarted = createErasureCapabilityStore(
      state.storage,
      () => new Date("2026-08-16T09:00:00.000Z"),
    );
    expect(await restarted.load()).toEqual(capability);
  });

  it("deletes the capability at expiry", async () => {
    const state = memory();
    await createErasureCapabilityStore(
      state.storage,
      () => new Date("2026-08-16T08:00:00.000Z"),
    ).save(capability);
    const expired = createErasureCapabilityStore(
      state.storage,
      () => new Date("2026-08-17T08:00:00.000Z"),
    );
    expect(await expired.load()).toBeNull();
    expect(state.raw()).toBeNull();
  });
});
