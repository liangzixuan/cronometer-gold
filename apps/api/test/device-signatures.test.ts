import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalJson,
  deviceRegistrationSignaturePayload,
  healthImportSignaturePayload,
  type RegisterHealthDeviceRequest,
} from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  verifyDeviceRegistration,
  verifyP256DerSignature,
} from "../src/modules/retention/device-signatures.js";

const challengeId = "10000000-0000-4000-8000-000000000001";
const challenge = "q".repeat(43);

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  const publicKeyRequest = {
    format: "spki" as const,
    algorithm: "ES256" as const,
    derBase64: der.toString("base64"),
  };
  const keyDigest = createHash("sha256")
    .update(canonicalJson(publicKeyRequest), "utf8")
    .digest("hex");
  const payload = deviceRegistrationSignaturePayload({
    challengeId,
    challenge,
    platform: "apple_healthkit",
    canonicalPublicKeySha256: keyDigest,
  });
  const signature = sign("sha256", Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  const request: RegisterHealthDeviceRequest = {
    challengeId,
    challenge,
    platform: "apple_healthkit",
    displayName: "Test iPhone",
    publicKey: publicKeyRequest,
    challengeSignature: signature,
    attestation: null,
  };
  return { privateKey, request };
}

describe("P-256 device signatures", () => {
  it("verifies a generated SPKI and ASN.1 DER registration proof", () => {
    const { request } = fixture();
    const verified = verifyDeviceRegistration(request);
    expect(verified.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.proofSignatureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.canonicalSignaturePayload).toContain(
      "nutrition-tracker-device-registration-v1\n",
    );
    expect(() =>
      verifyDeviceRegistration({ ...request, challenge: `${request.challenge}x` }),
    ).toThrow(TypeError);
  });

  it("verifies base64url-wrapped DER import signatures and rejects P1363/tampering", () => {
    const { privateKey, request } = fixture();
    const payload = healthImportSignaturePayload({
      deviceId: "20000000-0000-4000-8000-000000000002",
      platform: "apple_healthkit",
      batchId: "30000000-0000-4000-8000-000000000003",
      signedAt: "2026-08-16T12:00:00.000Z",
      nonce: "n".repeat(22),
      bodySha256: "a".repeat(64),
    });
    const derSignature = sign("sha256", Buffer.from(payload, "utf8"), privateKey).toString(
      "base64url",
    );
    expect(
      verifyP256DerSignature({
        publicKeySpkiBase64: request.publicKey.derBase64,
        signatureBase64Url: derSignature,
        payload,
      }),
    ).toBe(true);
    expect(
      verifyP256DerSignature({
        publicKeySpkiBase64: request.publicKey.derBase64,
        signatureBase64Url: derSignature,
        payload: `${payload}x`,
      }),
    ).toBe(false);
    const p1363 = sign("sha256", Buffer.from(payload, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    expect(
      verifyP256DerSignature({
        publicKeySpkiBase64: request.publicKey.derBase64,
        signatureBase64Url: p1363,
        payload,
      }),
    ).toBe(false);
  });
});
