import type { Reminder } from "@nutrition-tracker/contracts";

import type { NotificationAdapter } from "./notifications";
import { type ReminderScheduleStore, reconcileLocalReminderSchedules } from "./reminder-schedule";

export class ReminderReconciliationUnauthorizedError extends Error {
  constructor() {
    super("The reminder session is no longer authorized.");
    this.name = "ReminderReconciliationUnauthorizedError";
  }
}

interface ForegroundReminderReconcilerDependencies {
  readonly loadReminders: (signal: AbortSignal) => Promise<readonly Reminder[]>;
  readonly adapter: NotificationAdapter;
  readonly store: ReminderScheduleStore;
  readonly onUnauthorized: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface ForegroundReminderReconciler {
  /** Coalesces foreground events and suppresses responses superseded by a newer request. */
  request(): Promise<void>;
  dispose(): void;
}

/**
 * Owns app-level reminder convergence. The Health screen is not required to be mounted: every
 * authenticated bootstrap/foreground pass reloads the server source of truth and updates the OS.
 */
export function createForegroundReminderReconciler(
  dependencies: ForegroundReminderReconcilerDependencies,
): ForegroundReminderReconciler {
  let requestedGeneration = 0;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let disposed = false;

  async function drain() {
    while (!disposed) {
      const generation = requestedGeneration;
      controller = new AbortController();
      try {
        const reminders = await dependencies.loadReminders(controller.signal);
        if (disposed || generation !== requestedGeneration) continue;
        await reconcileLocalReminderSchedules(reminders, dependencies.adapter, dependencies.store);
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === "AbortError")) continue;
        if (error instanceof ReminderReconciliationUnauthorizedError) {
          await dependencies.onUnauthorized();
          disposed = true;
          return;
        }
        dependencies.onError?.(error);
      } finally {
        controller = null;
      }
      if (generation === requestedGeneration) return;
    }
  }

  return {
    request() {
      if (disposed) return Promise.resolve();
      requestedGeneration += 1;
      controller?.abort();
      if (!running) {
        running = drain().finally(() => {
          running = null;
        });
      }
      return running;
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
