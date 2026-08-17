const CLEANUP_KEY = "nutrition-tracker.private-cleanup.v1";

export type PrivateCleanupReason = "terminal_unauthorized" | "sign_out" | "account_erasure";
export type PrivateCleanupStep =
  | "local_reminders"
  | "health_cursors"
  | "device_state"
  | "signing_key"
  | "session_credential";

const allSteps: readonly PrivateCleanupStep[] = [
  "local_reminders",
  "health_cursors",
  "device_state",
  "signing_key",
  "session_credential",
];

export interface PendingPrivateCleanup {
  readonly version: 1;
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

function parsePendingCleanup(value: string): PendingPrivateCleanup {
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
    candidate.version !== 1 ||
    !["terminal_unauthorized", "sign_out", "account_erasure"].includes(String(candidate.reason)) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !Array.isArray(pending) ||
    pending.length > allSteps.length ||
    new Set(pending).size !== pending.length ||
    pending.some((step) => !allSteps.includes(step as PrivateCleanupStep))
  ) {
    throw new TypeError("The pending private-cleanup state was invalid.");
  }
  return candidate as unknown as PendingPrivateCleanup;
}

export function createSecurePrivateCleanupStore(): PrivateCleanupStore {
  return {
    async load() {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      const raw = await SecureStore.getItemAsync(CLEANUP_KEY, options);
      return raw === null ? null : parsePendingCleanup(raw);
    },
    async save(value) {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      const parsed = parsePendingCleanup(JSON.stringify(value));
      await SecureStore.setItemAsync(CLEANUP_KEY, JSON.stringify(parsed), options);
    },
    async clear() {
      const SecureStore = await import("expo-secure-store");
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      await SecureStore.deleteItemAsync(CLEANUP_KEY, options);
    },
  };
}

function actionFor(
  step: PrivateCleanupStep,
  dependencies: PrivateCleanupDependencies,
): () => Promise<void> {
  switch (step) {
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
      pending = pending.filter((candidate) => candidate !== step);
      const next = { ...marker, pendingSteps: pending };
      if (pending.length === 0) await store.clear();
      else await store.save(next);
    } catch {
      // Continue through independent local deletion steps. The marker retains every failed step.
      try {
        await store.save({ ...marker, pendingSteps: pending });
      } catch {
        statePersistenceFailed = true;
      }
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
    version: 1,
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
