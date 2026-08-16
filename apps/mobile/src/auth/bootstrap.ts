export type SessionBootstrapDecision = "accept" | "clear" | "retry";

export function sessionBootstrapDecision(status: number): SessionBootstrapDecision {
  if (status === 200) return "accept";
  if (status === 401) return "clear";
  return "retry";
}

/** Remove sensitive in-memory state first, even when secure storage is unavailable. */
export async function clearSessionFailClosed(
  deletePersistedCredential: () => Promise<void>,
  clearMemory: () => void,
): Promise<boolean> {
  clearMemory();
  try {
    await deletePersistedCredential();
    return true;
  } catch {
    return false;
  }
}
