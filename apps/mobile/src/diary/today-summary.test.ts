import { describe, expect, it } from "vitest";

import { localDateInTimeZone, shiftLocalDate } from "./diary";
import {
  acceptTodaySupportingSummary,
  activityTodaySummary,
  beginTodaySupportingSummaryLoad,
  hydrationTodaySummary,
  isTodayActivityOwnerChangedProblem,
  loadingTodaySupportingSummaries,
  replaceTodaySupportingSummary,
  type TodaySummaryRequestFence,
  type TodaySummaryRequestIdentity,
  todayDetailDate,
  todayDetailRouteParams,
  todaySummaryCardForRender,
  todaySummaryError,
  todaySummaryRequestMatches,
  todaySupportingSummaryPath,
} from "./today-summary";

const identity: TodaySummaryRequestIdentity = {
  kind: "hydration",
  ownerUserId: "4afda2f8-e150-40ed-88f1-a327cd5e2430",
  sessionEpoch: 7,
  profileRevision: "12",
  profileTimeZone: "America/Chicago",
  localDate: "2026-03-08",
  refreshKey: 3,
};

const fence: TodaySummaryRequestFence = {
  ...identity,
  generation: 4,
};

describe("mobile coordinated Today helpers", () => {
  it("preserves the exact selected local date in both detail paths and route params", () => {
    expect(todayDetailRouteParams("2026-03-08")).toEqual({ date: "2026-03-08" });
    expect(todaySupportingSummaryPath("hydration", "2026-03-08")).toBe(
      "/v1/hydration?date=2026-03-08",
    );
    expect(todaySupportingSummaryPath("activity", "2026-03-08")).toBe(
      "/v1/activities?date=2026-03-08",
    );
    expect(() => todayDetailRouteParams("2026-02-30")).toThrow("real local date");
  });

  it("derives and shifts profile-local dates by calendar day across DST boundaries", () => {
    expect(
      todayDetailDate(undefined, "America/Chicago", new Date("2026-03-08T05:59:59.999Z")),
    ).toBe("2026-03-07");
    expect(
      todayDetailDate(undefined, "America/Chicago", new Date("2026-03-08T06:00:00.000Z")),
    ).toBe("2026-03-08");
    expect(
      todayDetailDate("2026-11-01", "America/Chicago", new Date("2026-03-08T06:00:00.000Z")),
    ).toBe("2026-11-01");

    expect(shiftLocalDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftLocalDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftLocalDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftLocalDate("2026-11-01", 1)).toBe("2026-11-02");
    expect(localDateInTimeZone(new Date("2026-11-01T06:30:00.000Z"), "America/Chicago")).toBe(
      "2026-11-01",
    );
    expect(localDateInTimeZone(new Date("2026-11-01T07:30:00.000Z"), "America/Chicago")).toBe(
      "2026-11-01",
    );
  });

  it("rejects every stale request-identity or generation boundary", () => {
    expect(todaySummaryRequestMatches(fence, identity, 4)).toBe(true);

    const staleIdentities: readonly TodaySummaryRequestIdentity[] = [
      { ...identity, kind: "activity" },
      { ...identity, ownerUserId: "20c34d49-975d-44fa-a60e-1a0913657b59" },
      { ...identity, sessionEpoch: 8 },
      { ...identity, profileRevision: "13" },
      { ...identity, profileTimeZone: "America/New_York" },
      { ...identity, localDate: "2026-03-09" },
      { ...identity, refreshKey: 4 },
    ];
    for (const stale of staleIdentities) {
      expect(todaySummaryRequestMatches(fence, stale, 4)).toBe(false);
    }
    expect(todaySummaryRequestMatches(fence, identity, 5)).toBe(false);
  });

  it("recognizes only the bounded activity owner-mismatch problem", () => {
    expect(isTodayActivityOwnerChangedProblem(409, { code: "ACTIVITY_OWNER_CHANGED" })).toBe(true);
    expect(isTodayActivityOwnerChangedProblem(401, { code: "ACTIVITY_OWNER_CHANGED" })).toBe(false);
    expect(isTodayActivityOwnerChangedProblem(409, { code: "CONFLICT" })).toBe(false);
    expect(isTodayActivityOwnerChangedProblem(409, null)).toBe(false);
  });

  it("ignores stale success and stale error settlements", () => {
    const initial = loadingTodaySupportingSummaries();
    const hydrationReady = hydrationTodaySummary({
      localDate: identity.localDate,
      timeZone: identity.profileTimeZone,
      entries: [{}],
      totalMilliliters: 375,
    });
    const staleSuccess = acceptTodaySupportingSummary(
      initial,
      fence,
      { ...identity, localDate: "2026-03-09" },
      5,
      { kind: "hydration", card: hydrationReady },
    );
    expect(staleSuccess).toBe(initial);

    const fresh = acceptTodaySupportingSummary(initial, fence, identity, 4, {
      kind: "hydration",
      card: hydrationReady,
    });
    const staleError = acceptTodaySupportingSummary(fresh, fence, identity, 5, {
      kind: "hydration",
      card: todaySummaryError("Old request failed."),
    });
    expect(staleError).toBe(fresh);
    expect(todaySummaryCardForRender(staleError.hydration, identity, 4)).toBe(hydrationReady);
  });

  it("hides a preloaded old-profile card synchronously while preserving the selected date", () => {
    const hydrationReady = hydrationTodaySummary({
      localDate: identity.localDate,
      timeZone: identity.profileTimeZone,
      entries: [{}],
      totalMilliliters: 500,
    });
    const installed = acceptTodaySupportingSummary(
      loadingTodaySupportingSummaries(),
      fence,
      identity,
      4,
      { kind: "hydration", card: hydrationReady },
    );

    expect(todaySummaryCardForRender(installed.hydration, identity, 4)).toBe(hydrationReady);

    const updatedProfile: TodaySummaryRequestIdentity = {
      ...identity,
      profileRevision: "13",
      profileTimeZone: "America/New_York",
    };
    expect(updatedProfile.localDate).toBe(identity.localDate);
    expect(todaySummaryCardForRender(installed.hydration, updatedProfile, 4)).toEqual({
      status: "loading",
      summary: null,
    });
    expect(
      todaySummaryCardForRender(installed.hydration, { ...identity, refreshKey: 4 }, 4),
    ).toEqual({ status: "loading", summary: null });
    expect(todaySummaryCardForRender(installed.hydration, identity, 5)).toEqual({
      status: "loading",
      summary: null,
    });
  });

  it("keeps one successful card when its sibling fails or retries", () => {
    const hydrationReady = hydrationTodaySummary({
      localDate: identity.localDate,
      timeZone: identity.profileTimeZone,
      entries: [{}, {}],
      totalMilliliters: 625,
    });
    let state = acceptTodaySupportingSummary(
      loadingTodaySupportingSummaries(),
      fence,
      identity,
      4,
      { kind: "hydration", card: hydrationReady },
    );
    const activityIdentity: TodaySummaryRequestIdentity = { ...identity, kind: "activity" };
    const activityFence: TodaySummaryRequestFence = {
      ...activityIdentity,
      generation: 2,
    };
    state = replaceTodaySupportingSummary(state, activityFence, {
      kind: "activity",
      card: todaySummaryError("Activity is temporarily unavailable."),
    });
    expect(todaySummaryCardForRender(state.hydration, identity, 4)).toBe(hydrationReady);
    expect(todaySummaryCardForRender(state.activity, activityIdentity, 2).status).toBe("error");

    const retryFence: TodaySummaryRequestFence = { ...activityIdentity, generation: 3 };
    const retrying = beginTodaySupportingSummaryLoad(state, retryFence);
    expect(todaySummaryCardForRender(retrying.hydration, identity, 4)).toBe(hydrationReady);
    expect(todaySummaryCardForRender(retrying.activity, activityIdentity, 3)).toEqual({
      status: "loading",
      summary: null,
    });

    const activityEmpty = activityTodaySummary({
      localDate: identity.localDate,
      timeZone: identity.profileTimeZone,
      entries: [],
      totalDurationMinutes: 0,
    });
    const settled = replaceTodaySupportingSummary(retrying, retryFence, {
      kind: "activity",
      card: activityEmpty,
    });
    const settledActivity = todaySummaryCardForRender(settled.activity, activityIdentity, 3);
    expect(settledActivity).toEqual({
      status: "empty",
      summary: {
        localDate: "2026-03-08",
        timeZone: "America/Chicago",
        entryCount: 0,
        totalDurationMinutes: 0,
      },
    });
    expect(settledActivity.summary).not.toHaveProperty("calories");
    expect(todaySummaryCardForRender(settled.hydration, identity, 4)).toBe(hydrationReady);
  });
});
