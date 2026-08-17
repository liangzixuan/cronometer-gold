import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  authorize: vi.fn(),
  query: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("react-native", () => ({ Linking: { openSettings: mocks.settings } }));
vi.mock("@kingstinct/react-native-healthkit", () => ({
  isHealthDataAvailableAsync: mocks.available,
  requestAuthorization: mocks.authorize,
  queryQuantitySamplesWithAnchor: mocks.query,
}));

import { createNativeHealthAdapter } from "./native-health.ios";

describe("HealthKit opaque-read reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.available.mockResolvedValue(true);
    mocks.authorize.mockResolvedValue(true);
  });

  it("uses an expired-anchor full reread without deleting UUIDs absent from an opaque result", async () => {
    mocks.query
      .mockRejectedValueOnce(new Error("invalid anchor"))
      .mockResolvedValueOnce({ samples: [], deletedSamples: [], newAnchor: "fresh-anchor" });
    const changes = await createNativeHealthAdapter().readWeightChanges({
      providerCursor: "expired-anchor",
      knownRevisions: { "not-visible-or-revoked": "2" },
      recordedTimeZone: "America/Chicago",
    });
    expect(changes.fullReconciliation).toBe(true);
    expect(changes.deletionSemantics).toBe("explicit_only");
    expect(changes.pages[0]?.records).toEqual([]);
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      "HKQuantityTypeIdentifierBodyMass",
      expect.not.objectContaining({ anchor: expect.anything() }),
    );
  });

  it("applies an explicit anchored deletion even though absence is never authoritative", async () => {
    mocks.query.mockResolvedValueOnce({
      samples: [],
      deletedSamples: [{ uuid: "explicitly-deleted" }],
      newAnchor: "fresh-anchor",
    });
    const changes = await createNativeHealthAdapter().readWeightChanges({
      providerCursor: null,
      knownRevisions: { "explicitly-deleted": "1", "not-visible": "2" },
      recordedTimeZone: "America/Chicago",
    });
    expect(changes.pages[0]?.records).toEqual([
      {
        operation: "delete",
        externalId: "explicitly-deleted",
        externalRevision: "anchor:fresh-anchor",
      },
    ]);
  });

  it("does not claim a distinguishable read denial", async () => {
    mocks.authorize.mockResolvedValue(false);
    await expect(createNativeHealthAdapter().requestWeightReadPermission()).resolves.toEqual({
      status: "error",
      readAuthorizationOpaque: true,
    });
  });
});
