import type { PlatformIntegration } from "@nutrition-tracker/contracts";
import { describe, expect, it, vi } from "vitest";

import { establishHealthCursorEpoch } from "./health-connection";

const oldDevice = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
const newDevice = "018f6f58-4e2c-7b62-8f0b-3d75491713b6";

function integration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    platform: "apple_healthkit",
    deviceId: oldDevice,
    revision: "7",
    cursorEpoch: "4",
    status: "connected",
    dataTypeCodes: ["body_weight"],
    consentGrantedAt: "2026-08-16T08:00:00.000Z",
    disconnectedAt: null,
    lastImportAt: "2026-08-16T08:10:00.000Z",
    currentSourceCursor: "a".repeat(64),
    consentHistory: [],
    ...overrides,
  };
}

describe("native health cursor-epoch recovery", () => {
  it("preserves a retained journal until reconnect consent is accepted, then starts a full dedupe epoch", async () => {
    const resetLocalCursor = vi.fn(async () => undefined);
    const consent = vi.fn(async () =>
      integration({
        deviceId: newDevice,
        revision: "9",
        cursorEpoch: "5",
        status: "connected",
        disconnectedAt: null,
        currentSourceCursor: null,
      }),
    );
    const result = await establishHealthCursorEpoch({
      existing: integration({
        revision: "8",
        status: "disconnected",
        disconnectedAt: "2026-08-16T09:00:00.000Z",
      }),
      deviceId: newDevice,
      localServerDigest: "a".repeat(64),
      pendingBatch: null,
      consent,
      rebind: vi.fn(),
      resetLocalCursor,
    });
    expect(consent).toHaveBeenCalledOnce();
    expect(resetLocalCursor).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reset: true,
      integration: { deviceId: newDevice, currentSourceCursor: null },
    });
  });

  it("rebinds a connected integration after key invalidation or protected-journal loss", async () => {
    const resetLocalCursor = vi.fn(async () => undefined);
    const rebind = vi.fn(async () =>
      integration({
        deviceId: newDevice,
        revision: "8",
        cursorEpoch: "5",
        currentSourceCursor: null,
      }),
    );
    await establishHealthCursorEpoch({
      existing: integration(),
      deviceId: newDevice,
      localServerDigest: "a".repeat(64),
      pendingBatch: null,
      consent: vi.fn(),
      rebind,
      resetLocalCursor,
    });
    expect(rebind).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: oldDevice }),
      newDevice,
    );
    expect(resetLocalCursor).toHaveBeenCalledOnce();

    resetLocalCursor.mockClear();
    await establishHealthCursorEpoch({
      existing: integration({ deviceId: newDevice }),
      deviceId: newDevice,
      localServerDigest: null,
      pendingBatch: null,
      consent: vi.fn(),
      rebind,
      resetLocalCursor,
    });
    expect(rebind).toHaveBeenCalledTimes(2);
    expect(resetLocalCursor).toHaveBeenCalledOnce();
  });

  it("never destroys the retained journal before a server mutation succeeds", async () => {
    const resetLocalCursor = vi.fn(async () => undefined);
    await expect(
      establishHealthCursorEpoch({
        existing: integration({
          status: "disconnected",
          disconnectedAt: "2026-08-16T09:00:00.000Z",
        }),
        deviceId: newDevice,
        localServerDigest: "a".repeat(64),
        pendingBatch: null,
        consent: async () => {
          throw new Error("offline");
        },
        rebind: vi.fn(),
        resetLocalCursor,
      }),
    ).rejects.toThrow(/offline/u);
    expect(resetLocalCursor).not.toHaveBeenCalled();
  });
});
