import { describe, expect, it } from "vitest";

import {
  beginPrivateDeviceCleanup,
  type PendingPrivateCleanup,
  type PrivateCleanupDependencies,
  type PrivateCleanupStore,
  parsePendingPrivateCleanup,
  resumePrivateDeviceCleanup,
} from "./device-cleanup";

function memoryStore(): {
  readonly store: PrivateCleanupStore;
  marker(): PendingPrivateCleanup | null;
} {
  let marker: PendingPrivateCleanup | null = null;
  return {
    store: {
      load: async () => marker,
      save: async (next) => {
        marker = next;
      },
      clear: async () => {
        marker = null;
      },
    },
    marker: () => marker,
  };
}

function dependencies(events: string[]): PrivateCleanupDependencies {
  return {
    closePrivateUi: () => events.push("close-ui"),
    cleanupServerState: async () => {
      events.push("server");
    },
    clearQuickAddOutbox: async () => {
      events.push("outbox");
    },
    clearLocalReminders: async () => {
      events.push("reminders");
    },
    clearHealthCursors: async () => {
      events.push("cursors");
    },
    clearDeviceState: async () => {
      events.push("device-state");
    },
    deleteSigningKey: async () => {
      events.push("key");
    },
    clearSessionCredential: async () => {
      events.push("session");
    },
    now: () => new Date("2026-08-16T08:00:00.000Z"),
  };
}

describe("terminal private-device cleanup", () => {
  it("closes private UI first and completes local deletion while offline server cleanup fails", async () => {
    const events: string[] = [];
    const state = memoryStore();
    const deps = {
      ...dependencies(events),
      cleanupServerState: async () => {
        events.push("server-offline");
        throw new Error("offline");
      },
    };
    const result = await beginPrivateDeviceCleanup("sign_out", deps, state.store);
    expect(events[0]).toBe("close-ui");
    expect(events).toEqual([
      "close-ui",
      "server-offline",
      "outbox",
      "reminders",
      "cursors",
      "device-state",
      "key",
      "session",
    ]);
    expect(result).toMatchObject({
      complete: true,
      remoteCleanupIncomplete: true,
      pendingSteps: [],
    });
    expect(state.marker()).toBeNull();
  });

  it("retains a failed local step and retries it on the next launch without reopening private UI", async () => {
    const events: string[] = [];
    const state = memoryStore();
    let reminderAttempts = 0;
    const deps = {
      ...dependencies(events),
      clearLocalReminders: async () => {
        reminderAttempts += 1;
        events.push(`reminders-${reminderAttempts}`);
        if (reminderAttempts === 1) throw new Error("notification-service-unavailable");
      },
    };
    const first = await beginPrivateDeviceCleanup("terminal_unauthorized", deps, state.store);
    expect(first.complete).toBe(false);
    expect(first.pendingSteps).toEqual(["local_reminders"]);
    expect(state.marker()?.pendingSteps).toEqual(["local_reminders"]);

    const resumed = await resumePrivateDeviceCleanup(deps, state.store);
    expect(resumed?.complete).toBe(true);
    expect(events.filter((event) => event === "close-ui")).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("reminders-"))).toEqual([
      "reminders-1",
      "reminders-2",
    ]);
    expect(events.filter((event) => event === "session")).toHaveLength(1);
    expect(state.marker()).toBeNull();
  });

  it("still attempts every local deletion when cleanup-marker persistence is unavailable", async () => {
    const events: string[] = [];
    const store: PrivateCleanupStore = {
      load: async () => null,
      save: async () => {
        throw new Error("secure-store-unavailable");
      },
      clear: async () => {
        throw new Error("secure-store-unavailable");
      },
    };
    const result = await beginPrivateDeviceCleanup("account_erasure", dependencies(events), store);
    expect(events).toEqual([
      "close-ui",
      "server",
      "outbox",
      "reminders",
      "cursors",
      "device-state",
      "key",
      "session",
    ]);
    expect(result.complete).toBe(false);
    expect(result.statePersistenceFailed).toBe(true);
  });

  it("does not report completion until the cleanup marker itself is removed", async () => {
    const events: string[] = [];
    let marker: PendingPrivateCleanup | null = null;
    const currentMarker = () => marker;
    let clearAttempts = 0;
    const store: PrivateCleanupStore = {
      load: async () => marker,
      save: async (next) => {
        marker = next;
      },
      clear: async () => {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error("secure-store-unavailable");
        marker = null;
      },
    };
    const deps = dependencies(events);

    const first = await beginPrivateDeviceCleanup("sign_out", deps, store);
    expect(first.complete).toBe(false);
    expect(first.statePersistenceFailed).toBe(true);
    expect(first.pendingSteps).toEqual(["session_credential"]);
    expect(currentMarker()?.pendingSteps).toEqual(["session_credential"]);

    const resumed = await resumePrivateDeviceCleanup(deps, store);
    expect(resumed?.complete).toBe(true);
    expect(events.filter((event) => event === "session")).toHaveLength(2);
    expect(marker).toBeNull();
  });

  it("migrates a version-one marker and makes outbox deletion the first pending step", () => {
    expect(
      parsePendingPrivateCleanup(
        JSON.stringify({
          version: 1,
          reason: "sign_out",
          createdAt: "2026-08-16T08:00:00.000Z",
          pendingSteps: ["health_cursors", "session_credential"],
        }),
      ),
    ).toEqual({
      version: 2,
      reason: "sign_out",
      createdAt: "2026-08-16T08:00:00.000Z",
      pendingSteps: ["quick_add_outbox", "health_cursors", "session_credential"],
    });
  });

  it("retries an outbox deletion failure without repeating completed deletion steps", async () => {
    const events: string[] = [];
    const state = memoryStore();
    let outboxAttempts = 0;
    const deps = {
      ...dependencies(events),
      clearQuickAddOutbox: async () => {
        outboxAttempts += 1;
        events.push(`outbox-${outboxAttempts}`);
        if (outboxAttempts === 1) throw new Error("secure-store-unavailable");
      },
    };

    const first = await beginPrivateDeviceCleanup("account_erasure", deps, state.store);
    expect(first.complete).toBe(false);
    expect(first.pendingSteps).toEqual(["quick_add_outbox"]);
    expect(state.marker()?.pendingSteps).toEqual(["quick_add_outbox"]);

    const resumed = await resumePrivateDeviceCleanup(deps, state.store);
    expect(resumed?.complete).toBe(true);
    expect(events.filter((event) => event.startsWith("outbox-"))).toEqual(["outbox-1", "outbox-2"]);
    expect(events.filter((event) => event === "session")).toHaveLength(1);
  });
});
