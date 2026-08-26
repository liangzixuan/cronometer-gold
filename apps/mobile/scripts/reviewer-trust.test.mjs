import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
  RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  reviewerKeyWasActiveAt,
  validateReviewerTrustStore,
  validateReviewerTrustStores,
} from "./reviewer-trust.mjs";

function publicKeyBase64(keyPair = generateKeyPairSync("ed25519")) {
  return keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

function reviewer(overrides = {}) {
  return {
    algorithm: "Ed25519",
    keyId: "reviewer-2026-01",
    principal: "independent.reviewer@example.test",
    publicKeySpkiDerBase64: publicKeyBase64(),
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function healthStore(reviewers = []) {
  return { schemaVersion: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA, reviewers };
}

function deploymentStore(reviewers = []) {
  return { schemaVersion: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA, reviewers };
}

describe("reviewer trust roots", () => {
  it("accepts the intentionally empty checked-in trust roots", () => {
    expect(
      validateReviewerTrustStores({ deployment: deploymentStore(), health: healthStore() }),
    ).toEqual({ deployment: [], health: [] });
  });

  it("validates every inactive root cryptographically without requiring it to be active now", () => {
    const parsed = validateReviewerTrustStore(
      healthStore([
        reviewer({
          keyId: "expired-reviewer-2025",
          validFrom: "2025-01-01T00:00:00.000Z",
          validUntil: "2025-12-31T23:59:59.999Z",
        }),
        reviewer({
          keyId: "future-reviewer-2027",
          publicKeySpkiDerBase64: publicKeyBase64(),
          validFrom: "2027-01-01T00:00:00.000Z",
          validUntil: "2028-01-01T00:00:00.000Z",
        }),
      ]),
      {
        expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
        label: "health reviewer trust store",
      },
    );
    const reviewTime = Date.parse("2026-08-26T00:00:00.000Z");
    expect(parsed).toHaveLength(2);
    expect(parsed.every((root) => !reviewerKeyWasActiveAt(root, reviewTime))).toBe(true);
    expect(parsed.every((root) => root.publicKey.asymmetricKeyType === "ed25519")).toBe(true);
  });

  it("uses inclusive evidence-time validity boundaries", () => {
    const [parsed] = validateReviewerTrustStore(healthStore([reviewer()]), {
      expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
      label: "health reviewer trust store",
    });
    expect(reviewerKeyWasActiveAt(parsed, parsed.validFromTimestamp)).toBe(true);
    expect(reviewerKeyWasActiveAt(parsed, parsed.validUntilTimestamp)).toBe(true);
    expect(reviewerKeyWasActiveAt(parsed, parsed.validFromTimestamp - 1)).toBe(false);
    expect(reviewerKeyWasActiveAt(parsed, parsed.validUntilTimestamp + 1)).toBe(false);
  });

  it.each([
    [
      "zero-length interval",
      (root) => {
        root.validUntil = root.validFrom;
      },
      /nonempty and increasing/u,
    ],
    [
      "inverted interval",
      (root) => {
        root.validUntil = "2025-01-01T00:00:00.000Z";
      },
      /nonempty and increasing/u,
    ],
    [
      "malformed inactive SPKI",
      (root) => {
        root.validFrom = "2027-01-01T00:00:00.000Z";
        root.validUntil = "2028-01-01T00:00:00.000Z";
        root.publicKeySpkiDerBase64 = Buffer.from("not-a-public-key").toString("base64");
      },
      /valid SPKI public key/u,
    ],
    [
      "wrong key type",
      (root) => {
        root.publicKeySpkiDerBase64 = publicKeyBase64(generateKeyPairSync("x25519"));
      },
      /Ed25519 public key/u,
    ],
    [
      "noncanonical validity instant",
      (root) => {
        root.validFrom = "2026-01-01T00:00:00Z";
      },
      /canonical ISO-8601/u,
    ],
    [
      "noncanonical public-key base64",
      (root) => {
        root.publicKeySpkiDerBase64 = root.publicKeySpkiDerBase64.replace(/=+$/u, "");
      },
      /canonical padded standard base64/u,
    ],
  ])("rejects an invalid %s", (_label, mutate, message) => {
    const root = reviewer();
    mutate(root);
    expect(() =>
      validateReviewerTrustStore(healthStore([root]), {
        expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
        label: "health reviewer trust store",
      }),
    ).toThrow(message);
  });

  it("rejects reused key IDs or public keys inside one trust store", () => {
    const sharedKey = publicKeyBase64();
    expect(() =>
      validateReviewerTrustStore(
        healthStore([
          reviewer({ keyId: "duplicate-key-id" }),
          reviewer({ keyId: "duplicate-key-id", publicKeySpkiDerBase64: publicKeyBase64() }),
        ]),
        {
          expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
          label: "health reviewer trust store",
        },
      ),
    ).toThrow(/reuse reviewer key ID/u);

    expect(() =>
      validateReviewerTrustStore(
        healthStore([
          reviewer({ keyId: "health-key-1", publicKeySpkiDerBase64: sharedKey }),
          reviewer({ keyId: "health-key-2", publicKeySpkiDerBase64: sharedKey }),
        ]),
        {
          expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
          label: "health reviewer trust store",
        },
      ),
    ).toThrow(/reuse reviewer public key material/u);
  });

  it("rejects key-ID and public-key reuse across trust purposes", () => {
    expect(() =>
      validateReviewerTrustStores({
        deployment: deploymentStore([reviewer({ keyId: "shared-key-id" })]),
        health: healthStore([
          reviewer({ keyId: "shared-key-id", publicKeySpkiDerBase64: publicKeyBase64() }),
        ]),
      }),
    ).toThrow(/key ID.*reused across/u);

    const sharedKey = publicKeyBase64();
    expect(() =>
      validateReviewerTrustStores({
        deployment: deploymentStore([
          reviewer({ keyId: "deployment-key", publicKeySpkiDerBase64: sharedKey }),
        ]),
        health: healthStore([reviewer({ keyId: "health-key", publicKeySpkiDerBase64: sharedKey })]),
      }),
    ).toThrow(/public key material is reused across/u);

    const sharedInactiveKey = publicKeyBase64();
    expect(() =>
      validateReviewerTrustStores({
        deployment: deploymentStore([
          reviewer({
            keyId: "expired-deployment-key",
            publicKeySpkiDerBase64: sharedInactiveKey,
            validFrom: "2024-01-01T00:00:00.000Z",
            validUntil: "2025-01-01T00:00:00.000Z",
          }),
        ]),
        health: healthStore([
          reviewer({
            keyId: "future-health-key",
            publicKeySpkiDerBase64: sharedInactiveKey,
            validFrom: "2027-01-01T00:00:00.000Z",
            validUntil: "2028-01-01T00:00:00.000Z",
          }),
        ]),
      }),
    ).toThrow(/public key material is reused across/u);
  });

  it("accepts one principal with distinct keys and IDs across both trust purposes", () => {
    expect(() =>
      validateReviewerTrustStores({
        deployment: deploymentStore([reviewer({ keyId: "deployment-key" })]),
        health: healthStore([
          reviewer({ keyId: "health-key", publicKeySpkiDerBase64: publicKeyBase64() }),
        ]),
      }),
    ).not.toThrow();
  });

  it("rejects more than twenty reviewer roots", () => {
    const reviewers = Array.from({ length: 21 }, (_value, index) =>
      reviewer({ keyId: `health-reviewer-${String(index + 1).padStart(2, "0")}` }),
    );
    expect(() =>
      validateReviewerTrustStore(healthStore(reviewers), {
        expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
        label: "health reviewer trust store",
      }),
    ).toThrow(/at most 20 keys/u);
  });
});
