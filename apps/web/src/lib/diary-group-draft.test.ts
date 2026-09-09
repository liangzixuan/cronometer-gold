import { describe, expect, it } from "vitest";

import { type DailyOverviewRequestIdentity, dailyOverviewFence } from "./daily-overview";
import { defaultDiaryGroups, moveDiaryGroup } from "./diary";
import {
  createDiaryGroupDraft,
  emptyDiaryGroupDraft,
  prepareDiaryGroupDraftSave,
} from "./diary-group-draft";

const initialSession = {
  user: { id: "5e041a5d-00e7-4260-832a-90e34a04e60a" },
  profile: { revision: "7", timeZone: "America/Chicago", diaryGroups: defaultDiaryGroups },
};

describe("diary group edit revision", () => {
  it("keeps an open edit on its original revision when delayed overview revalidation refreshes the profile", async () => {
    const draft = createDiaryGroupDraft(initialSession);
    const edited = {
      ...draft,
      groups: draft.groups.map((group) =>
        group.mealSlot === "breakfast" ? { ...group, label: "Morning" } : group,
      ),
    };
    const expected: DailyOverviewRequestIdentity = {
      ownerUserId: initialSession.user.id,
      profileRevision: initialSession.profile.revision,
      profileTimeZone: initialSession.profile.timeZone,
      localDate: "2026-09-09",
      sessionGeneration: 0,
      requestGeneration: 1,
    };
    let resolveProfile!: (session: typeof refreshedSession) => void;
    const refreshedSession = {
      ...initialSession,
      profile: {
        ...initialSession.profile,
        revision: "8",
        diaryGroups: initialSession.profile.diaryGroups.map((group) =>
          group.mealSlot === "dinner" ? { ...group, label: "Evening" } : group,
        ),
      },
    };
    const delayedProfile = new Promise<typeof refreshedSession>((resolve) => {
      resolveProfile = resolve;
    });
    resolveProfile(refreshedSession);
    const revalidatedSession = await delayedProfile;
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession,
        response: { localDate: expected.localDate, timeZone: expected.profileTimeZone },
      }),
    ).toBe("profile-changed");

    const save = prepareDiaryGroupDraftSave(edited, revalidatedSession.user.id);
    // The server must see revision 7 and return its normal 412, preserving the other edit.
    expect(save.ifMatch).toBe('"7"');
    expect(save.ifMatch).not.toBe(`"${revalidatedSession.profile.revision}"`);
    expect(save.body.diaryGroups.map((group) => group.label)).toEqual([
      "Morning",
      "Lunch",
      "Dinner",
      "Snacks",
    ]);

    const reconciled = createDiaryGroupDraft(revalidatedSession);
    const nextEdit = { ...reconciled, groups: moveDiaryGroup(reconciled.groups, 0, 1) };
    expect(prepareDiaryGroupDraftSave(nextEdit, revalidatedSession.user.id)).toMatchObject({
      ifMatch: '"8"',
      body: { diaryGroups: expect.arrayContaining([{ mealSlot: "dinner", label: "Evening" }]) },
    });
  });

  it("retains the original precondition when resetting groups and refuses unbound or different-owner drafts", () => {
    const draft = createDiaryGroupDraft(initialSession);
    const reset = { ...draft, groups: defaultDiaryGroups };
    expect(prepareDiaryGroupDraftSave(reset, initialSession.user.id).ifMatch).toBe('"7"');
    expect(() =>
      prepareDiaryGroupDraftSave(emptyDiaryGroupDraft(), initialSession.user.id),
    ).toThrow("Reopen diary group settings");
    expect(() => prepareDiaryGroupDraftSave(draft, "another-owner")).toThrow(
      "Reopen diary group settings",
    );
  });
});
