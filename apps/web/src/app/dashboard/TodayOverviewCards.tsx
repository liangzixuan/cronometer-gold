"use client";

import Link from "next/link";

import type { DailyOverviewCardState } from "../../lib/daily-overview";

interface TodayOverviewCardsProps {
  readonly date: string;
  readonly hydration: DailyOverviewCardState;
  readonly activity: DailyOverviewCardState;
  readonly onRetryHydration: () => void;
  readonly onRetryActivity: () => void;
}

function HydrationCardBody({
  state,
  onRetry,
}: {
  readonly state: DailyOverviewCardState;
  readonly onRetry: () => void;
}) {
  if (state.status === "loading") return <p>Loading plain-water entries…</p>;
  if (state.status === "error") {
    return (
      <div className="todayOverviewError">
        <p>{state.message}</p>
        <button
          aria-label="Retry plain-water summary"
          className="secondaryAction"
          onClick={onRetry}
          type="button"
        >
          Retry water
        </button>
      </div>
    );
  }
  return (
    <>
      <p className="todayOverviewMetric">
        <span aria-hidden="true">
          <strong>{state.total.toLocaleString("en-US")}</strong> mL
        </span>
        <span className="srOnly">{state.total.toLocaleString("en-US")} milliliters</span>
      </p>
      <p>
        {state.status === "empty"
          ? "0 entries recorded for this local day."
          : `${state.count} ${state.count === 1 ? "entry" : "entries"} recorded.`}
      </p>
    </>
  );
}

function ActivityCardBody({
  state,
  onRetry,
}: {
  readonly state: DailyOverviewCardState;
  readonly onRetry: () => void;
}) {
  if (state.status === "loading") return <p>Loading manual activities…</p>;
  if (state.status === "error") {
    return (
      <div className="todayOverviewError">
        <p>{state.message}</p>
        <button
          aria-label="Retry manual-activity summary"
          className="secondaryAction"
          onClick={onRetry}
          type="button"
        >
          Retry activity
        </button>
      </div>
    );
  }
  return (
    <>
      <p className="todayOverviewMetric">
        <span aria-hidden="true">
          <strong>{state.total.toLocaleString("en-US")}</strong> min
        </span>
        <span className="srOnly">{state.total.toLocaleString("en-US")} minutes</span>
      </p>
      <p>
        {state.status === "empty"
          ? "0 activities recorded for this local day."
          : `${state.count} ${state.count === 1 ? "activity" : "activities"} recorded.`}
      </p>
    </>
  );
}

export function TodayOverviewCards({
  date,
  hydration,
  activity,
  onRetryHydration,
  onRetryActivity,
}: TodayOverviewCardsProps) {
  const dateQuery = `?date=${encodeURIComponent(date)}`;
  return (
    <section aria-labelledby="today-overview-title" className="todayOverview">
      <div className="todayOverviewHeading">
        <p className="kicker">Selected local day</p>
        <h2 id="today-overview-title">Day at a glance</h2>
      </div>
      <div className="todayOverviewGrid">
        <article
          aria-busy={hydration.status === "loading"}
          aria-labelledby="today-hydration-title"
          className="todayOverviewCard"
          data-state={hydration.status}
        >
          <header>
            <h3 id="today-hydration-title">Plain water</h3>
            <Link aria-label={`Open hydration log for ${date}`} href={`/hydration${dateQuery}`}>
              Open hydration log
            </Link>
          </header>
          <div aria-live="polite" className="todayOverviewBody">
            <HydrationCardBody state={hydration} onRetry={onRetryHydration} />
          </div>
        </article>
        <article
          aria-busy={activity.status === "loading"}
          aria-labelledby="today-activity-title"
          className="todayOverviewCard"
          data-state={activity.status}
        >
          <header>
            <h3 id="today-activity-title">Manual activity</h3>
            <Link aria-label={`Open activity log for ${date}`} href={`/activities${dateQuery}`}>
              Open activity log
            </Link>
          </header>
          <div aria-live="polite" className="todayOverviewBody">
            <ActivityCardBody state={activity} onRetry={onRetryActivity} />
          </div>
        </article>
      </div>
    </section>
  );
}
