import * as SecureStore from "expo-secure-store";

import type { HealthPlatform } from "./device-signing";

const KEY = "nutrition-tracker.health-device.v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface RegisteredHealthDeviceState {
  readonly version: 2;
  readonly id: string;
  readonly revision: string;
  readonly platform: HealthPlatform;
  /** Binds protected local state to the exact non-exportable key registered by the server. */
  readonly publicKeyDerBase64: string;
}

export function parseRegisteredHealthDeviceState(raw: string): RegisteredHealthDeviceState {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "id,platform,publicKeyDerBase64,revision,version"
  ) {
    throw new TypeError("The protected health-device state was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 2 ||
    typeof candidate.id !== "string" ||
    !UUID.test(candidate.id) ||
    typeof candidate.revision !== "string" ||
    !/^[1-9][0-9]*$/u.test(candidate.revision) ||
    typeof candidate.publicKeyDerBase64 !== "string" ||
    candidate.publicKeyDerBase64.length < 80 ||
    candidate.publicKeyDerBase64.length > 512 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      candidate.publicKeyDerBase64,
    ) ||
    (candidate.platform !== "apple_healthkit" && candidate.platform !== "android_health_connect")
  ) {
    throw new TypeError("The protected health-device state was invalid.");
  }
  return candidate as unknown as RegisteredHealthDeviceState;
}

export async function loadRegisteredHealthDevice(): Promise<RegisteredHealthDeviceState | null> {
  const raw = await SecureStore.getItemAsync(KEY, options);
  return raw === null ? null : parseRegisteredHealthDeviceState(raw);
}

export async function saveRegisteredHealthDevice(
  value: RegisteredHealthDeviceState,
): Promise<void> {
  const parsed = parseRegisteredHealthDeviceState(JSON.stringify(value));
  await SecureStore.setItemAsync(KEY, JSON.stringify(parsed), options);
}

export async function clearRegisteredHealthDevice(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, options);
}
