import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import type { DiaryPageContinuationRecord } from "@nutrition-tracker/db";

const CURSOR_PREFIX = "d1.";
const MAX_CURSOR_LENGTH = 512;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CONTEXT = "nutrition-tracker/diary-page-cursor/aes-256-gcm/v1";

interface CursorPayload {
  readonly a: string;
  readonly d: string;
  readonly h: string;
  readonly o: number;
  readonly r: string;
  readonly s: "locked" | "open";
  readonly t: string;
  readonly v: 1;
  readonly z: string;
}

export interface DiaryPageCursorBinding {
  readonly userId: string;
  readonly localDate: string;
  readonly limit: number;
}

export class InvalidDiaryPageCursorError extends Error {
  constructor() {
    super("Invalid diary page cursor");
    this.name = "InvalidDiaryPageCursorError";
  }
}

/**
 * Confidential, authenticated continuation tokens. Owner/date/limit are authenticated as
 * associated data and are deliberately absent from the client-visible ciphertext.
 */
export class DiaryPageCursorCodec {
  readonly #key: Buffer;

  constructor(secret: string | Uint8Array) {
    const material =
      typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
    if (material.byteLength < 32) {
      throw new TypeError("cursor secret must contain at least 32 bytes");
    }
    this.#key = createHmac("sha256", material).update(KEY_CONTEXT, "utf8").digest();
  }

  encode(continuation: DiaryPageContinuationRecord, binding: DiaryPageCursorBinding): string {
    assertBinding(binding);
    if (!isContinuation(continuation)) {
      throw new TypeError("diary continuation is invalid");
    }
    const payload: CursorPayload = {
      a: continuation.updatedAtMicroseconds,
      d: continuation.dayId,
      h: continuation.snapshotDigest,
      o: continuation.offset,
      r: continuation.dayRevision,
      s: continuation.status,
      t: continuation.tailEntryId,
      v: 1,
      z: continuation.timeZone,
    };
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(binding));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const token = `${CURSOR_PREFIX}${Buffer.concat([
      nonce,
      encrypted,
      cipher.getAuthTag(),
    ]).toString("base64url")}`;
    if (token.length > MAX_CURSOR_LENGTH) {
      throw new TypeError("diary cursor exceeds its transport bound");
    }
    return token;
  }

  decode(token: string, binding: DiaryPageCursorBinding): DiaryPageContinuationRecord {
    assertBinding(binding);
    if (
      token.length < CURSOR_PREFIX.length + 1 ||
      token.length > MAX_CURSOR_LENGTH ||
      !/^d1\.[A-Za-z0-9_-]+$/u.test(token)
    ) {
      throw new InvalidDiaryPageCursorError();
    }
    const encoded = token.slice(CURSOR_PREFIX.length);
    let sealed: Buffer;
    try {
      sealed = Buffer.from(encoded, "base64url");
    } catch {
      throw new InvalidDiaryPageCursorError();
    }
    if (sealed.toString("base64url") !== encoded || sealed.length <= NONCE_BYTES + TAG_BYTES) {
      throw new InvalidDiaryPageCursorError();
    }
    const nonce = sealed.subarray(0, NONCE_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const encrypted = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
    let parsed: unknown;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(associatedData(binding));
      decipher.setAuthTag(tag);
      parsed = JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
      );
    } catch {
      throw new InvalidDiaryPageCursorError();
    }
    if (!isCursorPayload(parsed)) throw new InvalidDiaryPageCursorError();
    return {
      dayId: parsed.d,
      dayRevision: parsed.r,
      offset: parsed.o,
      snapshotDigest: parsed.h,
      status: parsed.s,
      tailEntryId: parsed.t,
      timeZone: parsed.z,
      updatedAtMicroseconds: parsed.a,
    };
  }
}

function associatedData(binding: DiaryPageCursorBinding): Buffer {
  return Buffer.from(JSON.stringify([1, binding.userId, binding.localDate, binding.limit]), "utf8");
}

function assertBinding(binding: DiaryPageCursorBinding): void {
  if (
    binding.userId.length < 1 ||
    !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(binding.localDate) ||
    !Number.isSafeInteger(binding.limit) ||
    binding.limit < 1 ||
    binding.limit > 20
  ) {
    throw new TypeError("diary cursor binding is invalid");
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isContinuation(value: DiaryPageContinuationRecord): boolean {
  return (
    isUuid(value.dayId) &&
    isUuid(value.tailEntryId) &&
    /^[1-9][0-9]{0,19}$/u.test(value.dayRevision) &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 1 &&
    value.offset <= 50 &&
    /^[0-9a-f]{64}$/u.test(value.snapshotDigest) &&
    ["locked", "open"].includes(value.status) &&
    value.timeZone.length >= 1 &&
    value.timeZone.length <= 100 &&
    isCanonicalPostgresMicrosecondInstant(value.updatedAtMicroseconds)
  );
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<CursorPayload>;
  return (
    Object.keys(value).length === 9 &&
    candidate.v === 1 &&
    typeof candidate.a === "string" &&
    isCanonicalPostgresMicrosecondInstant(candidate.a) &&
    isUuid(candidate.d) &&
    typeof candidate.h === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.h) &&
    isUuid(candidate.t) &&
    typeof candidate.r === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(candidate.r) &&
    typeof candidate.o === "number" &&
    Number.isSafeInteger(candidate.o) &&
    candidate.o >= 1 &&
    candidate.o <= 50 &&
    (candidate.s === "locked" || candidate.s === "open") &&
    typeof candidate.z === "string" &&
    candidate.z.length >= 1 &&
    candidate.z.length <= 100
  );
}

function isCanonicalPostgresMicrosecondInstant(value: string): boolean {
  if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(value)) {
    return false;
  }
  const millisecondInstant = `${value.slice(0, 23)}Z`;
  const milliseconds = Date.parse(millisecondInstant);
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === millisecondInstant
  );
}
