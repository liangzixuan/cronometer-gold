/** JSON value accepted by the cross-client signing protocol. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Deterministic UTF-8 JSON text for signatures and idempotency digests.
 * Object keys use Unicode code-point order. Undefined, sparse arrays,
 * non-finite numbers, class instances, and unsupported values fail closed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      throw new TypeError("Canonical JSON arrays must contain exactly their dense indexes");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("Value is not canonical JSON");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON objects must be plain records");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0) as number);
  const rightPoints = [...right].map((value) => value.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export interface HealthImportSignatureBinding {
  readonly deviceId: string;
  readonly platform: "apple_healthkit" | "android_health_connect";
  readonly batchId: string;
  readonly signedAt: string;
  readonly nonce: string;
  readonly bodySha256: string;
}

/** Shared protocol framing. `bodySha256` hashes UTF-8 `canonicalJson(requestBody)`. */
export function healthImportSignaturePayload(binding: HealthImportSignatureBinding): string {
  if (!/^[0-9a-f]{64}$/.test(binding.bodySha256)) {
    throw new TypeError("Health import body digest must be lowercase SHA-256 hex");
  }
  return [
    "nutrition-tracker-health-import-v1",
    binding.deviceId,
    binding.platform,
    binding.batchId,
    binding.signedAt,
    binding.nonce,
    binding.bodySha256,
  ].join("\n");
}

export interface DeviceRegistrationSignatureBinding {
  readonly challengeId: string;
  readonly challenge: string;
  readonly platform: "apple_healthkit" | "android_health_connect";
  readonly canonicalPublicKeySha256: string;
}

export function deviceRegistrationSignaturePayload(
  binding: DeviceRegistrationSignatureBinding,
): string {
  if (!/^[0-9a-f]{64}$/.test(binding.canonicalPublicKeySha256)) {
    throw new TypeError("Device public-key digest must be lowercase SHA-256 hex");
  }
  return [
    "nutrition-tracker-device-registration-v1",
    binding.challengeId,
    binding.challenge,
    binding.platform,
    binding.canonicalPublicKeySha256,
  ].join("\n");
}
