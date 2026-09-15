import { Ajv } from "ajv";
import * as formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  dayNoteResponseSchema,
  isDayNoteText,
  matchesDayNoteMutation,
  parseDayNoteMutationResponse,
  parseDayNoteResponse,
  putDayNoteRequestSchema,
} from "./day-notes.js";

const owner = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000001";
const operationId = "30000000-0000-4000-8000-000000000001";
const saved = {
  ownerUserId: owner,
  localDate: "2026-09-15",
  id,
  revision: "1",
  note: "  e\u0301\r\n🙂  ",
  recordedTimeZone: "America/Chicago",
  createdAt: "2026-09-15T16:00:00.000Z",
  updatedAt: "2026-09-15T16:00:00.000Z",
};
const identity = {
  operationId,
  ownerUserId: owner,
  localDate: saved.localDate,
  expectedRevision: "0",
  expectedProfileTimeZone: "America/Chicago",
  note: saved.note,
  noteId: null,
};
const result = {
  data: {
    replayed: false,
    note: saved,
    receipt: {
      protocol: "diary-day-note-v1",
      operationId,
      ownerUserId: owner,
      localDate: saved.localDate,
      expectedRevision: "0",
      expectedProfileTimeZone: "America/Chicago",
      resultRevision: "1",
    },
  },
};

describe("private day-note contract", () => {
  it("preserves exact raw text and bounds Unicode scalars without normalization", () => {
    const ajv = new Ajv({ strict: true });
    (formats.default as unknown as (value: Ajv) => Ajv)(ajv);
    const validate = ajv.compile(putDayNoteRequestSchema);
    for (const note of [null, saved.note, " \n\t", "🙂".repeat(2000)]) {
      expect(validate({ note })).toBe(true);
      expect(isDayNoteText(note)).toBe(true);
    }
    for (const note of ["", "x\u0000", "\ud800", "\udfff", "🙂".repeat(2001), 1]) {
      expect(validate({ note })).toBe(false);
      expect(isDayNoteText(note)).toBe(false);
    }
    expect(validate({ note: "text", ownerUserId: owner })).toBe(false);
    expect(parseDayNoteResponse({ data: saved }).data.note).toBe(saved.note);
  });
  it("distinguishes virgin absence from cleared positive history and rejects incoherent snapshots", () => {
    const absent = {
      ...saved,
      id: null,
      revision: "0",
      note: null,
      recordedTimeZone: null,
      createdAt: null,
      updatedAt: null,
    };
    const ajv = new Ajv({ strict: true });
    (formats.default as unknown as (value: Ajv) => Ajv)(ajv);
    const validate = ajv.compile(dayNoteResponseSchema);
    for (const note of [saved, absent, { ...saved, revision: "2", note: null }]) {
      expect(validate({ data: note })).toBe(true);
      expect(parseDayNoteResponse({ data: note }).data).toEqual(note);
    }
    for (const note of [
      { ...absent, id },
      { ...saved, id: null },
      { ...saved, localDate: "2026-02-30" },
      { ...saved, revision: "01" },
      { ...saved, revision: "9223372036854775808" },
      { ...saved, recordedTimeZone: "Missing/Zone" },
      { ...saved, currentProfileTimeZone: "UTC" },
      { ...saved, updatedAt: "2026-09-14T16:00:00.000Z" },
    ]) {
      expect(() => parseDayNoteResponse({ data: note })).toThrow(TypeError);
    }
  });
  it("binds exact historical receipts to their initiating identity without claiming current state", () => {
    const parsed = parseDayNoteMutationResponse(result);
    expect(matchesDayNoteMutation(parsed, identity)).toBe(true);
    expect(matchesDayNoteMutation({ data: { ...parsed.data, replayed: true } }, identity)).toBe(
      true,
    );
    for (const other of [
      { ...identity, note: saved.note.normalize("NFC") },
      { ...identity, expectedProfileTimeZone: "UTC" },
      { ...identity, expectedRevision: "1" },
      { ...identity, localDate: "2026-09-16" },
      { ...identity, ownerUserId: id },
      { ...identity, operationId: id },
      { ...identity, noteId: id },
    ])
      expect(matchesDayNoteMutation(parsed, other)).toBe(false);
    for (const receipt of [
      { ...result.data.receipt, resultRevision: "2" },
      { ...result.data.receipt, ownerUserId: id },
      { ...result.data.receipt, protocol: "another-v1" },
      { ...result.data.receipt, expectedProfileTimeZone: "UTC" },
    ])
      expect(() => parseDayNoteMutationResponse({ data: { ...result.data, receipt } })).toThrow(
        TypeError,
      );
    const exact = {
      data: {
        ...result.data,
        note: { ...saved, revision: "9223372036854775807" },
        receipt: {
          ...result.data.receipt,
          expectedRevision: "9223372036854775806",
          resultRevision: "9223372036854775807",
        },
      },
    };
    expect(parseDayNoteMutationResponse(exact).data.note.revision).toBe("9223372036854775807");
  });
});
