import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalP256SpkiBase64,
  createRegistrationProof,
  createSignedHealthImportEnvelope,
  type DeviceSigner,
  derSignatureBase64ToBase64Url,
  sha256Base64ToHex,
} from "./device-signing";

const spki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzWZoz2KCsWHpIfyxj4r3+dqeaEuDwjjcFm8KXBW1dNzF7votiwmi0B/fsUlJlWHpbL4MBu4lMabcT6AlW9GvMw==";
const signatureBase64 =
  "MEQCIE6kweXWD+Ftm+gUhuoawRTXa45ihYaZhr2/euC8AFsUAiBf7LqVIbPw5oQcopItyEpYgekjKiE6aWU7hf707TMgLA==";
const signatureBase64Url =
  "MEQCIE6kweXWD-Ftm-gUhuoawRTXa45ihYaZhr2_euC8AFsUAiBf7LqVIbPw5oQcopItyEpYgekjKiE6aWU7hf707TMgLA";

describe("device-bound health signing", () => {
  it("preserves a canonical padded P-256 SPKI vector for the wire contract", () => {
    expect(canonicalP256SpkiBase64(spki)).toBe(spki);
    expect(() => canonicalP256SpkiBase64(spki.replace("MFkw", "MGkw"))).toThrow(/P-256/u);
  });

  it("base64url-normalizes DER ECDSA bytes without changing their encoding", () => {
    expect(derSignatureBase64ToBase64Url(signatureBase64)).toBe(signatureBase64Url);
    expect(() => derSignatureBase64ToBase64Url("AQIDBA==")).toThrow(/ECDSA/u);
  });

  it("uses deterministic code-point key ordering for canonical JSON", () => {
    expect(canonicalJson({ y: "2", kty: "EC", x: "1", crv: "P-256" })).toBe(
      '{"crv":"P-256","kty":"EC","x":"1","y":"2"}',
    );
    expect(canonicalJson({ 𐀀: 2, "": 1 })).toBe('{"":1,"𐀀":2}');
    expect(() => canonicalJson({ unsafe: Number.NaN })).toThrow(/finite/u);
    const sparse: unknown[] = new Array(2);
    sparse[1] = "sparse";
    expect(() => canonicalJson(sparse)).toThrow(/dense/u);
    const numericNamed = ["indexed"];
    Object.defineProperty(numericNamed, "4294967295", { enumerable: true, value: "named" });
    expect(() => canonicalJson(numericNamed)).toThrow(/dense/u);
    expect(() =>
      canonicalJson(
        new (class Value {
          readonly safe = true;
        })(),
      ),
    ).toThrow(/plain/u);
  });

  it("decodes the native base64 SHA-256 result into lowercase hex", () => {
    expect(sha256Base64ToHex("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(() => sha256Base64ToHex("AQIDBA==")).toThrow(/digest/u);
  });

  it("signs the shared canonical SPKI registration framing", async () => {
    const signedValues: string[] = [];
    const publicKey = { format: "spki", algorithm: "ES256", derBase64: spki } as const;
    const signer: DeviceSigner = {
      ensureHardwareKey: async () => ({
        publicKey,
        hardwareBacked: true,
        strongBoxBacked: null,
        securityLevel: "secure-enclave",
      }),
      resetHardwareKey: async () => undefined,
      sha256Hex: async (value) => {
        expect(value).toBe(
          `{"algorithm":"ES256","derBase64":${JSON.stringify(spki)},"format":"spki"}`,
        );
        return "c".repeat(64);
      },
      signUtf8: async (value) => {
        signedValues.push(value);
        return signatureBase64Url;
      },
    };
    const proof = await createRegistrationProof(signer, {
      challengeId: "10000000-0000-4000-8000-000000000001",
      challenge: "q".repeat(43),
      platform: "apple_healthkit",
    });
    expect(proof.publicKey).toEqual(publicKey);
    expect(proof.challengeSignature).toBe(signatureBase64Url);
    expect(signedValues).toEqual([
      [
        "nutrition-tracker-device-registration-v1",
        "10000000-0000-4000-8000-000000000001",
        "q".repeat(43),
        "apple_healthkit",
        "c".repeat(64),
      ].join("\n"),
    ]);
  });

  it("keeps the signed timestamp, nonce, body, and signature stable across retries", async () => {
    const signedValues: string[] = [];
    const signer: DeviceSigner = {
      ensureHardwareKey: async () => {
        throw new Error("unused");
      },
      resetHardwareKey: async () => undefined,
      sha256Hex: async () => "a".repeat(64),
      signUtf8: async (value) => {
        signedValues.push(value);
        return signatureBase64Url;
      },
    };
    const body = {
      deviceId: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
      batchId: "118f6f58-4e2c-7b62-8f0b-3d75491713b5",
      cursorEpoch: "7",
      platform: "apple_healthkit" as const,
      sourceCursor: null,
      nextSourceCursor: "b".repeat(64),
      records: [{ operation: "delete" as const, externalId: "sample", externalRevision: "1" }],
    };
    const first = await createSignedHealthImportEnvelope(
      signer,
      body,
      "2026-08-16T08:00:00.000Z",
      "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
    );
    const retry = await createSignedHealthImportEnvelope(
      signer,
      body,
      "2026-08-16T08:00:00.000Z",
      "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
    );
    expect(retry).toEqual(first);
    expect(signedValues[0]).toContain(
      "nutrition-tracker-health-import-v1\n018f6f58-4e2c-7b62-8f0b-3d75491713b5\napple_healthkit",
    );
    expect(signedValues[1]).toBe(signedValues[0]);
  });
});
