import { createHash, createPublicKey } from "node:crypto";

export const HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA =
  "nutrition-tracker-health-release-reviewer-trust-v1";
export const RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA =
  "nutrition-tracker-release-deployment-reviewer-trust-v1";

const MAX_REVIEWER_KEYS = 20;
const MAX_PUBLIC_KEY_BYTES = 256;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{2,127}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REVIEWER_KEYS = [
  "algorithm",
  "keyId",
  "principal",
  "publicKeySpkiDerBase64",
  "validFrom",
  "validUntil",
];

function assertPlainRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, expected, name) {
  const actual = Object.keys(assertPlainRecord(value, name)).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${name} must contain exactly: ${required.join(", ")}.`);
  }
}

function parseCanonicalInstant(value, name) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant with milliseconds.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${name} must be a real canonical UTC instant.`);
  }
  return timestamp;
}

function decodeCanonicalBase64(value, name) {
  const maximumEncodedLength = Math.ceil(MAX_PUBLIC_KEY_BYTES / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    !STANDARD_BASE64.test(value)
  ) {
    throw new TypeError(`${name} must be bounded canonical padded standard base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_PUBLIC_KEY_BYTES ||
    bytes.toString("base64") !== value
  ) {
    throw new TypeError(`${name} was not canonical or exceeded its byte bound.`);
  }
  return bytes;
}

function parsePublicKey(value, name) {
  const der = decodeCanonicalBase64(value, `${name}.publicKeySpkiDerBase64`);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new TypeError(`${name} was not a valid SPKI public key.`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`${name} was not an Ed25519 public key.`);
  }
  const canonicalDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der)) {
    throw new TypeError(`${name} must use the canonical Ed25519 SPKI encoding.`);
  }
  return {
    publicKey,
    publicKeyFingerprintSha256: createHash("sha256").update(canonicalDer).digest("hex"),
  };
}

export function validateReviewerTrustStore(trustStore, { expectedSchema, label }) {
  assertExactKeys(trustStore, ["reviewers", "schemaVersion"], label);
  if (trustStore.schemaVersion !== expectedSchema) {
    throw new TypeError(`${label} schema is unsupported.`);
  }
  if (!Array.isArray(trustStore.reviewers) || trustStore.reviewers.length > MAX_REVIEWER_KEYS) {
    throw new TypeError(`${label} must contain at most ${MAX_REVIEWER_KEYS} keys.`);
  }

  const keyIds = new Set();
  const publicKeyFingerprints = new Set();
  return trustStore.reviewers.map((reviewer, index) => {
    const name = `${label}.reviewers[${index}]`;
    assertExactKeys(reviewer, REVIEWER_KEYS, name);
    if (typeof reviewer.keyId !== "string" || !SAFE_KEY_ID.test(reviewer.keyId)) {
      throw new TypeError(`${name}.keyId was invalid.`);
    }
    if (keyIds.has(reviewer.keyId)) {
      throw new TypeError(`${label} must not reuse reviewer key ID ${reviewer.keyId}.`);
    }
    keyIds.add(reviewer.keyId);
    if (typeof reviewer.principal !== "string" || !SAFE_IDENTIFIER.test(reviewer.principal)) {
      throw new TypeError(`${name}.principal must be a bounded non-secret identifier.`);
    }
    if (reviewer.algorithm !== "Ed25519") {
      throw new TypeError(`${name}.algorithm must be Ed25519.`);
    }
    const validFromTimestamp = parseCanonicalInstant(reviewer.validFrom, `${name}.validFrom`);
    const validUntilTimestamp = parseCanonicalInstant(reviewer.validUntil, `${name}.validUntil`);
    if (validUntilTimestamp <= validFromTimestamp) {
      throw new TypeError(`${name} validity interval must be nonempty and increasing.`);
    }
    const { publicKey, publicKeyFingerprintSha256 } = parsePublicKey(
      reviewer.publicKeySpkiDerBase64,
      name,
    );
    if (publicKeyFingerprints.has(publicKeyFingerprintSha256)) {
      throw new TypeError(`${label} must not reuse reviewer public key material.`);
    }
    publicKeyFingerprints.add(publicKeyFingerprintSha256);
    return {
      ...reviewer,
      publicKey,
      publicKeyFingerprintSha256,
      validFromTimestamp,
      validUntilTimestamp,
    };
  });
}

export function validateReviewerTrustStores({ deployment, health }) {
  const parsed = {
    deployment: validateReviewerTrustStore(deployment, {
      expectedSchema: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
      label: "deployment reviewer trust store",
    }),
    health: validateReviewerTrustStore(health, {
      expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
      label: "health reviewer trust store",
    }),
  };
  const globalKeyIds = new Map();
  const globalFingerprints = new Map();
  for (const [purpose, reviewers] of Object.entries(parsed)) {
    for (const reviewer of reviewers) {
      const priorKeyPurpose = globalKeyIds.get(reviewer.keyId);
      if (priorKeyPurpose !== undefined) {
        throw new TypeError(
          `Reviewer key ID ${reviewer.keyId} is reused across ${priorKeyPurpose} and ${purpose} trust stores.`,
        );
      }
      globalKeyIds.set(reviewer.keyId, purpose);
      const priorKeyMaterialPurpose = globalFingerprints.get(reviewer.publicKeyFingerprintSha256);
      if (priorKeyMaterialPurpose !== undefined) {
        throw new TypeError(
          `Reviewer public key material is reused across ${priorKeyMaterialPurpose} and ${purpose} trust stores.`,
        );
      }
      globalFingerprints.set(reviewer.publicKeyFingerprintSha256, purpose);
    }
  }
  return parsed;
}

export function reviewerKeyWasActiveAt(reviewer, reviewedAt) {
  return reviewer.validFromTimestamp <= reviewedAt && reviewedAt <= reviewer.validUntilTimestamp;
}
