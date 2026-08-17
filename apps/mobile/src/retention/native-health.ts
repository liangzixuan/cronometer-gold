import type { NativeHealthAdapter } from "./native-health.types";

/** Metro replaces this fail-closed implementation with the .ios/.android module. */
export function createNativeHealthAdapter(): NativeHealthAdapter {
  return {
    platform: "apple_healthkit",
    availability: async () => ({ status: "unavailable", reason: "native_module" }),
    requestWeightReadPermission: async () => ({
      status: "unavailable",
      readAuthorizationOpaque: false,
    }),
    readWeightChanges: async () => {
      throw new Error("Native health is available only in a signed iOS or Android build.");
    },
    openPermissionSettings: async () => undefined,
  };
}

export type {
  NativeHealthAdapter,
  NativeHealthAvailability,
  NativeHealthChanges,
  NativeHealthPermission,
  NativeWeightRecord,
} from "./native-health.types";
