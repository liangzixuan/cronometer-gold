import { createHash } from "node:crypto";
import { IngestionError, invariant } from "./errors.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * JSON Canonicalization Scheme-style serialization for ingestion identity.
 * Inputs must already be JSON values; undefined, non-finite numbers, sparse
 * arrays, class instances and cycles are rejected instead of silently changed.
 */
export function canonicalJson(value: unknown): string {
  return serializeJson(value, new Set<object>());
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalNonNegativeDecimal(value: unknown, field: string): string {
  invariant(
    typeof value === "string" || typeof value === "number",
    "INVALID_RECORD",
    `${field} must be a decimal string or number`,
    { field },
  );
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "INVALID_RECORD", `${field} must be finite`, { field });
  }

  const input = String(value).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(input);
  invariant(match, "INVALID_RECORD", `${field} is not a decimal`, { field, value: input });

  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  invariant(
    Number.isSafeInteger(exponent) && Math.abs(exponent) <= 1_000,
    "INVALID_RECORD",
    `${field} exponent is outside the supported range`,
    { field },
  );

  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  let expanded: string;
  if (decimalIndex <= 0) {
    expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  const [rawWhole = "0", rawFraction = ""] = expanded.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = rawFraction.replace(/0+$/, "");
  const magnitude = normalizedFraction.length > 0 ? `${whole}.${normalizedFraction}` : whole;
  invariant(magnitude.length <= 2_048, "INVALID_RECORD", `${field} has too many digits`, { field });
  invariant(
    sign !== "-" || /^0(?:\.0*)?$/.test(magnitude),
    "INVALID_RECORD",
    `${field} is negative`,
    {
      field,
    },
  );
  return magnitude;
}

export function normalizeText(value: unknown, field: string): string {
  invariant(typeof value === "string", "INVALID_RECORD", `${field} must be text`, { field });
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  invariant(normalized.length > 0, "INVALID_RECORD", `${field} is required`, { field });
  invariant(normalized.length <= 2_000, "INVALID_RECORD", `${field} is too long`, { field });
  return normalized;
}

function serializeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    invariant(
      Number.isFinite(value),
      "INVALID_RECORD",
      "Canonical JSON rejects non-finite numbers",
    );
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    invariant(!ancestors.has(value), "INVALID_RECORD", "Canonical JSON rejects cycles");
    ancestors.add(value);
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      invariant(index in value, "INVALID_RECORD", "Canonical JSON rejects sparse arrays", {
        index,
      });
      entries.push(serializeJson(value[index], ancestors));
    }
    ancestors.delete(value);
    return `[${entries.join(",")}]`;
  }
  invariant(
    typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    "INVALID_RECORD",
    "Canonical JSON accepts only JSON objects",
  );
  invariant(!ancestors.has(value), "INVALID_RECORD", "Canonical JSON rejects cycles");
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort(compareCodePoints)
    .map((key) => {
      const item = record[key];
      if (item === undefined || typeof item === "bigint" || typeof item === "function") {
        throw new IngestionError("INVALID_RECORD", "Canonical JSON rejects non-JSON values", {
          key,
        });
      }
      return `${JSON.stringify(key)}:${serializeJson(item, ancestors)}`;
    });
  ancestors.delete(value);
  return `{${entries.join(",")}}`;
}

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
