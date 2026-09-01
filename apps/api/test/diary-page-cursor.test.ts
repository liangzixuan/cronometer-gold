import { describe, expect, it } from "vitest";

import {
  DiaryPageCursorCodec,
  InvalidDiaryPageCursorError,
} from "../src/modules/diary/diary-page-cursor.js";

const secret = "diary-page-cursor-test-secret-with-at-least-32-bytes";
const continuation = {
  dayId: "10000000-0000-4000-8000-000000000001",
  dayRevision: "45",
  offset: 20,
  snapshotDigest: "a".repeat(64),
  status: "open",
  tailEntryId: "20000000-0000-4000-8000-000000000020",
  timeZone: "America/Chicago",
  updatedAtMicroseconds: "2026-08-16T12:00:00.000123Z",
} as const;
const binding = {
  userId: "30000000-0000-4000-8000-000000000001",
  localDate: "2026-08-16",
  limit: 20,
} as const;

describe("diary page cursor codec", () => {
  it("round-trips bounded confidential continuation state with a fresh nonce", () => {
    const codec = new DiaryPageCursorCodec(secret);
    const first = codec.encode(continuation, binding);
    const second = codec.encode(continuation, binding);

    expect(first).toMatch(/^d1\.[A-Za-z0-9_-]+$/u);
    expect(first.length).toBeLessThanOrEqual(512);
    expect(second).not.toBe(first);
    expect(codec.decode(first, binding)).toEqual(continuation);
    const sealedBytes = Buffer.from(first.slice(3), "base64url").toString("utf8");
    expect(sealedBytes).not.toContain(continuation.dayId);
    expect(sealedBytes).not.toContain(continuation.snapshotDigest);
    expect(sealedBytes).not.toContain(continuation.timeZone);
    expect(sealedBytes).not.toContain(continuation.updatedAtMicroseconds);
    expect(first).not.toContain(binding.userId);
    expect(first).not.toContain(binding.localDate);
  });

  it.each([
    { ...binding, userId: "30000000-0000-4000-8000-000000000002" },
    { ...binding, localDate: "2026-08-17" },
    { ...binding, limit: 19 },
  ])("rejects a cursor replayed under another authenticated binding", (wrongBinding) => {
    const codec = new DiaryPageCursorCodec(secret);
    const token = codec.encode(continuation, binding);
    expect(() => codec.decode(token, wrongBinding)).toThrow(InvalidDiaryPageCursorError);
  });

  it("rejects tampering, malformed encodings, and undersized key material", () => {
    const codec = new DiaryPageCursorCodec(secret);
    const token = codec.encode(continuation, binding);
    const replacement = token.endsWith("A") ? "B" : "A";

    expect(() => codec.decode(`${token.slice(0, -1)}${replacement}`, binding)).toThrow(
      InvalidDiaryPageCursorError,
    );
    expect(() => codec.decode("d1.not+base64url", binding)).toThrow(InvalidDiaryPageCursorError);
    expect(() => codec.decode(`d1.${"A".repeat(509)}`, binding)).toThrow(
      InvalidDiaryPageCursorError,
    );
    expect(() => new DiaryPageCursorCodec("too-short")).toThrow(TypeError);
    expect(() =>
      codec.encode({ ...continuation, updatedAtMicroseconds: "2026-08-16T12:00:00.000Z" }, binding),
    ).toThrow(TypeError);
    expect(() =>
      codec.encode({ ...continuation, snapshotDigest: "A".repeat(64) }, binding),
    ).toThrow(TypeError);
  });
});
