import { createHmac } from "node:crypto";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCATOR_DOMAIN = "nutrition-tracker-erasure-ledger-locator-v1\n";

export interface ErasureLedgerLocatorKeyRing {
  readonly currentKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface ErasureLedgerLocator {
  readonly keyId: string;
  readonly digest: string;
  readonly value: string;
  readonly objectKey: string;
}

export class ErasureLedgerLocatorConfigurationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid erasure replay ledger locator configuration: ${field}`);
    this.name = "ErasureLedgerLocatorConfigurationError";
  }
}

function canonicalBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

export function parseErasureLedgerLocatorKeyRing(input: {
  readonly currentKeyId: string | undefined;
  readonly serializedKeys: string | undefined;
}): ErasureLedgerLocatorKeyRing {
  if (!input.currentKeyId || !KEY_ID_PATTERN.test(input.currentKeyId)) {
    throw new ErasureLedgerLocatorConfigurationError(
      "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
    );
  }
  if (!input.serializedKeys || input.serializedKeys.length > 32_768) {
    throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.serializedKeys);
  } catch {
    throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32) {
    throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of entries) {
    const bytes = typeof encoded === "string" ? canonicalBase64(encoded) : null;
    if (!KEY_ID_PATTERN.test(keyId) || !bytes || bytes.byteLength !== 32) {
      throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
    }
    keys.set(keyId, bytes);
  }
  if (!keys.has(input.currentKeyId)) {
    throw new ErasureLedgerLocatorConfigurationError(
      "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
    );
  }
  return { currentKeyId: input.currentKeyId, keys };
}

function canonicalUserId(userId: string): string {
  if (!CANONICAL_UUID_PATTERN.test(userId)) {
    throw new TypeError("Erasure ledger subject must be a canonical UUID");
  }
  return userId;
}

export function deriveErasureLedgerLocator(
  keyRing: ErasureLedgerLocatorKeyRing,
  userId: string,
  keyId: string = keyRing.currentKeyId,
): ErasureLedgerLocator {
  const key = keyRing.keys.get(keyId);
  if (key?.byteLength !== 32 || !KEY_ID_PATTERN.test(keyId)) {
    throw new ErasureLedgerLocatorConfigurationError("ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS");
  }
  const digest = createHmac("sha256", Buffer.from(key))
    .update(`${LOCATOR_DOMAIN}${canonicalUserId(userId)}`, "utf8")
    .digest("hex");
  return {
    digest,
    keyId,
    objectKey: `erasure-ledger/v1/${keyId}/${digest}.json.enc`,
    value: `v1:${keyId}:${digest}`,
  };
}

/** Restore probes every retained key. Callers must reject >1 valid match. */
export function erasureLedgerLocatorCandidates(
  keyRing: ErasureLedgerLocatorKeyRing,
  userId: string,
): readonly ErasureLedgerLocator[] {
  return [...keyRing.keys.keys()]
    .sort()
    .map((keyId) => deriveErasureLedgerLocator(keyRing, userId, keyId));
}
