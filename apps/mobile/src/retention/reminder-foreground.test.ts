import type { Reminder } from "@nutrition-tracker/contracts";
import { describe, expect, it, vi } from "vitest";

import type { NotificationAdapter } from "./notifications";
import {
  createForegroundReminderReconciler,
  ReminderReconciliationUnauthorizedError,
} from "./reminder-foreground";
import type { ReminderScheduleState, ReminderScheduleStore } from "./reminder-schedule";

const active: Reminder = {
  id: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
  revision: "3",
  status: "active",
  label: "Private label not sent to the OS",
  localTime: "20:15",
  daysOfWeek: [1],
  timeZone: "America/Chicago",
  channel: "local",
  consent: {
    policyVersion: "local-reminders-v1",
    grantedAt: "2026-08-16T08:00:00.000Z",
    revokedAt: null,
  },
  deliveryPolicy: {
    title: "Nutrition Tracker",
    lockScreenText: "Time to check in.",
    includesHealthDetails: false,
  },
  createdAt: "2026-08-16T08:00:00.000Z",
  updatedAt: "2026-08-16T08:00:00.000Z",
};

function harness() {
  let server: readonly Reminder[] = [active];
  let state: ReminderScheduleState = { version: 1, reminders: {} };
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const adapter: NotificationAdapter = {
    currentPermission: async () => "granted",
    requestPermissionInContext: async () => "granted",
    schedulingContext: async () => ({ platform: "ios", deviceTimeZone: "America/Chicago" }),
    ownedIdentifiers: async () => scheduled.filter((id) => !cancelled.includes(id)),
    schedule: async () => {
      const id = `native-${scheduled.length + 1}`;
      scheduled.push(id);
      return id;
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
  };
  const store: ReminderScheduleStore = {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
  const reconciler = createForegroundReminderReconciler({
    loadReminders: async () => server,
    adapter,
    store,
    onUnauthorized: vi.fn(),
  });
  return {
    reconciler,
    scheduled,
    cancelled,
    state: () => state,
    setServer(next: readonly Reminder[]) {
      server = next;
    },
  };
}

describe("authenticated foreground reminder convergence", () => {
  it("applies a web pause/revoke or edit on the next foreground pass", async () => {
    const test = harness();
    await test.reconciler.request();
    expect(test.scheduled).toEqual(["native-1"]);

    test.setServer([{ ...active, revision: "4", status: "paused" }]);
    await test.reconciler.request();
    expect(test.cancelled).toEqual(["native-1"]);
    expect(test.state().reminders).toEqual({});

    test.setServer([{ ...active, revision: "5", localTime: "07:30" }]);
    await test.reconciler.request();
    expect(test.scheduled).toEqual(["native-1", "native-2"]);
    expect(test.state().reminders[active.id]?.revision).toBe("5");
  });

  it("suppresses a stale bootstrap response when foreground requests newer state", async () => {
    let releaseFirst: ((value: readonly Reminder[]) => void) | undefined;
    let calls = 0;
    const onUnauthorized = vi.fn();
    const reconciler = createForegroundReminderReconciler({
      loadReminders: async () => {
        calls += 1;
        if (calls === 1)
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        return [{ ...active, revision: "4", status: "paused" }];
      },
      adapter: {
        currentPermission: async () => "granted",
        requestPermissionInContext: async () => "granted",
        schedulingContext: async () => ({ platform: "ios", deviceTimeZone: "America/Chicago" }),
        ownedIdentifiers: async () => [],
        schedule: vi.fn(async () => "unexpected"),
        cancel: vi.fn(async () => undefined),
      },
      store: { load: async () => ({ version: 1, reminders: {} }), save: vi.fn() },
      onUnauthorized,
    });
    const first = reconciler.request();
    const second = reconciler.request();
    releaseFirst?.([active]);
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("hands terminal authorization loss to centralized private cleanup", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const reconciler = createForegroundReminderReconciler({
      loadReminders: async () => {
        throw new ReminderReconciliationUnauthorizedError();
      },
      adapter: {} as NotificationAdapter,
      store: {} as ReminderScheduleStore,
      onUnauthorized,
    });
    await reconciler.request();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
