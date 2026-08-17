import {
  canonicalJson,
  deviceRegistrationSignaturePayload,
  type HealthImportBatchRequest,
  type HealthPlatform,
  healthImportSignaturePayload,
  type RegisterHealthDeviceRequest,
} from "@nutrition-tracker/contracts";

const KEY_ALIAS = "nutrition-tracker-health-import-v1";
const P256_SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d03010703420004";
const HEX = /^[0-9a-f]{64}$/u;

export type { HealthPlatform };
export { canonicalJson };

export interface HardwareKeyEvidence {
  readonly publicKey: RegisterHealthDeviceRequest["publicKey"];
  readonly hardwareBacked: true;
  readonly strongBoxBacked: boolean | null;
  readonly securityLevel: string;
}

export interface DeviceSigner {
  ensureHardwareKey(): Promise<HardwareKeyEvidence>;
  /** Explicit recovery only: the old server device must be revoked before re-registration. */
  resetHardwareKey(): Promise<void>;
  sha256Hex(value: string): Promise<string>;
  signUtf8(value: string): Promise<string>;
}

export type HealthImportBody = HealthImportBatchRequest;

export interface SignedHealthImportEnvelope {
  readonly body: HealthImportBody;
  readonly headers: {
    readonly "x-device-timestamp": string;
    readonly "x-device-nonce": string;
    readonly "x-device-signature": string;
  };
}

function base64Value(character: string): number {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return alphabet.indexOf(character);
}

export function decodeStandardBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new TypeError("Native cryptography returned invalid base64.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Value(value[index] ?? "");
    const second = base64Value(value[index + 1] ?? "");
    const third = value[index + 2] === "=" ? 0 : base64Value(value[index + 2] ?? "");
    const fourth = value[index + 3] === "=" ? 0 : base64Value(value[index + 3] ?? "");
    if ([first, second, third, fourth].some((item) => item < 0)) {
      throw new TypeError("Native cryptography returned invalid base64.");
    }
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (offset < output.length) output[offset++] = (combined >>> 16) & 0xff;
    if (offset < output.length) output[offset++] = (combined >>> 8) & 0xff;
    if (offset < output.length) output[offset++] = combined & 0xff;
  }
  return output;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    result += alphabet[(combined >>> 18) & 63] ?? "";
    result += alphabet[(combined >>> 12) & 63] ?? "";
    if (index + 1 < bytes.length) result += alphabet[(combined >>> 6) & 63] ?? "";
    if (index + 2 < bytes.length) result += alphabet[combined & 63] ?? "";
  }
  return result;
}

function bytesToStandardBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    result += alphabet[(combined >>> 18) & 63] ?? "";
    result += alphabet[(combined >>> 12) & 63] ?? "";
    result += index + 1 < bytes.length ? (alphabet[(combined >>> 6) & 63] ?? "") : "=";
    result += index + 2 < bytes.length ? (alphabet[combined & 63] ?? "") : "=";
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sha256Base64ToHex(value: string): string {
  const bytes = decodeStandardBase64(value);
  if (bytes.length !== 32) throw new TypeError("Native SHA-256 returned an invalid digest.");
  return bytesToHex(bytes);
}

export function canonicalP256SpkiBase64(value: string): string {
  const bytes = decodeStandardBase64(value);
  const prefixBytes = P256_SPKI_PREFIX.length / 2;
  if (
    bytes.length !== prefixBytes + 64 ||
    bytesToHex(bytes.slice(0, prefixBytes)) !== P256_SPKI_PREFIX
  ) {
    throw new TypeError("The device key is not a canonical P-256 SubjectPublicKeyInfo key.");
  }
  return bytesToStandardBase64(bytes);
}

function isMinimalPositiveInteger(bytes: Uint8Array): boolean {
  if (bytes.length < 1 || bytes.length > 33 || (bytes[0] ?? 0) >= 0x80) return false;
  return !(bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80);
}

export function assertDerEcdsaSignature(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) {
    throw new TypeError("The device returned a malformed ECDSA signature.");
  }
  if (bytes[2] !== 0x02) throw new TypeError("The device returned a malformed ECDSA signature.");
  const rLength = bytes[3] ?? 0;
  const rStart = 4;
  const sTag = rStart + rLength;
  if (bytes[sTag] !== 0x02) throw new TypeError("The device returned a malformed ECDSA signature.");
  const sLength = bytes[sTag + 1] ?? 0;
  const sStart = sTag + 2;
  if (
    sStart + sLength !== bytes.length ||
    !isMinimalPositiveInteger(bytes.slice(rStart, sTag)) ||
    !isMinimalPositiveInteger(bytes.slice(sStart))
  ) {
    throw new TypeError("The device returned a malformed ECDSA signature.");
  }
}

export function derSignatureBase64ToBase64Url(value: string): string {
  const bytes = decodeStandardBase64(value);
  assertDerEcdsaSignature(bytes);
  return bytesToBase64Url(bytes);
}

export function createHardwareDeviceSigner(): DeviceSigner {
  return {
    async ensureHardwareKey() {
      const biometrics = await import("@sbaiahmed1/react-native-biometrics");
      let exists = await biometrics.keyExists(KEY_ALIAS);
      if (!exists) {
        try {
          await biometrics.createKeysWithOptions({
            keyAlias: KEY_ALIAS,
            keyType: "ec256",
            requireAuthentication: false,
            failIfExists: true,
          });
        } catch {
          exists = await biometrics.keyExists(KEY_ALIAS);
          if (!exists) throw new Error("A non-exportable device signing key could not be created.");
        }
      }
      const integrity = await biometrics.validateKeyIntegrity(KEY_ALIAS);
      if (!integrity.keyExists || !integrity.valid || !integrity.integrityChecks.hardwareBacked) {
        throw new Error("This device did not provide a validated hardware-backed signing key.");
      }
      const publicKey = {
        format: "spki",
        algorithm: "ES256",
        derBase64: canonicalP256SpkiBase64((await biometrics.getPublicKey(KEY_ALIAS)).publicKey),
      } as const satisfies RegisterHealthDeviceRequest["publicKey"];
      return {
        publicKey,
        hardwareBacked: true,
        strongBoxBacked: integrity.integrityChecks.strongBoxBacked ?? null,
        securityLevel: integrity.keyAttributes?.securityLevel ?? "hardware-backed",
      };
    },
    async resetHardwareKey() {
      const { deleteKeys, keyExists } = await import("@sbaiahmed1/react-native-biometrics");
      if (!(await keyExists(KEY_ALIAS))) return;
      const result = await deleteKeys(KEY_ALIAS);
      if (!result.success || (await keyExists(KEY_ALIAS))) {
        throw new Error("The invalidated device signing key could not be removed safely.");
      }
    },
    async sha256Hex(value) {
      const { sha256 } = await import("@sbaiahmed1/react-native-biometrics");
      const result = await sha256(value, "utf8");
      const digest = sha256Base64ToHex(result.hash);
      if (!HEX.test(digest)) throw new TypeError("Native SHA-256 returned an invalid digest.");
      return digest;
    },
    async signUtf8(value) {
      const { InputEncoding, SignatureAlgorithm, sign } = await import(
        "@sbaiahmed1/react-native-biometrics"
      );
      const result = await sign({
        keyAlias: KEY_ALIAS,
        data: value,
        inputEncoding: InputEncoding.UTF8,
        algorithm: SignatureAlgorithm.SHA256withECDSA,
      });
      if (!result.success || !result.signature) {
        throw new Error("The hardware-backed device key could not sign this request.");
      }
      return derSignatureBase64ToBase64Url(result.signature);
    },
  };
}

export async function createRegistrationProof(
  signer: DeviceSigner,
  input: {
    readonly challengeId: string;
    readonly challenge: string;
    readonly platform: HealthPlatform;
  },
): Promise<{
  readonly publicKey: RegisterHealthDeviceRequest["publicKey"];
  readonly challengeSignature: RegisterHealthDeviceRequest["challengeSignature"];
  readonly evidence: HardwareKeyEvidence;
}> {
  const evidence = await signer.ensureHardwareKey();
  const publicKeyHash = await signer.sha256Hex(canonicalJson(evidence.publicKey));
  const canonical = deviceRegistrationSignaturePayload({
    challengeId: input.challengeId,
    challenge: input.challenge,
    platform: input.platform,
    canonicalPublicKeySha256: publicKeyHash,
  });
  return {
    publicKey: evidence.publicKey,
    challengeSignature: await signer.signUtf8(canonical),
    evidence,
  };
}

export async function createSignedHealthImportEnvelope(
  signer: DeviceSigner,
  body: HealthImportBody,
  timestamp: string,
  nonce: string,
): Promise<SignedHealthImportEnvelope> {
  if (!Number.isFinite(new Date(timestamp).getTime()) || !/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) {
    throw new TypeError("A stable signed-import timestamp and nonce are required.");
  }
  const bodyHash = await signer.sha256Hex(canonicalJson(body));
  const canonical = healthImportSignaturePayload({
    deviceId: body.deviceId,
    platform: body.platform,
    batchId: body.batchId,
    signedAt: timestamp,
    nonce,
    bodySha256: bodyHash,
  });
  return {
    body,
    headers: {
      "x-device-timestamp": timestamp,
      "x-device-nonce": nonce,
      "x-device-signature": await signer.signUtf8(canonical),
    },
  };
}
