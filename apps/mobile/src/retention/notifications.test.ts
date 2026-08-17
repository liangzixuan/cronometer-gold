import { describe, expect, it } from "vitest";

import {
  GENERIC_REMINDER_BODY,
  GENERIC_REMINDER_TITLE,
  type NotificationAdapter,
  notificationRequestsFor,
} from "./notifications";
import {
  clearAllLocalReminderSchedules,
  MAX_SCHEDULED_LOCAL_NOTIFICATIONS,
  parseReminderScheduleState,
  type ReminderScheduleState,
  type ReminderScheduleStore,
  reconcileLocalReminderSchedules,
} from "./reminder-schedule";

const reminder = {
  id: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
  revision: "3",
  status: "active" as const,
  localTime: "20:15",
  daysOfWeek: [1, 7],
  timeZone: "America/Chicago",
};

function harness(permission: "granted" | "denied" = "granted") {
  const scheduled: unknown[] = [];
  const cancelled: string[] = [];
  const owned = new Set<string>();
  let state: ReminderScheduleState = { version: 1, reminders: {} };
  const adapter: NotificationAdapter = {
    currentPermission: async () => permission,
    requestPermissionInContext: async () => permission,
    schedulingContext: async () => ({ platform: "ios", deviceTimeZone: "America/Chicago" }),
    ownedIdentifiers: async () => [...owned],
    schedule: async (request) => {
      scheduled.push(request);
      const identifier = `native-${scheduled.length}`;
      owned.add(identifier);
      return identifier;
    },
    cancel: async (identifier) => {
      cancelled.push(identifier);
      owned.delete(identifier);
    },
  };
  const store: ReminderScheduleStore = {
    load: async () => state,
    save: async (value) => {
      state = value;
    },
  };
  return { adapter, store, scheduled, cancelled, state: () => state };
}

describe("private local reminder reconciliation", () => {
  it("uses only reviewed generic lock-screen copy and the exact weekly schedule", () => {
    const requests = notificationRequestsFor(reminder);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      content: {
        title: GENERIC_REMINDER_TITLE,
        body: GENERIC_REMINDER_BODY,
        data: { owner: "nutrition-tracker-local-reminder-v1" },
      },
      dayOfWeek: 1,
      hour: 20,
      minute: 15,
      timeZone: "America/Chicago",
    });
    expect(JSON.stringify(requests)).not.toContain("meal");
    expect(JSON.stringify(requests)).not.toContain("weight");
  });

  it("does not duplicate schedules across retries or relaunch", async () => {
    const test = harness();
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    expect(test.scheduled).toHaveLength(2);
    expect(test.cancelled).toEqual([]);
    expect(test.state().reminders[reminder.id]?.identifiers).toEqual(["native-1", "native-2"]);
  });

  it("rebuilds active reminders when some or all ledger identifiers are missing from the OS", async () => {
    const partial = harness();
    await reconcileLocalReminderSchedules([reminder], partial.adapter, partial.store);
    partial.adapter.ownedIdentifiers = async () => ["native-2"];
    await reconcileLocalReminderSchedules([reminder], partial.adapter, partial.store);
    expect(partial.cancelled).toEqual(["native-2"]);
    expect(partial.scheduled).toHaveLength(4);
    expect(partial.state().reminders[reminder.id]?.identifiers).toEqual(["native-3", "native-4"]);

    const missing = harness();
    await reconcileLocalReminderSchedules([reminder], missing.adapter, missing.store);
    missing.adapter.ownedIdentifiers = async () => [];
    await reconcileLocalReminderSchedules([reminder], missing.adapter, missing.store);
    expect(missing.cancelled).toEqual([]);
    expect(missing.scheduled).toHaveLength(4);
    expect(missing.state().reminders[reminder.id]?.identifiers).toEqual(["native-3", "native-4"]);
  });

  it("rejects more than 64 active notification occurrences before mutating native state", async () => {
    const schedule = (index: number, daysOfWeek: readonly number[]) => ({
      ...reminder,
      daysOfWeek,
      id: `018f6f58-4e2c-7b62-8f0b-${index.toString().padStart(12, "0")}`,
    });
    const exactLimit = [
      ...Array.from({ length: 9 }, (_, index) => schedule(index, [1, 2, 3, 4, 5, 6, 7])),
      schedule(9, [1]),
    ];
    expect(
      exactLimit.reduce((count, item) => count + notificationRequestsFor(item).length, 0),
    ).toBe(MAX_SCHEDULED_LOCAL_NOTIFICATIONS);
    const accepted = harness();
    await expect(
      reconcileLocalReminderSchedules(exactLimit, accepted.adapter, accepted.store),
    ).resolves.toMatchObject({ scheduled: MAX_SCHEDULED_LOCAL_NOTIFICATIONS });

    const rejected = harness();
    await expect(
      reconcileLocalReminderSchedules(
        [...exactLimit, schedule(10, [2])],
        rejected.adapter,
        rejected.store,
      ),
    ).rejects.toThrow(/local notification limit/u);
    expect(rejected.scheduled).toEqual([]);
    expect(rejected.cancelled).toEqual([]);
    expect(rejected.state().reminders).toEqual({});
  });

  it("cancels old identifiers on edit, pause, revoke, absence, or permission loss", async () => {
    const test = harness();
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    await reconcileLocalReminderSchedules(
      [{ ...reminder, revision: "4", status: "paused" }],
      test.adapter,
      test.store,
    );
    expect(test.cancelled).toEqual(["native-1", "native-2"]);
    expect(test.state().reminders).toEqual({});

    const denied = harness("denied");
    await denied.store.save({
      version: 1,
      reminders: {
        [reminder.id]: {
          revision: "3",
          identifiers: ["old"],
          platform: "ios",
          deviceTimeZone: "America/Chicago",
          reminderTimeZone: "America/Chicago",
        },
      },
    });
    expect(await reconcileLocalReminderSchedules([reminder], denied.adapter, denied.store)).toEqual(
      {
        permission: "denied",
        scheduled: 0,
      },
    );
    expect(denied.cancelled).toEqual(["old"]);
  });

  it("strictly rejects persisted identifier drift", () => {
    expect(() =>
      parseReminderScheduleState(
        JSON.stringify({
          version: 1,
          reminders: {
            [reminder.id]: {
              revision: "3",
              identifiers: ["same", "same"],
              platform: "ios",
              deviceTimeZone: "America/Chicago",
              reminderTimeZone: "America/Chicago",
            },
          },
        }),
      ),
    ).toThrow(/invalid/u);
  });

  it("cancels just-created notifications when protected-ledger persistence fails", async () => {
    const test = harness();
    test.store.save = async (value) => {
      if (Object.keys(value.reminders).length > 0) throw new Error("secure-store-failed");
    };
    await expect(
      reconcileLocalReminderSchedules([reminder], test.adapter, test.store),
    ).rejects.toThrow(/secure-store/u);
    expect(test.cancelled).toEqual(["native-1", "native-2"]);
  });

  it("removes crash-orphan schedules even when another reminder keeps the ledger nonempty", async () => {
    const test = harness();
    await test.store.save({
      version: 1,
      reminders: {
        [reminder.id]: {
          revision: "3",
          identifiers: ["known-1", "known-2"],
          platform: "ios",
          deviceTimeZone: "America/Chicago",
          reminderTimeZone: "America/Chicago",
        },
      },
    });
    test.adapter.ownedIdentifiers = async () => [
      "known-1",
      "known-2",
      "orphan-after-process-death-1",
      "orphan-after-process-death-2",
    ];
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    expect(test.cancelled).toEqual([
      "orphan-after-process-death-1",
      "orphan-after-process-death-2",
    ]);
    expect(test.state().reminders[reminder.id]?.identifiers).toEqual(["known-1", "known-2"]);
  });

  it("recovers corrupt ledgers and cleans schedules for erasure", async () => {
    const test = harness();
    test.store.load = async () => {
      throw new Error("corrupt");
    };
    test.adapter.ownedIdentifiers = async () => ["orphan-1", "orphan-2"];
    await reconcileLocalReminderSchedules([], test.adapter, test.store);
    expect(test.cancelled).toEqual(["orphan-1", "orphan-2"]);

    const cleanup = harness();
    cleanup.adapter.ownedIdentifiers = async () => ["owned"];
    await clearAllLocalReminderSchedules(cleanup.adapter, cleanup.store);
    expect(cleanup.cancelled).toEqual(["owned"]);
    expect(cleanup.state().reminders).toEqual({});
  });

  it("cancels and rebuilds after a device time-zone change even at the same server revision", async () => {
    const test = harness();
    let zone = "America/Chicago";
    test.adapter.schedulingContext = async () => ({ platform: "ios", deviceTimeZone: zone });
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    zone = "America/New_York";
    await reconcileLocalReminderSchedules([reminder], test.adapter, test.store);
    expect(test.cancelled).toEqual(["native-1", "native-2"]);
    expect(test.scheduled).toHaveLength(4);
  });
});
