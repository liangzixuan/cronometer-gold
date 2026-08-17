export const GENERIC_REMINDER_TITLE = "Nutrition Tracker" as const;
export const GENERIC_REMINDER_BODY = "Time to check in." as const;
const CHANNEL_ID = "private-reminders";
const OWNER_MARKER = "nutrition-tracker-local-reminder-v1";

export interface LocalReminderSchedule {
  readonly id: string;
  readonly revision: string;
  readonly status: "active" | "paused" | "revoked";
  readonly localTime: string;
  /** Contract order: Monday=1 through Sunday=7. */
  readonly daysOfWeek: readonly number[];
  readonly timeZone: string;
}

export interface LocalNotificationRequest {
  readonly content: {
    readonly title: typeof GENERIC_REMINDER_TITLE;
    readonly body: typeof GENERIC_REMINDER_BODY;
    readonly data: { readonly owner: typeof OWNER_MARKER };
  };
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
}

export interface NotificationAdapter {
  currentPermission(): Promise<"granted" | "denied" | "unavailable">;
  requestPermissionInContext(): Promise<"granted" | "denied" | "unavailable">;
  schedulingContext(): Promise<{
    readonly platform: "ios" | "android";
    readonly deviceTimeZone: string;
  }>;
  ownedIdentifiers(): Promise<readonly string[]>;
  schedule(request: LocalNotificationRequest): Promise<string>;
  cancel(identifier: string): Promise<void>;
}

function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function notificationRequestsFor(
  reminder: LocalReminderSchedule,
): readonly LocalNotificationRequest[] {
  const match = /^(?:([01][0-9])|(2[0-3])):([0-5][0-9])$/u.exec(reminder.localTime);
  if (
    reminder.status !== "active" ||
    !match ||
    !validTimeZone(reminder.timeZone) ||
    reminder.daysOfWeek.length < 1 ||
    reminder.daysOfWeek.length > 7 ||
    new Set(reminder.daysOfWeek).size !== reminder.daysOfWeek.length ||
    reminder.daysOfWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) {
    if (reminder.status !== "active") return [];
    throw new TypeError("The local reminder schedule was invalid.");
  }
  const hour = Number(match[1] ?? match[2]);
  const minute = Number(match[3]);
  return [...reminder.daysOfWeek]
    .sort((left, right) => left - right)
    .map((dayOfWeek) => ({
      content: {
        title: GENERIC_REMINDER_TITLE,
        body: GENERIC_REMINDER_BODY,
        data: { owner: OWNER_MARKER },
      },
      dayOfWeek,
      hour,
      minute,
      timeZone: reminder.timeZone,
    }));
}

function permissionGranted(status: {
  readonly granted?: boolean;
  readonly ios?: { readonly status?: number };
}): boolean {
  // Expo's provisional iOS authorization value is 3.
  return status.granted === true || status.ios?.status === 3;
}

export function createExpoNotificationAdapter(): NotificationAdapter {
  return {
    async currentPermission() {
      try {
        const notifications = await import("expo-notifications");
        return permissionGranted(await notifications.getPermissionsAsync()) ? "granted" : "denied";
      } catch {
        return "unavailable";
      }
    },
    async requestPermissionInContext() {
      try {
        const notifications = await import("expo-notifications");
        const status = await notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: false, allowSound: true },
        });
        return permissionGranted(status) ? "granted" : "denied";
      } catch {
        return "unavailable";
      }
    },
    async schedulingContext() {
      const { Platform } = await import("react-native");
      if (Platform.OS !== "ios" && Platform.OS !== "android") {
        throw new Error("Local reminders require a signed iOS or Android build.");
      }
      const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!validTimeZone(deviceTimeZone)) throw new Error("The device time zone was unavailable.");
      return { platform: Platform.OS, deviceTimeZone };
    },
    async ownedIdentifiers() {
      try {
        const notifications = await import("expo-notifications");
        const scheduled = await notifications.getAllScheduledNotificationsAsync();
        return scheduled
          .filter(
            (request) =>
              request.content.title === GENERIC_REMINDER_TITLE &&
              request.content.body === GENERIC_REMINDER_BODY &&
              request.content.data?.owner === OWNER_MARKER,
          )
          .map((request) => request.identifier);
      } catch {
        throw new Error("Existing local reminders could not be enumerated safely.");
      }
    },
    async schedule(request) {
      const notifications = await import("expo-notifications");
      const { Platform } = await import("react-native");
      if (Platform.OS === "android") {
        const currentTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (request.timeZone !== currentTimeZone) {
          throw new Error(
            "Android local reminders require the schedule time zone to match this device's current time zone.",
          );
        }
        await notifications.setNotificationChannelAsync(CHANNEL_ID, {
          name: "Private reminders",
          importance: notifications.AndroidImportance.DEFAULT,
          lockscreenVisibility: notifications.AndroidNotificationVisibility.PRIVATE,
        });
      }
      // Expo weekly weekdays use Sunday=1. The product contract uses Monday=1.
      const weekday = (request.dayOfWeek % 7) + 1;
      return notifications.scheduleNotificationAsync({
        content: request.content,
        trigger:
          Platform.OS === "ios"
            ? {
                type: notifications.SchedulableTriggerInputTypes.CALENDAR,
                repeats: true,
                weekday,
                hour: request.hour,
                minute: request.minute,
                timezone: request.timeZone,
              }
            : {
                type: notifications.SchedulableTriggerInputTypes.WEEKLY,
                channelId: CHANNEL_ID,
                weekday,
                hour: request.hour,
                minute: request.minute,
              },
      });
    },
    async cancel(identifier) {
      const notifications = await import("expo-notifications");
      await notifications.cancelScheduledNotificationAsync(identifier);
    },
  };
}
