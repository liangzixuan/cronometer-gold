import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";

import {
  canonicalJson,
  deviceRegistrationSignaturePayload,
  type RegisterHealthDeviceRequest,
} from "@nutrition-tracker/contracts";

export interface VerifiedDeviceRegistration {
  readonly canonicalSignaturePayload: string;
  readonly keyFingerprint: string;
  readonly publicKeySpkiBase64: string;
  readonly proofSignatureDigest: string;
}

function p256PublicKey(spkiBase64: string): { readonly der: Buffer; readonly key: KeyObject } {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(spkiBase64)) {
    throw new TypeError("Device SPKI is not canonical base64");
  }
  const der = Buffer.from(spkiBase64, "base64");
  if (der.byteLength < 80 || der.byteLength > 512 || der.toString("base64") !== spkiBase64) {
    throw new TypeError("Device SPKI is invalid");
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  const jwk = key.export({ format: "jwk" });
  if (key.asymmetricKeyType !== "ec" || jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new TypeError("Device key must be EC P-256");
  }
  return { der, key };
}

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new TypeError("Signature is not base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new TypeError("Signature is not canonical");
  return bytes;
}

export function verifyP256DerSignature(input: {
  readonly publicKeySpkiBase64: string;
  readonly signatureBase64Url: string;
  readonly payload: string;
}): boolean {
  try {
    const { key } = p256PublicKey(input.publicKeySpkiBase64);
    const signature = canonicalBase64Url(input.signatureBase64Url);
    return verifySignature("sha256", Buffer.from(input.payload, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function verifyDeviceRegistration(
  request: RegisterHealthDeviceRequest,
): VerifiedDeviceRegistration {
  const { der } = p256PublicKey(request.publicKey.derBase64);
  const canonicalPublicKeySha256 = createHash("sha256")
    .update(canonicalJson(request.publicKey), "utf8")
    .digest("hex");
  const canonicalSignaturePayload = deviceRegistrationSignaturePayload({
    challengeId: request.challengeId,
    challenge: request.challenge,
    platform: request.platform,
    canonicalPublicKeySha256,
  });
  const signature = canonicalBase64Url(request.challengeSignature);
  const { key } = p256PublicKey(request.publicKey.derBase64);
  if (!verifySignature("sha256", Buffer.from(canonicalSignaturePayload, "utf8"), key, signature)) {
    throw new TypeError("Device registration proof is invalid");
  }
  return {
    canonicalSignaturePayload,
    keyFingerprint: createHash("sha256").update(der).digest("hex"),
    publicKeySpkiBase64: request.publicKey.derBase64,
    proofSignatureDigest: createHash("sha256").update(signature).digest("hex"),
  };
}
