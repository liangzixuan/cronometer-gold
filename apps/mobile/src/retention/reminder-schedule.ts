import {
  type LocalReminderSchedule,
  type NotificationAdapter,
  notificationRequestsFor,
} from "./notifications";

const STORE_KEY = "nutrition-tracker.local-reminder-schedules.v1";
export const MAX_SCHEDULED_LOCAL_NOTIFICATIONS = 64;
export interface ReminderScheduleState {
  readonly version: 1;
  readonly reminders: Readonly<
    Record<
      string,
      {
        readonly revision: string;
        readonly identifiers: readonly string[];
        readonly platform: "ios" | "android";
        readonly deviceTimeZone: string;
        readonly reminderTimeZone: string;
      }
    >
  >;
}

export interface ReminderScheduleStore {
  load(): Promise<ReminderScheduleState>;
  save(value: ReminderScheduleState): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReminderScheduleState(raw: string): ReminderScheduleState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("Local reminder state was not valid JSON.");
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "reminders,version" ||
    value.version !== 1 ||
    !record(value.reminders) ||
    Object.keys(value.reminders).length > 100
  ) {
    throw new TypeError("Local reminder state was invalid.");
  }
  const reminders: Record<
    string,
    {
      readonly revision: string;
      readonly identifiers: readonly string[];
      readonly platform: "ios" | "android";
      readonly deviceTimeZone: string;
      readonly reminderTimeZone: string;
    }
  > = {};
  for (const [id, candidate] of Object.entries(value.reminders)) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id) ||
      !record(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "deviceTimeZone,identifiers,platform,reminderTimeZone,revision" ||
      typeof candidate.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(candidate.revision) ||
      !Array.isArray(candidate.identifiers) ||
      candidate.identifiers.length > 7 ||
      new Set(candidate.identifiers).size !== candidate.identifiers.length ||
      candidate.identifiers.some(
        (identifier) =>
          typeof identifier !== "string" || identifier.length < 1 || identifier.length > 200,
      ) ||
      (candidate.platform !== "ios" && candidate.platform !== "android") ||
      typeof candidate.deviceTimeZone !== "string" ||
      candidate.deviceTimeZone.length < 1 ||
      candidate.deviceTimeZone.length > 63 ||
      typeof candidate.reminderTimeZone !== "string" ||
      candidate.reminderTimeZone.length < 1 ||
      candidate.reminderTimeZone.length > 63
    ) {
      throw new TypeError("A local reminder schedule was invalid.");
    }
    reminders[id] = {
      revision: candidate.revision,
      identifiers: candidate.identifiers,
      platform: candidate.platform,
      deviceTimeZone: candidate.deviceTimeZone,
      reminderTimeZone: candidate.reminderTimeZone,
    };
  }
  return { version: 1, reminders };
}

export function createSecureReminderScheduleStore(): ReminderScheduleStore {
  return {
    async load() {
      const SecureStore = await import("expo-secure-store");
      const options = {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };
      const raw = await SecureStore.getItemAsync(STORE_KEY, options);
      return raw === null ? { version: 1, reminders: {} } : parseReminderScheduleState(raw);
    },
    async save(value) {
      const SecureStore = await import("expo-secure-store");
      const options = {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };
      const parsed = parseReminderScheduleState(JSON.stringify(value));
      await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(parsed), options);
    },
  };
}

async function cancelAll(adapter: NotificationAdapter, identifiers: readonly string[]) {
  for (const identifier of [...new Set(identifiers)]) await adapter.cancel(identifier);
}

export async function clearAllLocalReminderSchedules(
  adapter: NotificationAdapter,
  store: ReminderScheduleStore,
): Promise<void> {
  let state: ReminderScheduleState = { version: 1, reminders: {} };
  try {
    state = await store.load();
  } catch {
    // Enumeration below is the recovery source of truth when the protected ledger is corrupt.
  }
  const ledgerIdentifiers = Object.values(state.reminders).flatMap((entry) => entry.identifiers);
  const ownedIdentifiers = await adapter.ownedIdentifiers();
  await cancelAll(adapter, [...ledgerIdentifiers, ...ownedIdentifiers]);
  await store.save({ version: 1, reminders: {} });
}

export async function reconcileLocalReminderSchedules(
  serverReminders: readonly LocalReminderSchedule[],
  adapter: NotificationAdapter,
  store: ReminderScheduleStore,
): Promise<{
  readonly permission: "granted" | "denied" | "unavailable";
  readonly scheduled: number;
}> {
  if (
    serverReminders.length > 100 ||
    new Set(serverReminders.map((item) => item.id)).size !== serverReminders.length
  ) {
    throw new TypeError("The server reminder set was invalid.");
  }
  const requestsByReminder = new Map(
    serverReminders.map((reminder) => [reminder.id, notificationRequestsFor(reminder)] as const),
  );
  const requestedNotificationCount = [...requestsByReminder.values()].reduce(
    (count, requests) => count + requests.length,
    0,
  );
  if (requestedNotificationCount > MAX_SCHEDULED_LOCAL_NOTIFICATIONS) {
    throw new TypeError("The server reminder set exceeds the local notification limit.");
  }
  let state: ReminderScheduleState;
  let ledgerRecovered = false;
  try {
    state = await store.load();
  } catch {
    state = { version: 1, reminders: {} };
    ledgerRecovered = true;
  }
  const permission = await adapter.currentPermission();
  const context = await adapter.schedulingContext();
  const byId = new Map(serverReminders.map((reminder) => [reminder.id, reminder]));
  const ownedIdentifiers = await adapter.ownedIdentifiers();
  const ownedIdentifierSet = new Set(ownedIdentifiers);
  const ledgerIdentifiers = new Set(
    Object.values(state.reminders).flatMap((entry) => entry.identifiers),
  );
  // A process death can occur after the OS accepted a schedule but before the protected ledger
  // commit. Reconcile unknown app-owned identifiers on every foreground pass, even when other
  // reminder rows make the ledger nonempty.
  await cancelAll(
    adapter,
    ownedIdentifiers.filter((identifier) => !ledgerIdentifiers.has(identifier)),
  );

  if (ledgerRecovered || Object.keys(state.reminders).length === 0 || permission !== "granted") {
    await cancelAll(adapter, [
      ...Object.values(state.reminders).flatMap((entry) => entry.identifiers),
      ...ownedIdentifiers.filter((identifier) => ledgerIdentifiers.has(identifier)),
    ]);
    await store.save({ version: 1, reminders: {} });
    state = { version: 1, reminders: {} };
  }

  for (const [id, local] of Object.entries(state.reminders)) {
    const server = byId.get(id);
    const missingNativeSchedule = local.identifiers.some(
      (identifier) => !ownedIdentifierSet.has(identifier),
    );
    if (
      missingNativeSchedule ||
      permission !== "granted" ||
      !server ||
      server.status !== "active" ||
      server.revision !== local.revision ||
      local.platform !== context.platform ||
      local.deviceTimeZone !== context.deviceTimeZone ||
      local.reminderTimeZone !== server.timeZone
    ) {
      await cancelAll(
        adapter,
        missingNativeSchedule
          ? local.identifiers.filter((identifier) => ownedIdentifierSet.has(identifier))
          : local.identifiers,
      );
      const next = { ...state.reminders };
      delete next[id];
      state = { version: 1, reminders: next };
      await store.save(state);
    }
  }

  if (permission !== "granted") return { permission, scheduled: 0 };

  for (const reminder of serverReminders) {
    if (reminder.status !== "active" || state.reminders[reminder.id]) continue;
    const created: string[] = [];
    try {
      for (const request of requestsByReminder.get(reminder.id) ?? []) {
        created.push(await adapter.schedule(request));
      }
    } catch (error) {
      await cancelAll(adapter, created);
      throw error;
    }
    const nextState: ReminderScheduleState = {
      version: 1,
      reminders: {
        ...state.reminders,
        [reminder.id]: {
          revision: reminder.revision,
          identifiers: created,
          platform: context.platform,
          deviceTimeZone: context.deviceTimeZone,
          reminderTimeZone: reminder.timeZone,
        },
      },
    };
    try {
      await store.save(nextState);
    } catch (error) {
      await cancelAll(adapter, created);
      throw error;
    }
    state = nextState;
  }
  return {
    permission,
    scheduled: Object.values(state.reminders).reduce(
      (count, reminder) => count + reminder.identifiers.length,
      0,
    ),
  };
}
