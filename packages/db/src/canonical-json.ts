import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

export type { JsonValue } from "./types.js";

export function canonicalJson(value: JsonValue): string {
  return [...canonicalJsonChunks(value)].join("");
}

/** Iterate canonical JSON bytes without constructing one catalogue-sized string. */
export function* canonicalJsonChunks(value: JsonValue): IterableIterator<string> {
  const targetBytes = 64 * 1024;
  let buffer = "";
  let bufferBytes = 0;
  for (const token of canonicalJsonTokens(value)) {
    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (bufferBytes > 0 && bufferBytes + tokenBytes > targetBytes) {
      yield buffer;
      buffer = "";
      bufferBytes = 0;
    }
    if (tokenBytes > targetBytes && bufferBytes === 0) {
      yield token;
      continue;
    }
    buffer += token;
    bufferBytes += tokenBytes;
  }
  if (bufferBytes > 0) yield buffer;
}

function* canonicalJsonStringTokens(value: string): IterableIterator<string> {
  // One code unit needs at most six UTF-8 bytes after JSON escaping. Bound the
  // native encoder input itself, rather than splitting an already escaped token.
  const maximumCodeUnits = 8192;
  if (value.length <= maximumCodeUnits) {
    yield JSON.stringify(value);
    return;
  }
  yield '"';
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maximumCodeUnits, value.length);
    const last = value.charCodeAt(end - 1);
    if (
      end < value.length &&
      last >= 0xd800 &&
      last <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    ) {
      // A valid pair must reach JSON.stringify together. Lone surrogates keep
      // the native encoder's existing escaped representation.
      end -= 1;
    }
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

function* canonicalJsonTokens(value: JsonValue): IterableIterator<string> {
  if (typeof value === "string") {
    yield* canonicalJsonStringTokens(value);
    return;
  }
  if (value === null || typeof value === "boolean") {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON rejects non-finite numbers");
    }
    yield JSON.stringify(Object.is(value, -0) ? 0 : value);
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      const entry = value[index];
      if (entry === undefined) throw new Error("Canonical JSON array contains an undefined value");
      yield* canonicalJsonTokens(entry);
    }
    yield "]";
    return;
  }
  const object = value as JsonObject;
  yield "{";
  const keys = Object.keys(object).sort(compareCodePoints);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) throw new Error("Canonical JSON object key is unavailable");
    if (index > 0) yield ",";
    yield* canonicalJsonStringTokens(key);
    yield ":";
    yield* canonicalJsonTokens(object[key] ?? null);
  }
  yield "}";
}

export function sha256CanonicalJson(value: JsonValue): string {
  const hash = createHash("sha256");
  for (const chunk of canonicalJsonChunks(value)) hash.update(chunk, "utf8");
  return hash.digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
