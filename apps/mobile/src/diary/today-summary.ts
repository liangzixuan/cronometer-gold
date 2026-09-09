import { isLocalDate, localDateInTimeZone } from "./diary";

export type TodaySummaryKind = "hydration" | "activity";

export interface TodayHydrationSummary {
  readonly localDate: string;
  readonly timeZone: string;
  readonly entryCount: number;
  readonly totalMilliliters: number;
}

export interface TodayActivitySummary {
  readonly localDate: string;
  readonly timeZone: string;
  readonly entryCount: number;
  readonly totalDurationMinutes: number;
}

export interface TodaySummaryLoadingCard {
  readonly status: "loading";
  readonly summary: null;
}

export interface TodaySummaryErrorCard {
  readonly status: "error";
  readonly summary: null;
  readonly message: string;
}

export type TodaySummaryCard<T> =
  | TodaySummaryLoadingCard
  | { readonly status: "ready" | "empty"; readonly summary: T }
  | TodaySummaryErrorCard;

export interface TodaySupportingSummaries {
  readonly hydration: TodayScopedSummaryCard<TodayHydrationSummary> | null;
  readonly activity: TodayScopedSummaryCard<TodayActivitySummary> | null;
}

export interface TodaySummaryRequestIdentity {
  readonly kind: TodaySummaryKind;
  readonly ownerUserId: string;
  readonly sessionEpoch: number;
  readonly profileRevision: string;
  readonly profileTimeZone: string;
  readonly localDate: string;
  readonly refreshKey: number;
}

export interface TodaySummaryRequestFence extends TodaySummaryRequestIdentity {
  readonly generation: number;
}

export interface TodayScopedSummaryCard<T> {
  readonly fence: TodaySummaryRequestFence;
  readonly card: TodaySummaryCard<T>;
}

export type TodaySummaryReplacement =
  | {
      readonly kind: "hydration";
      readonly card: TodaySummaryCard<TodayHydrationSummary>;
    }
  | {
      readonly kind: "activity";
      readonly card: TodaySummaryCard<TodayActivitySummary>;
    };

export function loadingTodaySummaryCard(): TodaySummaryLoadingCard {
  return { status: "loading", summary: null };
}

export function loadingTodaySupportingSummaries(): TodaySupportingSummaries {
  return {
    hydration: null,
    activity: null,
  };
}

export function beginTodaySupportingSummaryLoad(
  state: TodaySupportingSummaries,
  fence: TodaySummaryRequestFence,
): TodaySupportingSummaries {
  const scoped = { fence, card: loadingTodaySummaryCard() };
  return fence.kind === "hydration"
    ? { ...state, hydration: scoped }
    : { ...state, activity: scoped };
}

export function todaySummaryError(message: string): TodaySummaryErrorCard {
  return { status: "error", summary: null, message };
}

export function replaceTodaySupportingSummary(
  state: TodaySupportingSummaries,
  fence: TodaySummaryRequestFence,
  replacement: TodaySummaryReplacement,
): TodaySupportingSummaries {
  if (fence.kind !== replacement.kind) return state;
  return replacement.kind === "hydration"
    ? { ...state, hydration: { fence, card: replacement.card } }
    : { ...state, activity: { fence, card: replacement.card } };
}

export function acceptTodaySupportingSummary(
  state: TodaySupportingSummaries,
  started: TodaySummaryRequestFence,
  current: TodaySummaryRequestIdentity,
  currentGeneration: number,
  replacement: TodaySummaryReplacement,
): TodaySupportingSummaries {
  return todaySummaryRequestMatches(started, current, currentGeneration)
    ? replaceTodaySupportingSummary(state, started, replacement)
    : state;
}

export function todaySummaryCardForRender<T>(
  stored: TodayScopedSummaryCard<T> | null,
  current: TodaySummaryRequestIdentity,
  currentGeneration: number,
): TodaySummaryCard<T> {
  return stored && todaySummaryRequestMatches(stored.fence, current, currentGeneration)
    ? stored.card
    : loadingTodaySummaryCard();
}

export function hydrationTodaySummary(day: {
  readonly localDate: string;
  readonly timeZone: string;
  readonly entries: readonly unknown[];
  readonly totalMilliliters: number;
}): TodaySummaryCard<TodayHydrationSummary> {
  const summary = {
    localDate: day.localDate,
    timeZone: day.timeZone,
    entryCount: day.entries.length,
    totalMilliliters: day.totalMilliliters,
  };
  return { status: summary.entryCount === 0 ? "empty" : "ready", summary };
}

export function activityTodaySummary(day: {
  readonly localDate: string;
  readonly timeZone: string;
  readonly entries: readonly unknown[];
  readonly totalDurationMinutes: number;
}): TodaySummaryCard<TodayActivitySummary> {
  const summary = {
    localDate: day.localDate,
    timeZone: day.timeZone,
    entryCount: day.entries.length,
    totalDurationMinutes: day.totalDurationMinutes,
  };
  return { status: summary.entryCount === 0 ? "empty" : "ready", summary };
}

export function todaySummaryRequestMatches(
  started: TodaySummaryRequestFence,
  current: TodaySummaryRequestIdentity,
  currentGeneration: number,
): boolean {
  return (
    started.generation === currentGeneration &&
    started.kind === current.kind &&
    started.ownerUserId === current.ownerUserId &&
    started.sessionEpoch === current.sessionEpoch &&
    started.profileRevision === current.profileRevision &&
    started.profileTimeZone === current.profileTimeZone &&
    started.localDate === current.localDate &&
    started.refreshKey === current.refreshKey
  );
}

export function isTodayActivityOwnerChangedProblem(status: number, value: unknown): boolean {
  return (
    status === 409 &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "code" in value &&
    value.code === "ACTIVITY_OWNER_CHANGED"
  );
}

export function todaySupportingSummaryPath(kind: TodaySummaryKind, localDate: string): string {
  if (!isLocalDate(localDate)) throw new TypeError("A real local date is required.");
  const date = encodeURIComponent(localDate);
  return kind === "hydration" ? `/v1/hydration?date=${date}` : `/v1/activities?date=${date}`;
}

export function todayDetailDate(
  requestedDate: string | undefined,
  profileTimeZone: string,
  now = new Date(),
): string {
  return requestedDate && isLocalDate(requestedDate)
    ? requestedDate
    : localDateInTimeZone(now, profileTimeZone);
}

export function todayDetailRouteParams(localDate: string): { readonly date: string } {
  if (!isLocalDate(localDate)) throw new TypeError("A real local date is required.");
  return { date: localDate };
}
