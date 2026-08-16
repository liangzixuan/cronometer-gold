import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { compareDeterministicText } from "./deterministic.js";
import { InvalidCursorError } from "./errors.js";
import type {
  FoodSearchPreferences,
  NormalizedFoodSearchQuery,
  RecentFoodPreference,
} from "./types.js";

interface CursorPayload {
  readonly f: string;
  readonly g: string;
  readonly o: number;
  readonly v: 2;
}

export interface FoodSearchCursorState {
  readonly generation: string;
  readonly offset: number;
}

export interface FoodSearchCursorCodecOptions {
  /** At least 32 bytes of independently generated secret material. */
  readonly secret: string | Uint8Array;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function canonicalRecentFoods(
  recentFoods: readonly RecentFoodPreference[] | undefined,
): readonly [string, string][] {
  const latestByFood = new Map<string, string>();
  for (const recent of recentFoods ?? []) {
    const timestamp = Date.parse(recent.lastUsedAt);
    if (recent.foodId.length === 0 || !Number.isFinite(timestamp)) {
      continue;
    }
    const canonicalTimestamp = new Date(timestamp).toISOString();
    const previous = latestByFood.get(recent.foodId);
    if (previous === undefined || canonicalTimestamp > previous) {
      latestByFood.set(recent.foodId, canonicalTimestamp);
    }
  }
  return [...latestByFood.entries()].sort(([leftId], [rightId]) =>
    compareDeterministicText(leftId, rightId),
  );
}

/** Hash preferences so cursors bind to ranking state without containing raw catalogue IDs. */
export function fingerprintPreferences(preferences: FoodSearchPreferences | undefined): string {
  const favorites = [...new Set(preferences?.favoriteFoodIds ?? [])]
    .filter((foodId) => foodId.length > 0)
    .sort(compareDeterministicText);
  const recent = canonicalRecentFoods(preferences?.recentFoods);
  return sha256(JSON.stringify({ favorites, recent }));
}

export function fingerprintSearchQuery(
  query: NormalizedFoodSearchQuery,
  preferences: FoodSearchPreferences | undefined,
): string {
  return sha256(
    JSON.stringify({
      barcode: query.barcode,
      intent: query.intent,
      languageTag: query.languageTag,
      limit: query.limit,
      marketCode: query.marketCode,
      preferences: fingerprintPreferences(preferences),
      query: query.query.toLocaleLowerCase("und"),
    }),
  );
}

export class FoodSearchCursorCodec {
  readonly #secret: Uint8Array;

  constructor(options: FoodSearchCursorCodecOptions) {
    this.#secret =
      typeof options.secret === "string"
        ? new TextEncoder().encode(options.secret)
        : new Uint8Array(options.secret);
    if (this.#secret.byteLength < 32) {
      throw new TypeError("cursor secret must contain at least 32 bytes");
    }
  }

  encode(offset: number, fingerprint: string, generation: string): string {
    if (!Number.isSafeInteger(offset) || offset < 1) {
      throw new TypeError("cursor offset must be a positive safe integer");
    }
    if (!/^[A-Za-z0-9_-]{1,400}$/u.test(generation)) {
      throw new TypeError("cursor generation contains unsupported characters");
    }
    const payload = Buffer.from(
      JSON.stringify({ f: fingerprint, g: generation, o: offset, v: 2 }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.#secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  decode(token: string, expectedFingerprint: string): FoodSearchCursorState {
    const [payload, signature, extra] = token.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new InvalidCursorError();
    }
    const expectedSignature = createHmac("sha256", this.#secret)
      .update(payload)
      .digest("base64url");
    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expectedSignature);
    if (
      signatureBytes.length !== expectedBytes.length ||
      !timingSafeEqual(signatureBytes, expectedBytes)
    ) {
      throw new InvalidCursorError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new InvalidCursorError();
    }
    if (!isCursorPayload(parsed) || parsed.f !== expectedFingerprint) {
      throw new InvalidCursorError();
    }
    return { generation: parsed.g, offset: parsed.o };
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CursorPayload>;
  return (
    candidate.v === 2 &&
    typeof candidate.f === "string" &&
    typeof candidate.g === "string" &&
    /^[A-Za-z0-9_-]{1,400}$/u.test(candidate.g) &&
    typeof candidate.o === "number" &&
    Number.isSafeInteger(candidate.o) &&
    candidate.o > 0 &&
    Object.keys(value).length === 4
  );
}
