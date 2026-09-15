import type { DayNote } from "@nutrition-tracker/contracts";

import type { DayNoteOperation } from "./day-notes";
import { defaultDiaryGroups } from "./diary";

export const noteOwner = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
export const otherNoteOwner = "5f5536b9-0f35-44e8-9a77-c26679d7b21b";
export const noteId = "12345678-1234-4234-8234-123456789abc";
export const noteDate = "2026-09-15";
export function noteFixture(
  note: string | null = null,
  revision = "0",
  localDate = noteDate,
  ownerUserId = noteOwner,
): DayNote {
  return {
    ownerUserId,
    localDate,
    id: revision === "0" ? null : noteId,
    revision,
    note,
    recordedTimeZone: revision === "0" ? null : "America/Chicago",
    createdAt: revision === "0" ? null : "2026-09-15T10:00:00.000Z",
    updatedAt: revision === "0" ? null : "2026-09-15T11:00:00.000Z",
  };
}
export function noteResponse(note: DayNote) {
  return Response.json({ data: note }, { headers: { etag: `"${note.revision}"` } });
}
export function mutationFixture(operation: DayNoteOperation, replayed = false) {
  const identity = operation.identity;
  const revision = String(BigInt(identity.expectedRevision) + 1n);
  const note = {
    ...noteFixture(identity.note, revision, identity.localDate, identity.ownerUserId),
    recordedTimeZone: identity.expectedProfileTimeZone,
  };
  return {
    data: {
      replayed,
      note,
      receipt: {
        protocol: "diary-day-note-v1",
        operationId: identity.operationId,
        ownerUserId: identity.ownerUserId,
        localDate: identity.localDate,
        expectedRevision: identity.expectedRevision,
        expectedProfileTimeZone: identity.expectedProfileTimeZone,
        resultRevision: revision,
      },
    },
  };
}
export function noteSession(id = noteOwner, zone = "America/Chicago") {
  return {
    data: {
      user: { id, email: "owner@example.test", emailVerified: true },
      profile: {
        displayName: "Owner",
        birthDate: null,
        sexAtBirth: "not_specified",
        heightCm: null,
        baselineWeightKg: null,
        activityLevelCode: null,
        locale: "en-US",
        timeZone: zone,
        unitSystem: "metric",
        onboardingCompletedAt: null,
        revision: "1",
        diaryGroups: defaultDiaryGroups,
      },
    },
  };
}
