import { describe, expect, it } from "vitest";

import type { ActivityDay } from "./activity";
import {
  activityDailyOverviewCard,
  type DailyOverviewRequestIdentity,
  dailyOverviewCardForIdentity,
  dailyOverviewFence,
  dailyOverviewRequestMatches,
  dailyOverviewRequiresPrivateUiClosure,
  failedDailyOverviewCard,
  hydrationDailyOverviewCard,
  loadingDailyOverviewCard,
  scopedDailyOverviewCard,
} from "./daily-overview";
import { localDateInTimeZone } from "./diary";
import { HYDRATION_OWNER_CHANGED_CODE, type HydrationDay } from "./hydration";

const expected: DailyOverviewRequestIdentity = {
  ownerUserId: "5e041a5d-00e7-4260-832a-90e34a04e60a",
  profileRevision: "7",
  profileTimeZone: "America/Chicago",
  localDate: "2026-08-15",
  sessionGeneration: 3,
  requestGeneration: 11,
};

const revalidatedSession = {
  user: { id: expected.ownerUserId },
  profile: { revision: expected.profileRevision, timeZone: expected.profileTimeZone },
};

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => {
      resolve = complete;
    }),
    resolve,
  };
}

describe("daily overview summaries", () => {
  it("keeps plain-water total/count and manual-activity duration/count independent", () => {
    const hydration = hydrationDailyOverviewCard({
      localDate: expected.localDate,
      timeZone: expected.profileTimeZone,
      revision: "2",
      entries: [
        {
          id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
          revision: "2",
          amountMilliliters: 375,
          occurredAt: "2026-08-15T13:05:01.250Z",
          localDate: expected.localDate,
          localTime: "08:05:01.250",
          timeZone: expected.profileTimeZone,
          createdAt: "2026-08-15T13:05:02.000Z",
        },
      ],
      totalMilliliters: 375,
      updatedAt: "2026-08-15T13:05:02.000Z",
    } satisfies HydrationDay);
    const activity = activityDailyOverviewCard({
      localDate: expected.localDate,
      timeZone: expected.profileTimeZone,
      revision: "4",
      entries: [
        {
          id: "4bcfa2bf-4950-43f7-9f24-b983ac803012",
          revision: "4",
          name: "Trail run",
          durationMinutes: 35,
          selfReportedEnergyKilocalories: "248.5",
          occurredAt: "2026-08-15T13:05:01.000Z",
          localDate: expected.localDate,
          localTime: "08:05:01",
          timeZone: expected.profileTimeZone,
          createdAt: "2026-08-15T13:05:02.000Z",
        },
      ],
      totalDurationMinutes: 35,
      updatedAt: "2026-08-15T13:05:02.000Z",
    } satisfies ActivityDay);

    expect(hydration).toEqual({ status: "ready", count: 1, total: 375 });
    expect(activity).toEqual({ status: "ready", count: 1, total: 35 });
    expect(activity).not.toHaveProperty("calories");
    expect(JSON.stringify(activity)).not.toMatch(/energy|calorie|remaining|earned|net/iu);
  });

  it("represents empty, loading, and failed cards as distinct states", () => {
    expect(
      hydrationDailyOverviewCard({
        localDate: expected.localDate,
        timeZone: expected.profileTimeZone,
        revision: "0",
        entries: [],
        totalMilliliters: 0,
        updatedAt: null,
      }),
    ).toEqual({ status: "empty", count: 0, total: 0 });
    expect(loadingDailyOverviewCard()).toEqual({ status: "loading" });
    expect(failedDailyOverviewCard("Water unavailable.")).toEqual({
      status: "error",
      message: "Water unavailable.",
    });
  });

  it("synchronously hides a loaded card when its profile or request identity is no longer current", () => {
    const loaded = scopedDailyOverviewCard(expected, {
      status: "ready",
      count: 2,
      total: 625,
    });
    expect(dailyOverviewCardForIdentity(loaded, expected)).toEqual(loaded.card);
    expect(
      dailyOverviewCardForIdentity(loaded, { ...expected, profileTimeZone: "America/New_York" }),
    ).toEqual({ status: "loading" });
    expect(dailyOverviewCardForIdentity(loaded, { ...expected, profileRevision: "8" })).toEqual({
      status: "loading",
    });
    expect(dailyOverviewCardForIdentity(loaded, { ...expected, requestGeneration: 12 })).toEqual({
      status: "loading",
    });
  });
});

describe("daily overview private response fence", () => {
  it("retains the profile-local day across both folds of Chicago daylight-saving fall-back", () => {
    const timeZone = "America/Chicago";
    const localDate = "2026-11-01";
    expect(localDateInTimeZone(new Date("2026-11-01T06:30:00.000Z"), timeZone)).toBe(localDate);
    expect(localDateInTimeZone(new Date("2026-11-01T07:30:00.000Z"), timeZone)).toBe(localDate);

    const fallBackRequest = { ...expected, localDate, profileTimeZone: timeZone };
    expect(
      dailyOverviewFence({
        expected: fallBackRequest,
        current: fallBackRequest,
        revalidatedSession: {
          user: { id: fallBackRequest.ownerUserId },
          profile: { revision: fallBackRequest.profileRevision, timeZone },
        },
        response: { localDate, timeZone },
      }),
    ).toBe("current");
  });

  it("accepts only an exact owner/profile/zone/date/session/request identity", () => {
    expect(dailyOverviewRequestMatches(expected, { ...expected })).toBe(true);
    expect(dailyOverviewRequestMatches(expected, { ...expected, ownerUserId: "owner-b" })).toBe(
      false,
    );
    expect(dailyOverviewRequestMatches(expected, { ...expected, profileRevision: "8" })).toBe(
      false,
    );
    expect(
      dailyOverviewRequestMatches(expected, {
        ...expected,
        profileTimeZone: "America/New_York",
      }),
    ).toBe(false);
    expect(dailyOverviewRequestMatches(expected, { ...expected, localDate: "2026-08-16" })).toBe(
      false,
    );
    expect(dailyOverviewRequestMatches(expected, { ...expected, sessionGeneration: 4 })).toBe(
      false,
    );
    expect(dailyOverviewRequestMatches(expected, { ...expected, requestGeneration: 12 })).toBe(
      false,
    );
  });

  it("drops a delayed response after the selected date and request generation advance", async () => {
    const delayed = deferred<{
      readonly response: { readonly localDate: string; readonly timeZone: string };
    }>();
    let current: DailyOverviewRequestIdentity = expected;
    const result = delayed.promise.then((loaded) =>
      dailyOverviewFence({
        expected,
        current,
        revalidatedSession,
        response: loaded.response,
      }),
    );

    current = { ...expected, localDate: "2026-08-16", requestGeneration: 12 };
    delayed.resolve({
      response: { localDate: expected.localDate, timeZone: expected.profileTimeZone },
    });

    await expect(result).resolves.toBe("stale");
  });

  it("fails closed on owner, profile, timezone, and response-coordinate changes", () => {
    const response = { localDate: expected.localDate, timeZone: expected.profileTimeZone };
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession: { ...revalidatedSession, user: { id: "owner-b" } },
        response,
      }),
    ).toBe("owner-changed");
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession: {
          ...revalidatedSession,
          profile: { ...revalidatedSession.profile, revision: "8" },
        },
        response,
      }),
    ).toBe("profile-changed");
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession: {
          ...revalidatedSession,
          profile: { ...revalidatedSession.profile, timeZone: "America/New_York" },
        },
        response,
      }),
    ).toBe("profile-changed");
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession,
        response: { ...response, localDate: "2026-08-16" },
      }),
    ).toBe("response-mismatch");
    expect(
      dailyOverviewFence({
        expected,
        current: expected,
        revalidatedSession,
        response: { ...response, timeZone: "America/New_York" },
      }),
    ).toBe("response-mismatch");
  });

  it("closes private UI on either endpoint's 401 and the activity owner conflict only", () => {
    expect(dailyOverviewRequiresPrivateUiClosure("hydration", 401, null)).toBe(true);
    expect(dailyOverviewRequiresPrivateUiClosure("activity", 401, null)).toBe(true);
    expect(
      dailyOverviewRequiresPrivateUiClosure("hydration", 409, HYDRATION_OWNER_CHANGED_CODE),
    ).toBe(true);
    expect(dailyOverviewRequiresPrivateUiClosure("activity", 409, "ACTIVITY_OWNER_CHANGED")).toBe(
      true,
    );
    expect(dailyOverviewRequiresPrivateUiClosure("hydration", 409, "ACTIVITY_OWNER_CHANGED")).toBe(
      false,
    );
    expect(dailyOverviewRequiresPrivateUiClosure("activity", 500, null)).toBe(false);
  });
});
