const LEGACY_CLEANUP_KEY = "nutrition-tracker.private-cleanup.v1";
const CLEANUP_KEY = "nutrition-tracker.private-cleanup.v2";

export type PrivateCleanupReason = "terminal_unauthorized" | "sign_out" | "account_erasure";
export type PrivateCleanupStep =
  | "quick_add_outbox"
  | "local_reminders"
  | "health_cursors"
  | "device_state"
  | "signing_key"
  | "session_credential";

const allSteps: readonly PrivateCleanupStep[] = [
  "quick_add_outbox",
  "local_reminders",
  "health_cursors",
  "device_state",
  "signing_key",
  "session_credential",
];

export interface PendingPrivateCleanup {
  readonly version: 2;
  readonly reason: PrivateCleanupReason;
  readonly createdAt: string;
  readonly pendingSteps: readonly PrivateCleanupStep[];
}

export interface PrivateCleanupStore {
  load(): Promise<PendingPrivateCleanup | null>;
  save(value: PendingPrivateCleanup): Promise<void>;
  clear(): Promise<void>;
}

export interface PrivateCleanupDependencies {
  /** Must synchronously close every authenticated/private surface before I/O starts. */
  closePrivateUi(): void;
  /** Best effort while the current credential is still available; never blocks local deletion. */
  cleanupServerState?(): Promise<void>;
  clearQuickAddOutbox(): Promise<void>;
  clearLocalReminders(): Promise<void>;
  clearHealthCursors(): Promise<void>;
  clearDeviceState(): Promise<void>;
  deleteSigningKey(): Promise<void>;
  clearSessionCredential(): Promise<void>;
  now(): Date;
}

export interface PrivateCleanupResult {
  readonly complete: boolean;
  readonly remoteCleanupIncomplete: boolean;
  readonly pendingSteps: readonly PrivateCleanupStep[];
  readonly statePersistenceFailed: boolean;
}

const legacySteps = allSteps.filter((step) => step !== "quick_add_outbox");

export function parsePendingPrivateCleanup(value: string): PendingPrivateCleanup {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "createdAt,pendingSteps,reason,version"
  ) {
    throw new TypeError("The pending private-cleanup state was invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  const pending = candidate.pendingSteps;
  if (
    (candidate.version !== 1 && candidate.version !== 2) ||
    !["terminal_unauthorized", "sign_out", "account_erasure"].includes(String(candidate.reason)) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !Array.isArray(pending) ||
    new Set(pending).size !== pending.length ||
    pending.some(
      (step) =>
        !(candidate.version === 1 ? legacySteps : allSteps).includes(step as PrivateCleanupStep),
    ) ||
    pending.length > (candidate.version === 1 ? legacySteps.length : allSteps.length)
  ) {
    throw new TypeError("The pending private-cleanup state was invalid.");
  }
  return {
    version: 2,
    reason: candidate.reason as PrivateCleanupReason,
    createdAt: candidate.createdAt,
    pendingSteps:
      candidate.version === 1
        ? ["quick_add_outbox", ...(pending as PrivateCleanupStep[])]
        : (pending as PrivateCleanupStep[]),
  };
}

export function createSecurePrivateCleanupStore(): PrivateCleanupStore {
  return {
    async load() {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      const current = await SecureStore.getItemAsync(CLEANUP_KEY, options);
      if (current !== null) return parsePendingPrivateCleanup(current);
      const legacy = await SecureStore.getItemAsync(LEGACY_CLEANUP_KEY, options);
      if (legacy === null) return null;
      const migrated = parsePendingPrivateCleanup(legacy);
      await SecureStore.setItemAsync(CLEANUP_KEY, JSON.stringify(migrated), options);
      await SecureStore.deleteItemAsync(LEGACY_CLEANUP_KEY, options);
      return migrated;
    },
    async save(value) {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      const parsed = parsePendingPrivateCleanup(JSON.stringify(value));
      await SecureStore.setItemAsync(CLEANUP_KEY, JSON.stringify(parsed), options);
      await SecureStore.deleteItemAsync(LEGACY_CLEANUP_KEY, options);
    },
    async clear() {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      const results = await Promise.allSettled([
        SecureStore.deleteItemAsync(CLEANUP_KEY, options),
        SecureStore.deleteItemAsync(LEGACY_CLEANUP_KEY, options),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("The private-cleanup marker could not be fully removed.");
      }
    },
  };
}

function actionFor(
  step: PrivateCleanupStep,
  dependencies: PrivateCleanupDependencies,
): () => Promise<void> {
  switch (step) {
    case "quick_add_outbox":
      return dependencies.clearQuickAddOutbox;
    case "local_reminders":
      return dependencies.clearLocalReminders;
    case "health_cursors":
      return dependencies.clearHealthCursors;
    case "device_state":
      return dependencies.clearDeviceState;
    case "signing_key":
      return dependencies.deleteSigningKey;
    case "session_credential":
      return dependencies.clearSessionCredential;
  }
}

async function executePendingCleanup(
  marker: PendingPrivateCleanup,
  dependencies: PrivateCleanupDependencies,
  store: PrivateCleanupStore,
  attemptRemote: boolean,
  initialStatePersistenceFailed = false,
): Promise<PrivateCleanupResult> {
  let remoteCleanupIncomplete = false;
  if (attemptRemote && dependencies.cleanupServerState) {
    try {
      await dependencies.cleanupServerState();
    } catch {
      remoteCleanupIncomplete = true;
    }
  }
  let pending = [...marker.pendingSteps];
  let statePersistenceFailed = initialStatePersistenceFailed;
  for (const step of marker.pendingSteps) {
    try {
      await actionFor(step, dependencies)();
    } catch {
      // Continue through independent local deletion steps. The marker retains every failed step.
      try {
        await store.save({ ...marker, pendingSteps: pending });
      } catch {
        statePersistenceFailed = true;
      }
      continue;
    }
    const remaining = pending.filter((candidate) => candidate !== step);
    try {
      if (remaining.length === 0) await store.clear();
      else await store.save({ ...marker, pendingSteps: remaining });
      pending = remaining;
    } catch {
      // Repeat the idempotent deletion when marker progress could not be made durable.
      statePersistenceFailed = true;
    }
  }
  return {
    complete: pending.length === 0 && !statePersistenceFailed,
    remoteCleanupIncomplete,
    pendingSteps: pending,
    statePersistenceFailed,
  };
}

export async function beginPrivateDeviceCleanup(
  reason: PrivateCleanupReason,
  dependencies: PrivateCleanupDependencies,
  store: PrivateCleanupStore,
): Promise<PrivateCleanupResult> {
  dependencies.closePrivateUi();
  const marker: PendingPrivateCleanup = {
    version: 2,
    reason,
    createdAt: dependencies.now().toISOString(),
    pendingSteps: allSteps,
  };
  let statePersistenceFailed = false;
  try {
    await store.save(marker);
  } catch {
    statePersistenceFailed = true;
  }
  return executePendingCleanup(marker, dependencies, store, true, statePersistenceFailed);
}

export async function resumePrivateDeviceCleanup(
  dependencies: PrivateCleanupDependencies,
  store: PrivateCleanupStore,
): Promise<PrivateCleanupResult | null> {
  let marker: PendingPrivateCleanup | null;
  try {
    marker = await store.load();
  } catch {
    dependencies.closePrivateUi();
    return {
      complete: false,
      remoteCleanupIncomplete: false,
      pendingSteps: allSteps,
      statePersistenceFailed: true,
    };
  }
  if (marker === null) return null;
  dependencies.closePrivateUi();
  return executePendingCleanup(marker, dependencies, store, false);
}
