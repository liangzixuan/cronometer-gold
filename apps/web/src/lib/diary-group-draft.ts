import {
  type DiaryGroup,
  defaultDiaryGroups,
  type ProfileSummary,
  prepareDiaryGroups,
  quoteRevision,
  type UserSummary,
} from "./diary";

export interface DiaryGroupDraft {
  readonly source: {
    readonly ownerUserId: string;
    readonly profileRevision: string;
  } | null;
  readonly groups: readonly DiaryGroup[];
}

export function emptyDiaryGroupDraft(): DiaryGroupDraft {
  return { source: null, groups: defaultDiaryGroups };
}

export function createDiaryGroupDraft(session: {
  readonly user: Pick<UserSummary, "id">;
  readonly profile: Pick<ProfileSummary, "revision" | "diaryGroups">;
}): DiaryGroupDraft {
  return {
    source: {
      ownerUserId: session.user.id,
      profileRevision: session.profile.revision,
    },
    groups: session.profile.diaryGroups.map((group) => ({ ...group })),
  };
}

/** A refreshed session cannot advance the revision that an existing edit was based on. */
export function prepareDiaryGroupDraftSave(draft: DiaryGroupDraft, currentOwnerUserId: string) {
  if (!draft.source || draft.source.ownerUserId !== currentOwnerUserId) {
    throw new TypeError("Reopen diary group settings before saving them.");
  }
  return {
    ifMatch: quoteRevision(draft.source.profileRevision),
    body: {
      expectedOwnerUserId: draft.source.ownerUserId,
      diaryGroups: prepareDiaryGroups(draft.groups),
    },
  };
}
