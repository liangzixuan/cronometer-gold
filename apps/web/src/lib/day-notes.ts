import {
  type DayNote,
  type DayNoteMutationResponse,
  type DayNoteWriteIdentity,
  isDayNoteText,
  matchesDayNoteMutation,
  parseDayNoteMutationResponse,
  parseDayNoteResponse,
} from "@nutrition-tracker/contracts";

import { createOperationId, isLocalDate } from "./diary";

export type { DayNote };

export function dayNotePath(date: string): string {
  if (!isLocalDate(date)) throw new TypeError("Choose a valid note date.");
  return `/api/diary/day-notes/${date}`;
}

export function dayNoteText(raw: string): string | null {
  const value = raw === "" ? null : raw;
  if (!isDayNoteText(value)) {
    throw new TypeError("Use up to 2,000 characters without invalid or null characters.");
  }
  return value;
}

export function readDayNote(
  value: unknown,
  etag: string | null,
  ownerUserId: string,
  localDate: string,
): DayNote {
  const note = parseDayNoteResponse(value).data;
  if (
    note.ownerUserId !== ownerUserId ||
    note.localDate !== localDate ||
    etag !== `"${note.revision}"`
  ) {
    throw new TypeError("The note response did not match this account and date.");
  }
  return note;
}

export interface DayNoteOperation {
  readonly identity: DayNoteWriteIdentity;
  readonly url: string;
  readonly serializedBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function prepareDayNoteOperation(
  base: DayNote,
  raw: string,
  timeZone: string,
): DayNoteOperation | null {
  const note = dayNoteText(raw);
  if (note === base.note) return null;
  const identity: DayNoteWriteIdentity = {
    operationId: createOperationId(),
    ownerUserId: base.ownerUserId,
    localDate: base.localDate,
    expectedRevision: base.revision,
    expectedProfileTimeZone: timeZone,
    note,
    noteId: base.id,
  };
  return {
    identity,
    url: dayNotePath(base.localDate),
    serializedBody: JSON.stringify({ note }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-expected-owner-user-id": base.ownerUserId,
      "x-expected-profile-time-zone": timeZone,
      "if-match": `"${base.revision}"`,
      "idempotency-key": identity.operationId,
    },
  };
}

export function readDayNoteMutation(
  value: unknown,
  etag: string | null,
  operation: DayNoteOperation,
): DayNoteMutationResponse {
  const response = parseDayNoteMutationResponse(value);
  if (
    !matchesDayNoteMutation(response, operation.identity) ||
    etag !== `"${response.data.note.revision}"`
  ) {
    throw new TypeError("The note receipt did not match the saved request.");
  }
  return response;
}
