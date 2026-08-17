import type { HealthImportBatchRequest, PlatformIntegration } from "@nutrition-tracker/contracts";

interface EstablishHealthCursorEpochInput {
  readonly existing: PlatformIntegration | null;
  readonly deviceId: string;
  readonly localServerDigest: string | null;
  readonly pendingBatch: HealthImportBatchRequest | null;
  readonly consent: () => Promise<PlatformIntegration>;
  readonly rebind: (
    integration: PlatformIntegration,
    deviceId: string,
  ) => Promise<PlatformIntegration>;
  /** Clears provider cursor/revision indexes only after the server accepted a new null epoch. */
  readonly resetLocalCursor: () => Promise<void>;
}

function assertNewEpoch(
  integration: PlatformIntegration,
  deviceId: string,
  previousCursorEpoch: string | null,
) {
  if (
    integration.status !== "connected" ||
    integration.deviceId !== deviceId ||
    integration.currentSourceCursor !== null ||
    (previousCursorEpoch !== null && BigInt(integration.cursorEpoch) <= BigInt(previousCursorEpoch))
  ) {
    throw new Error("The server did not establish the requested health cursor epoch.");
  }
}

/**
 * Converges the registered device, server cursor epoch, and protected local journal. Retained
 * journals are never erased before the server confirms a replacement null epoch.
 */
export async function establishHealthCursorEpoch(
  input: EstablishHealthCursorEpochInput,
): Promise<{ readonly integration: PlatformIntegration; readonly reset: boolean }> {
  if (!input.existing || input.existing.status === "disconnected") {
    const integration = await input.consent();
    assertNewEpoch(integration, input.deviceId, input.existing?.cursorEpoch ?? null);
    await input.resetLocalCursor();
    return { integration, reset: true };
  }

  if (input.pendingBatch) {
    if (
      input.pendingBatch.platform !== input.existing.platform ||
      input.pendingBatch.sourceCursor !== input.localServerDigest
    ) {
      throw new Error("The protected pending health batch does not match its cursor journal.");
    }
    if (
      input.existing.deviceId === input.deviceId &&
      input.pendingBatch.deviceId === input.deviceId &&
      input.pendingBatch.cursorEpoch === input.existing.cursorEpoch
    ) {
      if (
        input.existing.currentSourceCursor === input.pendingBatch.sourceCursor ||
        input.existing.currentSourceCursor === input.pendingBatch.nextSourceCursor
      ) {
        return { integration: input.existing, reset: false };
      }
      throw new Error(
        "The pending health batch does not extend or replay the current server cursor.",
      );
    }
  }

  if (
    input.existing.deviceId !== input.deviceId ||
    (input.pendingBatch !== null &&
      (input.pendingBatch.deviceId !== input.deviceId ||
        input.pendingBatch.cursorEpoch !== input.existing.cursorEpoch)) ||
    (input.existing.currentSourceCursor !== null && input.localServerDigest === null)
  ) {
    const integration = await input.rebind(input.existing, input.deviceId);
    assertNewEpoch(integration, input.deviceId, input.existing.cursorEpoch);
    await input.resetLocalCursor();
    return { integration, reset: true };
  }

  if (input.existing.currentSourceCursor !== input.localServerDigest) {
    throw new Error(
      "The protected health cursor does not match the server. Import is paused until an explicit cursor-epoch recovery.",
    );
  }
  return { integration: input.existing, reset: false };
}
