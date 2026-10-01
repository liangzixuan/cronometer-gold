import { profileSecureStore } from "../storage/profile-secure-store";

import {
  parseSessionEnvelope,
  type SecureSessionEnvelope,
  serializeSessionEnvelope,
} from "./session-envelope";

const SESSION_KEY = "nutrition_tracker_session_v1";

export async function loadSecureSession(): Promise<SecureSessionEnvelope | null> {
  const raw = await (await profileSecureStore()).get(SESSION_KEY);
  const session = parseSessionEnvelope(raw);
  if (!session && raw !== null) await (await profileSecureStore()).delete(SESSION_KEY);
  return session;
}

export async function saveSecureSession(session: SecureSessionEnvelope): Promise<void> {
  await (await profileSecureStore()).set(SESSION_KEY, serializeSessionEnvelope(session));
}

export async function clearSecureSession(): Promise<void> {
  await (await profileSecureStore()).delete(SESSION_KEY);
}
