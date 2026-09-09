import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DailyOverviewCardState } from "../../lib/daily-overview";
import { TodayOverviewCards } from "./TodayOverviewCards";

const readyWater: DailyOverviewCardState = { status: "ready", count: 2, total: 625 };
const readyActivity: DailyOverviewCardState = { status: "ready", count: 1, total: 35 };

function renderCards(
  hydration: DailyOverviewCardState,
  activity: DailyOverviewCardState,
  date = "2026-08-15",
): string {
  return renderToStaticMarkup(
    <TodayOverviewCards
      activity={activity}
      date={date}
      hydration={hydration}
      onRetryActivity={() => undefined}
      onRetryHydration={() => undefined}
    />,
  );
}

describe("Today overview cards", () => {
  it("keeps a successful water card visible when only activity fails", () => {
    const markup = renderCards(readyWater, {
      status: "error",
      message: "The manual-activity summary could not be loaded.",
    });

    expect(markup).toContain("625</strong> mL");
    expect(markup).toContain("625 milliliters</span>");
    expect(markup).toContain("2 entries recorded.");
    expect(markup).toContain("The manual-activity summary could not be loaded.");
    expect(markup).toContain("Retry activity");
    expect(markup).not.toContain("Retry water");
  });

  it("keeps a successful activity card visible when only water fails", () => {
    const markup = renderCards(
      { status: "error", message: "The plain-water summary could not be loaded." },
      readyActivity,
    );

    expect(markup).toContain("Retry water");
    expect(markup).not.toContain("Retry activity");
    expect(markup).toContain("35</strong> min");
    expect(markup).toContain("35 minutes</span>");
    expect(markup).toContain("1 activity recorded.");
    expect(markup).not.toMatch(/calorie balance|remaining calories|earned calories|net calories/iu);
  });

  it("distinguishes loading and empty while preserving accessible same-date links", () => {
    const markup = renderCards({ status: "empty", count: 0, total: 0 }, { status: "loading" });

    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain("0</strong> mL");
    expect(markup).toContain("0 entries recorded for this local day.");
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain("Loading manual activities…");
    expect(markup).toContain('href="/hydration?date=2026-08-15"');
    expect(markup).toContain('aria-label="Open hydration log for 2026-08-15"');
    expect(markup).toContain('href="/activities?date=2026-08-15"');
    expect(markup).toContain('aria-label="Open activity log for 2026-08-15"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("preserves the exact selected Chicago fall-back date in both detail links", () => {
    const markup = renderCards(readyWater, readyActivity, "2026-11-01");

    expect(markup).toContain('href="/hydration?date=2026-11-01"');
    expect(markup).toContain('aria-label="Open hydration log for 2026-11-01"');
    expect(markup).toContain('href="/activities?date=2026-11-01"');
    expect(markup).toContain('aria-label="Open activity log for 2026-11-01"');
  });
});
