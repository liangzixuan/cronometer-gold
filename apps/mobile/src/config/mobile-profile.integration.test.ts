import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileProfile } from "./mobile-profile";

const native = vi.hoisted(() => ({
  profile: undefined as MobileProfile | undefined,
  values: new Map<string, string>(),
  operations: [] as string[],
  fail: undefined as ((operation: string, key: string) => boolean) | undefined,
  keys: new Set<string>(),
  keyCalls: [] as string[],
  notifications: new Map<
    string,
    { identifier: string; content: { title: string; body: string; data: { owner: string } } }
  >(),
  cancelled: [] as string[],
  channels: [] as string[],
}));
vi.mock("./mobile-profile", async (original) => ({
  ...(await original<typeof import("./mobile-profile")>()),
  getMobileProfile: () => {
    if (!native.profile) throw new Error("profile not bound");
    return native.profile;
  },
}));
vi.mock("expo-secure-store", () => {
  function observe(operation: string, key: string) {
    native.operations.push(`${operation}:${key}`);
    if (!key.startsWith("nutrition-origin.")) throw new Error("unqualified protected access");
    if (native.fail?.(operation, key)) throw new Error("injected protected failure");
  }
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    getItemAsync: async (key: string) => {
      observe("get", key);
      return native.values.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string) => {
      observe("set", key);
      native.values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      observe("delete", key);
      native.values.delete(key);
    },
  };
});
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  randomUUID: () => crypto.randomUUID(),
  digestStringAsync: async (_algorithm: string, value: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { WEEKLY: "weekly", CALENDAR: "calendar" },
  getAllScheduledNotificationsAsync: async () => [...native.notifications.values()],
  setNotificationChannelAsync: async (id: string) => {
    native.channels.push(id);
  },
  scheduleNotificationAsync: async (request: {
    content: { title: string; body: string; data: { owner: string } };
  }) => {
    const identifier = crypto.randomUUID();
    native.notifications.set(identifier, { identifier, content: request.content });
    return identifier;
  },
  cancelScheduledNotificationAsync: async (id: string) => {
    native.cancelled.push(id);
    native.notifications.delete(id);
  },
}));
const spki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzWZoz2KCsWHpIfyxj4r3+dqeaEuDwjjcFm8KXBW1dNzF7votiwmi0B/fsUlJlWHpbL4MBu4lMabcT6AlW9GvMw==";
vi.mock("@sbaiahmed1/react-native-biometrics", () => ({
  InputEncoding: { UTF8: "utf8" },
  SignatureAlgorithm: { SHA256withECDSA: "ecdsa" },
  keyExists: async (alias: string) => {
    native.keyCalls.push(alias);
    return native.keys.has(alias);
  },
  createKeysWithOptions: async ({ keyAlias }: { keyAlias: string }) => {
    native.keyCalls.push(keyAlias);
    native.keys.add(keyAlias);
  },
  validateKeyIntegrity: async (alias: string) => {
    native.keyCalls.push(alias);
    return {
      keyExists: native.keys.has(alias),
      valid: true,
      integrityChecks: { hardwareBacked: true },
    };
  },
  getPublicKey: async (alias: string) => {
    native.keyCalls.push(alias);
    return { publicKey: spki };
  },
  deleteKeys: async (alias: string) => {
    native.keyCalls.push(alias);
    native.keys.delete(alias);
    return { success: true };
  },
  sign: async ({ keyAlias }: { keyAlias: string }) => {
    native.keyCalls.push(keyAlias);
    return {
      success: true,
      signature:
        "MEQCIE6kweXWD+Ftm+gUhuoawRTXa45ihYaZhr2/euC8AFsUAiBf7LqVIbPw5oQcopItyEpYgekjKiE6aWU7hf707TMgLA==",
    };
  },
}));

import { createMobileFetch } from "../api/mobile-fetch";
import { clearSecureSession, loadSecureSession, saveSecureSession } from "../auth/secure-session";
import { createQuickAddOutboxDraft } from "../diary/quick-add-outbox";
import {
  clearQuickAddOutbox,
  createSecureQuickAddOutboxStore,
  QUICK_ADD_OUTBOX_MANIFEST_KEY,
  quickAddOutboxSlotKey,
} from "../diary/quick-add-outbox-store";
import {
  beginPrivateDeviceCleanup,
  createSecurePrivateCleanupStore,
  resumePrivateDeviceCleanup,
} from "../retention/device-cleanup";
import { createHardwareDeviceSigner } from "../retention/device-signing";
import {
  clearRegisteredHealthDevice,
  loadRegisteredHealthDevice,
  saveRegisteredHealthDevice,
} from "../retention/device-state";
import { submitPendingErasure } from "../retention/erasure-recovery";
import { createErasureCapabilityStore } from "../retention/erasure-status";
import { clearHealthCursor, createSecureHealthSyncStore } from "../retention/health-cursor-store";
import { createExpoNotificationAdapter, notificationRequestsFor } from "../retention/notifications";
import {
  ACCOUNT_ERASURE_SERIALIZED_BODY,
  createPendingErasureStore,
  type PendingErasureEnvelope,
} from "../retention/pending-erasure";
import {
  clearAllLocalReminderSchedules,
  createSecureReminderScheduleStore,
} from "../retention/reminder-schedule";
import { mobileProfileKey, resolveMobileProfile } from "./mobile-profile";

const a = resolveMobileProfile({
  selector: "hosted-development",
  apiUrl: "https://dev-api.nourishing.app",
  platform: "ios",
});
const b = resolveMobileProfile({ apiUrl: "https://api.nourishing.app", platform: "ios" });
const c = resolveMobileProfile({ platform: "android" });
const id = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
const operation = "00000000-0000-4000-8000-000000000001";
const expiry = "2099-01-01T00:00:00.000Z";
const session = { accessToken: "a".repeat(43), expiresAt: expiry };
const pendingErasure: PendingErasureEnvelope = {
  version: 1 as const,
  operationId: operation,
  serializedBody: ACCOUNT_ERASURE_SERIALIZED_BODY,
  reauthenticationToken: "r".repeat(43),
  createdAt: "2026-10-01T00:00:00.000Z",
};
const capability = { version: 1 as const, jobId: id, token: "s".repeat(43), expiresAt: expiry };
const device = {
  version: 2 as const,
  id,
  revision: "1",
  platform: "apple_healthkit" as const,
  publicKeyDerBase64: spki,
};
const cleanup = {
  version: 2 as const,
  reason: "sign_out" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
  pendingSteps: ["session_credential"] as const,
};
const reminder = {
  id,
  revision: "1",
  status: "active" as const,
  localTime: "12:15",
  daysOfWeek: [1],
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
const legacyKeys = [
  "nutrition_tracker_session_v1",
  "nutrition-tracker.health-device.v2",
  "nutrition-tracker.pending-erasure-envelope.v1",
  "nutrition-tracker.erasure-status-capability.v1",
  "nutrition-tracker.private-cleanup.v1",
  "nutrition-tracker.private-cleanup.v2",
  "nutrition-tracker.local-reminder-schedules.v1",
  "nutrition-tracker.health-sync.v2.apple_healthkit",
  "nutrition-tracker.health-cursor.v1.apple_healthkit",
  QUICK_ADD_OUTBOX_MANIFEST_KEY,
  quickAddOutboxSlotKey(0),
];
function select(profile: MobileProfile) {
  native.profile = profile;
}
function preservedExcept(profile: MobileProfile) {
  return [...native.values].filter(([key]) => !key.startsWith(`${profile.namespace}.`)).sort();
}
function healthPending() {
  return {
    envelope: {
      body: {
        deviceId: id,
        batchId: id,
        cursorEpoch: "1",
        platform: "apple_healthkit" as const,
        sourceCursor: null,
        nextSourceCursor: "a".repeat(64),
        records: [{ operation: "delete" as const, externalId: "sample", externalRevision: "1" }],
      },
      headers: {
        "x-device-timestamp": "2026-10-01T00:00:00.000Z",
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
    },
    nextCursor: {
      version: 1 as const,
      providerCursor: "anchor",
      serverDigest: "a".repeat(64),
      knownRevisions: {},
    },
    fullReconciliation: true,
    deletionSemantics: "explicit_only" as const,
  };
}
async function populate(profile: MobileProfile) {
  select(profile);
  await saveSecureSession(session);
  await saveRegisteredHealthDevice(device);
  await createPendingErasureStore().save(pendingErasure);
  await createErasureCapabilityStore().save(capability);
  await createSecurePrivateCleanupStore().save(cleanup);
  await createSecureReminderScheduleStore().save({
    version: 1,
    reminders: {
      [id]: {
        revision: "1",
        identifiers: ["synthetic-id"],
        platform: "ios",
        deviceTimeZone: "UTC",
        reminderTimeZone: "UTC",
      },
    },
  });
  await createSecureQuickAddOutboxStore().append(
    id,
    createQuickAddOutboxDraft(
      id,
      "UTC",
      {
        foodKind: "generic",
        foodName: "Apple",
        foodVersionId: "1",
        servingId: "2",
        servingLabel: "one",
        localDate: "2026-10-01",
        mealSlot: "breakfast",
        occurredAt: "2026-10-01T08:00:00.000Z",
      },
      operation,
      new Date("2026-10-01T08:00:00.000Z"),
    ),
  );
  await createSecureHealthSyncStore("apple_healthkit").stage(null, healthPending());
}
beforeEach(() => {
  native.values.clear();
  native.operations.length = 0;
  native.fail = undefined;
  native.keys.clear();
  native.keyCalls.length = 0;
  native.notifications.clear();
  native.cancelled.length = 0;
  native.channels.length = 0;
  select(a);
  for (const key of legacyKeys) native.values.set(key, `legacy:${key}`);
  native.keys.add("nutrition-tracker-health-import-v1");
});

describe("complete mobile origin boundary", () => {
  it("isolates all eight actual store adapters and identical account IDs across origins and restart", async () => {
    await populate(a);
    const aBytes = [...native.values].filter(([key]) => key.startsWith(a.namespace));
    for (const profile of [b, c]) {
      select(profile);
      expect(await loadSecureSession()).toBeNull();
      expect(await loadRegisteredHealthDevice()).toBeNull();
      expect(await createPendingErasureStore().load()).toBeNull();
      expect(await createErasureCapabilityStore().load()).toBeNull();
      expect(await createSecurePrivateCleanupStore().load()).toBeNull();
      expect((await createSecureReminderScheduleStore().load()).reminders).toEqual({});
      expect((await createSecureQuickAddOutboxStore().snapshot(id)).items).toEqual([]);
      expect((await createSecureHealthSyncStore("apple_healthkit").load()).pending).toBeNull();
    }
    expect([...native.values].filter(([key]) => key.startsWith(a.namespace))).toEqual(aBytes);
    await populate(b);
    select(a);
    expect(await loadSecureSession()).toEqual(session);
    expect(await loadRegisteredHealthDevice()).toEqual(device);
    expect(await createPendingErasureStore().load()).toEqual(pendingErasure);
    expect(await createErasureCapabilityStore().load()).toEqual(capability);
    expect(await createSecurePrivateCleanupStore().load()).toEqual(cleanup);
    expect((await createSecureReminderScheduleStore().load()).reminders[id]?.revision).toBe("1");
    expect((await createSecureQuickAddOutboxStore().snapshot(id)).items[0]?.operationId).toBe(
      operation,
    );
    expect((await createSecureHealthSyncStore("apple_healthkit").load()).pending).toEqual(
      healthPending(),
    );
    for (const key of legacyKeys) expect(native.values.get(key)).toBe(`legacy:${key}`);
  });
  it("does not touch protected storage before profile validation", async () => {
    native.profile = undefined;
    await expect(loadSecureSession()).rejects.toThrow(/profile not bound/u);
    await expect(createPendingErasureStore().load()).rejects.toThrow();
    await expect(createSecureQuickAddOutboxStore().snapshot(id)).rejects.toThrow();
    expect(() => createHardwareDeviceSigner()).toThrow();
    expect(() => createExpoNotificationAdapter()).toThrow();
    expect(native.operations).toEqual([]);
    expect(native.keyCalls).toEqual([]);
  });
  it("contains corrupt outbox clearing and staged health recovery within one origin", async () => {
    await populate(a);
    await populate(b);
    select(a);
    const foreign = preservedExcept(a);
    native.values.set(mobileProfileKey(a, QUICK_ADD_OUTBOX_MANIFEST_KEY), "corrupt");
    await clearQuickAddOutbox();
    await clearHealthCursor("apple_healthkit");
    expect((await createSecureQuickAddOutboxStore().snapshot(id)).items).toEqual([]);
    expect((await createSecureHealthSyncStore("apple_healthkit").load()).pending).toBeNull();
    expect(preservedExcept(a)).toEqual(foreign);
  });
  it("resumes a failed cleanup journal using only its origin's actual deletion callbacks", async () => {
    await populate(a);
    await populate(b);
    select(a);
    const foreign = preservedExcept(a);
    const dependencies = {
      closePrivateUi: vi.fn(),
      clearQuickAddOutbox,
      clearLocalReminders: () =>
        clearAllLocalReminderSchedules(
          createExpoNotificationAdapter(),
          createSecureReminderScheduleStore(),
        ),
      clearHealthCursors: () => clearHealthCursor("apple_healthkit"),
      clearDeviceState: clearRegisteredHealthDevice,
      deleteSigningKey: () => createHardwareDeviceSigner().resetHardwareKey(),
      clearSessionCredential: clearSecureSession,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    };
    const store = createSecurePrivateCleanupStore();
    native.fail = (op, key) =>
      op === "delete" && key === mobileProfileKey(a, "nutrition_tracker_session_v1");
    expect(await beginPrivateDeviceCleanup("sign_out", dependencies, store)).toMatchObject({
      complete: false,
      pendingSteps: ["session_credential"],
    });
    expect((await store.load())?.pendingSteps).toEqual(["session_credential"]);
    native.fail = undefined;
    expect(await resumePrivateDeviceCleanup(dependencies, store)).toMatchObject({ complete: true });
    expect(await store.load()).toBeNull();
    expect(preservedExcept(a)).toEqual(foreign);
  });
  it("scopes malformed-session and expired-capability deletion and preserves read failures", async () => {
    await populate(a);
    await populate(b);
    select(a);
    const foreign = preservedExcept(a);
    native.values.set(mobileProfileKey(a, "nutrition_tracker_session_v1"), "bad");
    expect(await loadSecureSession()).toBeNull();
    const expiryStore = createErasureCapabilityStore(
      undefined,
      () => new Date("2100-01-01T00:00:00.000Z"),
    );
    expect(await expiryStore.load()).toBeNull();
    native.fail = (op) => op === "get";
    await expect(loadRegisteredHealthDevice()).rejects.toThrow(/injected protected failure/u);
    expect(preservedExcept(a)).toEqual(foreign);
  });
  it("refuses old-origin session and erasure capabilities before sending them to a different API", async () => {
    const transport = vi.fn();
    await expect(
      submitPendingErasure(
        {
          apiBase: new URL(b.apiOrigin),
          accessToken: session.accessToken,
          pending: pendingErasure,
        },
        createMobileFetch(a, transport),
      ),
    ).rejects.toThrow(/not received/u);
    await expect(
      createMobileFetch(a, transport)(`${b.apiOrigin}/v1/account/erasure/${id}`, {
        headers: { "x-erasure-status-token": capability.token },
      }),
    ).rejects.toThrow(/bound API origin/u);
    expect(transport).not.toHaveBeenCalled();
  });
  it("retains explicit cleanup persistence failures without altering another origin", async () => {
    await populate(a);
    await populate(b);
    select(a);
    const foreign = preservedExcept(a);
    const store = createSecurePrivateCleanupStore();
    const dependencies = {
      closePrivateUi: vi.fn(),
      clearQuickAddOutbox: async () => {},
      clearLocalReminders: async () => {},
      clearHealthCursors: async () => {},
      clearDeviceState: async () => {},
      deleteSigningKey: async () => {},
      clearSessionCredential: clearSecureSession,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    };
    native.fail = (op, key) =>
      op === "set" && key === mobileProfileKey(a, "nutrition-tracker.private-cleanup.v2");
    expect(await beginPrivateDeviceCleanup("sign_out", dependencies, store)).toMatchObject({
      complete: false,
      statePersistenceFailed: true,
    });
    native.fail = (op, key) =>
      op === "delete" && key === mobileProfileKey(a, "nutrition-tracker.private-cleanup.v2");
    expect(await beginPrivateDeviceCleanup("sign_out", dependencies, store)).toMatchObject({
      complete: false,
      statePersistenceFailed: true,
    });
    native.fail = undefined;
    expect(await resumePrivateDeviceCleanup(dependencies, store)).toMatchObject({ complete: true });
    expect(preservedExcept(a)).toEqual(foreign);
  });
  it("captures one native key alias for ensure/sign/reset without touching another origin or legacy key", async () => {
    select(a);
    const signerA = createHardwareDeviceSigner();
    await signerA.ensureHardwareKey();
    select(b);
    const signerB = createHardwareDeviceSigner();
    await signerB.ensureHardwareKey();
    await signerA.signUtf8("synthetic");
    await signerA.resetHardwareKey();
    expect(native.keys.has(mobileProfileKey(a, "nutrition-tracker-health-import-v1"))).toBe(false);
    expect(native.keys.has(mobileProfileKey(b, "nutrition-tracker-health-import-v1"))).toBe(true);
    expect(native.keys.has("nutrition-tracker-health-import-v1")).toBe(true);
    expect(native.keyCalls).not.toContain("nutrition-tracker-health-import-v1");
  });
  it("isolates OS reminder ownership and rejects a foreign ID planted in the selected ledger", async () => {
    const request = notificationRequestsFor(reminder)[0];
    if (!request) throw new Error("fixture request missing");
    select(a);
    const adapterA = createExpoNotificationAdapter();
    const idA = await adapterA.schedule(request);
    select(b);
    const adapterB = createExpoNotificationAdapter();
    const idB = await adapterB.schedule(request);
    expect(await adapterA.ownedIdentifiers()).toEqual([idA]);
    expect(await adapterB.ownedIdentifiers()).toEqual([idB]);
    expect(new Set(native.channels).size).toBe(2);
    select(a);
    const store = createSecureReminderScheduleStore();
    await store.save({
      version: 1,
      reminders: {
        [id]: {
          revision: "1",
          identifiers: [idB],
          platform: "ios",
          deviceTimeZone: "UTC",
          reminderTimeZone: "UTC",
        },
      },
    });
    await expect(clearAllLocalReminderSchedules(adapterA, store)).rejects.toThrow(
      /another mobile profile/u,
    );
    expect(native.cancelled).not.toContain(idB);
    expect(native.notifications.has(idB)).toBe(true);
    await adapterA.cancel(idA);
    expect(native.notifications.has(idB)).toBe(true);
  });
});
