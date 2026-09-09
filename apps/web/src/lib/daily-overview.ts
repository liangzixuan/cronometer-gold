import type { ActivityDay } from "./activity";
import type { HydrationDay } from "./hydration";
import { HYDRATION_OWNER_CHANGED_CODE } from "./hydration";

export type DailyOverviewCardState =
  | { readonly status: "loading" }
  | { readonly status: "empty"; readonly count: 0; readonly total: 0 }
  | { readonly status: "ready"; readonly count: number; readonly total: number }
  | { readonly status: "error"; readonly message: string };

export interface DailyOverviewRequestIdentity {
  readonly ownerUserId: string;
  readonly profileRevision: string;
  readonly profileTimeZone: string;
  readonly localDate: string;
  readonly sessionGeneration: number;
  readonly requestGeneration: number;
}

export interface DailyOverviewScopedCardState {
  readonly identity: DailyOverviewRequestIdentity | null;
  readonly card: DailyOverviewCardState;
}

interface DailyOverviewSessionIdentity {
  readonly user: { readonly id: string };
  readonly profile: { readonly revision: string; readonly timeZone: string };
}

interface DailyOverviewResponseIdentity {
  readonly localDate: string;
  readonly timeZone: string;
}

export type DailyOverviewFenceResult =
  | "current"
  | "stale"
  | "owner-changed"
  | "profile-changed"
  | "response-mismatch";

export function dailyOverviewRequiresPrivateUiClosure(
  kind: "hydration" | "activity",
  status: number,
  code: string | null,
): boolean {
  return (
    status === 401 ||
    (status === 409 &&
      ((kind === "activity" && code === "ACTIVITY_OWNER_CHANGED") ||
        (kind === "hydration" && code === HYDRATION_OWNER_CHANGED_CODE)))
  );
}

export function loadingDailyOverviewCard(): DailyOverviewCardState {
  return { status: "loading" };
}

export function failedDailyOverviewCard(message: string): DailyOverviewCardState {
  return { status: "error", message };
}

export function hydrationDailyOverviewCard(day: HydrationDay): DailyOverviewCardState {
  if (day.entries.length === 0) return { status: "empty", count: 0, total: 0 };
  return {
    status: "ready",
    count: day.entries.length,
    total: day.totalMilliliters,
  };
}

export function activityDailyOverviewCard(day: ActivityDay): DailyOverviewCardState {
  if (day.entries.length === 0) return { status: "empty", count: 0, total: 0 };
  return {
    status: "ready",
    count: day.entries.length,
    total: day.totalDurationMinutes,
  };
}

export function dailyOverviewRequestMatches(
  expected: DailyOverviewRequestIdentity,
  current: DailyOverviewRequestIdentity | null,
): boolean {
  return (
    current !== null &&
    current.ownerUserId === expected.ownerUserId &&
    current.profileRevision === expected.profileRevision &&
    current.profileTimeZone === expected.profileTimeZone &&
    current.localDate === expected.localDate &&
    current.sessionGeneration === expected.sessionGeneration &&
    current.requestGeneration === expected.requestGeneration
  );
}

export function scopedDailyOverviewCard(
  identity: DailyOverviewRequestIdentity | null,
  card: DailyOverviewCardState,
): DailyOverviewScopedCardState {
  return { identity, card };
}

/** Never render a summary under coordinates other than those that loaded it. */
export function dailyOverviewCardForIdentity(
  scoped: DailyOverviewScopedCardState,
  current: DailyOverviewRequestIdentity | null,
): DailyOverviewCardState {
  return scoped.identity && dailyOverviewRequestMatches(scoped.identity, current)
    ? scoped.card
    : loadingDailyOverviewCard();
}

/**
 * Private day summaries are installable only after the server session and every
 * local request coordinate still agree with the request that initiated them.
 */
export function dailyOverviewFence(input: {
  readonly expected: DailyOverviewRequestIdentity;
  readonly current: DailyOverviewRequestIdentity | null;
  readonly revalidatedSession: DailyOverviewSessionIdentity;
  readonly response: DailyOverviewResponseIdentity;
}): DailyOverviewFenceResult {
  if (input.revalidatedSession.user.id !== input.expected.ownerUserId) {
    return "owner-changed";
  }
  if (
    input.revalidatedSession.profile.revision !== input.expected.profileRevision ||
    input.revalidatedSession.profile.timeZone !== input.expected.profileTimeZone
  ) {
    return "profile-changed";
  }
  if (
    input.response.localDate !== input.expected.localDate ||
    input.response.timeZone !== input.expected.profileTimeZone
  ) {
    return "response-mismatch";
  }
  return dailyOverviewRequestMatches(input.expected, input.current) ? "current" : "stale";
}
