import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  granted: vi.fn(),
  changes: vi.fn(),
  read: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("react-native-health-connect", () => ({
  initialize: mocks.initialize,
  getGrantedPermissions: mocks.granted,
  getChanges: mocks.changes,
  readRecords: mocks.read,
  openHealthConnectSettings: mocks.settings,
}));

import {
  createNativeHealthAdapter,
  hasWeightReadPermission,
  parseAndroidProviderCursor,
} from "./native-health.android";

describe("Health Connect authoritative full reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue(true);
    mocks.changes.mockResolvedValue({
      upsertionChanges: [],
      deletionChanges: [],
      nextChangesToken: "next-token",
      changesTokenExpired: false,
      hasMore: false,
    });
    mocks.read.mockResolvedValue({ records: [], pageToken: undefined });
    mocks.granted.mockResolvedValue([{ accessType: "read", recordType: "Weight" }]);
  });

  it("recognizes only an explicit READ_WEIGHT grant", () => {
    expect(hasWeightReadPermission([{ accessType: "read", recordType: "Weight" }])).toBe(true);
    expect(hasWeightReadPermission([{ accessType: "read", recordType: "Steps" }])).toBe(false);
    expect(hasWeightReadPermission([{ accessType: "write", recordType: "Weight" }])).toBe(false);
  });

  it("refuses absence-derived deletions if permission is revoked during a full snapshot", async () => {
    mocks.granted
      .mockResolvedValueOnce([{ accessType: "read", recordType: "Weight" }])
      .mockResolvedValueOnce([]);
    await expect(
      createNativeHealthAdapter().readWeightChanges({
        providerCursor: null,
        knownRevisions: { imported: "1" },
        recordedTimeZone: "America/Chicago",
      }),
    ).rejects.toThrow(/revoked/u);
  });

  it("retains an older known ID absent from the bounded post-regrant snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    const changes = await createNativeHealthAdapter().readWeightChanges({
      providerCursor: null,
      knownRevisions: { "older-than-readable-window": "revision-1" },
      recordedTimeZone: "America/Chicago",
    });
    expect(changes.deletionSemantics).toBe("explicit_only");
    expect(changes.pages).toHaveLength(1);
    expect(changes.pages[0]?.records).toEqual([]);
    expect(changes.pages[0]?.nextKnownRevisions).toEqual({
      "older-than-readable-window": "revision-1",
    });
    expect(mocks.read).toHaveBeenCalledWith(
      "Weight",
      expect.objectContaining({
        timeRangeFilter: {
          operator: "after",
          startTime: "2026-07-17T12:00:00.000Z",
        },
      }),
    );
    vi.useRealTimers();
  });

  it("persists and reuses the bounded recovery start after token expiry", async () => {
    mocks.changes
      .mockResolvedValueOnce({
        upsertionChanges: [],
        deletionChanges: [],
        nextChangesToken: "expired",
        changesTokenExpired: true,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        upsertionChanges: [],
        deletionChanges: [],
        nextChangesToken: "replacement-token",
        changesTokenExpired: false,
        hasMore: false,
      });
    const cursor = JSON.stringify({
      version: 1,
      changesToken: "prior-token",
      recoveryStart: "2026-07-01T00:00:00.000Z",
    });
    const changes = await createNativeHealthAdapter().readWeightChanges({
      providerCursor: cursor,
      knownRevisions: { old: "1" },
      recordedTimeZone: "America/Chicago",
    });
    expect(mocks.read).toHaveBeenCalledWith(
      "Weight",
      expect.objectContaining({
        timeRangeFilter: { operator: "after", startTime: "2026-07-01T00:00:00.000Z" },
      }),
    );
    expect(parseAndroidProviderCursor(changes.providerCursor).changesToken).toBe(
      "replacement-token",
    );
    expect(changes.pages[0]?.nextKnownRevisions).toEqual({ old: "1" });
  });
});
