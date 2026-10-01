import { getMobileProfile, type MobileProfile, mobileProfileKey } from "../config/mobile-profile";

export interface ProtectedProfileKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function scopeProtectedStore(
  profile: MobileProfile,
  storage: ProtectedProfileKeyValue,
): ProtectedProfileKeyValue {
  return {
    get: (key) => storage.get(mobileProfileKey(profile, key)),
    set: (key, value) => storage.set(mobileProfileKey(profile, key), value),
    delete: (key) => storage.delete(mobileProfileKey(profile, key)),
  };
}

export async function profileSecureStore(): Promise<ProtectedProfileKeyValue> {
  const profile = getMobileProfile();
  const SecureStore = await import("expo-secure-store");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return scopeProtectedStore(profile, {
    get: (key) => SecureStore.getItemAsync(key, options),
    set: (key, value) => SecureStore.setItemAsync(key, value, options),
    delete: (key) => SecureStore.deleteItemAsync(key, options),
  });
}
