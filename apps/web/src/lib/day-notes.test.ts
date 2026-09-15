import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dayNotePath,
  dayNoteText,
  prepareDayNoteOperation,
  readDayNote,
  readDayNoteMutation,
} from "./day-notes";
import {
  mutationFixture,
  noteDate,
  noteFixture,
  noteOwner,
  otherNoteOwner,
} from "./day-notes.test-fixtures";

afterEach(() => vi.unstubAllGlobals());
describe("web day-note adapter", () => {
  it("preserves exact scalar text and maps only the empty field to null", () => {
    const raw = "  e\u0301\r\n\t😀  ";
    expect(dayNoteText(raw)).toBe(raw);
    expect(dayNoteText(" ")).toBe(" ");
    expect(dayNoteText("")).toBeNull();
    expect(dayNoteText("😀".repeat(2_000))).toBe("😀".repeat(2_000));
  });
  it.each(["x".repeat(2_001), "😀".repeat(2_001), "a\u0000b", "\ud800", "\udfff"])(
    "rejects invalid note input without normalization",
    (raw) => {
      expect(() => dayNoteText(raw)).toThrow();
    },
  );
  it("returns a true unchanged no-op before allocating a UUID", () => {
    const uuid = vi.fn(() => "12345678-1234-4234-8234-123456789abc");
    vi.stubGlobal("crypto", { randomUUID: uuid });
    expect(prepareDayNoteOperation(noteFixture(), "", "America/Chicago")).toBeNull();
    expect(
      prepareDayNoteOperation(noteFixture(" raw ", "4"), " raw ", "America/Chicago"),
    ).toBeNull();
    expect(uuid).not.toHaveBeenCalled();
  });
  it("binds complete owner/date/ETag reads and rejects partial or contradictory absence", () => {
    const note = noteFixture();
    expect(readDayNote({ data: note }, '"0"', noteOwner, noteDate)).toEqual(note);
    for (const [value, etag, owner, date] of [
      [{ data: note }, 'W/"0"', noteOwner, noteDate],
      [{ data: note }, '"1"', noteOwner, noteDate],
      [{ data: note }, '"0"', otherNoteOwner, noteDate],
      [{ data: note }, '"0"', noteOwner, "2026-09-16"],
      [{ data: { ...note, note: "contradiction" } }, '"0"', noteOwner, noteDate],
      [{ data: { ...note, extra: true } }, '"0"', noteOwner, noteDate],
    ] as const)
      expect(() => readDayNote(value, etag, owner, date)).toThrow();
    expect(() => dayNotePath("2026-02-30")).toThrow();
  });
  it("requires the full immutable receipt including exact raw text and saved root identity", () => {
    const operation = prepareDayNoteOperation(
      noteFixture("before", "4"),
      " raw\r\n ",
      "America/Chicago",
    );
    if (!operation) throw new Error("operation missing");
    const response = mutationFixture(operation, true);
    expect(readDayNoteMutation(response, '"5"', operation)).toEqual(response);
    for (const identity of [
      { ...operation.identity, note: "raw" },
      { ...operation.identity, noteId: "00000000-0000-4000-8000-000000000001" },
      { ...operation.identity, expectedProfileTimeZone: "America/New_York" },
      { ...operation.identity, localDate: "2026-09-16" },
      { ...operation.identity, ownerUserId: otherNoteOwner },
    ])
      expect(() => readDayNoteMutation(response, '"5"', { ...operation, identity })).toThrow();
    expect(() => readDayNoteMutation(response, null, operation)).toThrow();
    expect(operation.serializedBody).toBe(JSON.stringify({ note: " raw\r\n " }));
  });
});
