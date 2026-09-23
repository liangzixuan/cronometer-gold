import { createHash } from "node:crypto";

/** V2 byte commitments have no relationship to V1 JSON or semantic digest meanings. */
export const CATALOGUE_PREPARATION_NAMESPACE_V2 = "nourishing:catalogue-preparation:v2";
export const CATALOGUE_MAX_FRAME_BYTES_V2 = 17 * 1024 * 1024;
const MAX_FIELDS = 64;
const MAX_INTEGER = 9_223_372_036_854_775_807n;
const SHA256 = /^[0-9a-f]{64}$/u;

/** Reject strings PostgreSQL text cannot preserve; never silently replace UTF-16. */
export function assertCatalogueTextV2(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}: expected text`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) throw new Error(`Invalid ${name}: PostgreSQL text cannot contain NUL`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`Invalid ${name}: unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Invalid ${name}: unpaired surrogate`);
    }
  }
}

/**
 * SHA256(frame(namespace) || frame(domain) || frame(field0) || ...).
 * frame(s) is ASCII(decimal UTF-8 byte length) || ':' || UTF-8(s).
 * Callers specify a fixed domain and ordered fields; no implicit JSON serialization.
 */
export function catalogueFramedSha256V2(domain: string, fields: readonly string[]): string {
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(domain))
    throw new Error("Invalid catalogue V2 commitment domain");
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS)
    throw new Error("Catalogue V2 commitment exceeds field count");
  const digest = createHash("sha256");
  let total = 0;
  for (const field of [CATALOGUE_PREPARATION_NAMESPACE_V2, domain, ...fields]) {
    assertCatalogueTextV2(field, "commitment field");
    const byteSize = Buffer.byteLength(field, "utf8");
    const prefix = `${byteSize}:`;
    total += prefix.length + byteSize;
    if (total > CATALOGUE_MAX_FRAME_BYTES_V2)
      throw new Error("Catalogue V2 commitment exceeds byte budget");
    digest.update(prefix, "ascii").update(field, "utf8");
  }
  return digest.digest("hex");
}

export function assertCatalogueSha256V2(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new Error(`Invalid ${name}: expected lowercase SHA-256`);
}

/** Counts remain decimal text so the wire contract never loses bigint precision. */
export function catalogueUnsignedIntegerV2(value: unknown, name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0)))
  )
    throw new Error(`Invalid ${name}: expected an exact unsigned integer`);
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(text) || BigInt(text) > MAX_INTEGER)
    throw new Error(`Invalid ${name}: unsigned PostgreSQL bigint required`);
  return text;
}

/** Exact retained document identity, distinct from parsed/canonical JSON identity. */
export function catalogueDocumentSha256V2(document: string, maximumBytes: number): string {
  assertCatalogueTextV2(document, "retained document");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("Invalid retained document byte budget");
  const bytes = Buffer.byteLength(document, "utf8");
  if (bytes < 1 || bytes > maximumBytes)
    throw new Error("Retained catalogue document exceeds byte budget");
  return createHash("sha256").update(document, "utf8").digest("hex");
}
