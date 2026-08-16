import * as SecureStore from "expo-secure-store";

import {
  parseSessionEnvelope,
  type SecureSessionEnvelope,
  serializeSessionEnvelope,
} from "./session-envelope";

const SESSION_KEY = "nutrition_tracker_session_v1";
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadSecureSession(): Promise<SecureSessionEnvelope | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY, options);
  const session = parseSessionEnvelope(raw);
  if (!session && raw !== null) await SecureStore.deleteItemAsync(SESSION_KEY, options);
  return session;
}

export async function saveSecureSession(session: SecureSessionEnvelope): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, serializeSessionEnvelope(session), options);
}

export async function clearSecureSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY, options);
}
